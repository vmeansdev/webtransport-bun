mod g6_protocol;
#[allow(dead_code)]
mod latency_probe;

use g6_protocol::{
    encode_reflected_ack, encode_snapshot_datagram, observe_tick, read_stamp, G6ServerCorePlan,
    CLASS_ACTION, CLASS_MOVE, CLASS_RAID, CLASS_RAID_JOIN, CLASS_SNAPSHOT,
};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::time::MissedTickBehavior;
use wtransport::config::QuicTransportConfig;
use wtransport::quinn::VarInt;
use wtransport::{Connection, Endpoint, Identity, ServerConfig};

const DEFAULT_PORT: u16 = 4433;
const DEFAULT_DURATION_SECS: u64 = 120;
const DEFAULT_IDLE_SECS: u64 = 30;
const DEFAULT_DRAIN_MS: u64 = 1_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LimitSettings {
    max_sessions: usize,
    max_handshakes_in_flight: usize,
    max_streams_per_session_bidi: u64,
    max_streams_per_session_uni: u64,
    max_streams_global: u64,
    max_datagram_size: usize,
    max_queued_bytes_per_session: usize,
    max_queued_bytes_per_stream: usize,
    idle_timeout_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RateLimitSettings {
    handshakes_per_sec: u64,
    handshakes_burst: u64,
    handshakes_burst_per_prefix: u64,
    streams_per_sec: u64,
    streams_burst: u64,
    datagrams_per_sec: u64,
    datagrams_burst: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ServerSettings {
    limits: LimitSettings,
    rate_limits: RateLimitSettings,
}

impl ServerSettings {
    fn for_sessions(sessions: usize) -> Self {
        let top_sessions = usize::max(64, sessions + 8);
        Self {
            limits: LimitSettings {
                max_sessions: top_sessions * 2,
                max_handshakes_in_flight: top_sessions * 2,
                max_streams_per_session_bidi: 200,
                max_streams_per_session_uni: 200,
                max_streams_global: 50_000,
                max_datagram_size: 1_214,
                max_queued_bytes_per_session: 2 * 1024 * 1024,
                max_queued_bytes_per_stream: 256 * 1024,
                idle_timeout_ms: 300_000,
            },
            rate_limits: RateLimitSettings {
                handshakes_per_sec: (top_sessions * 2) as u64,
                handshakes_burst: (top_sessions * 2) as u64,
                handshakes_burst_per_prefix: (top_sessions * 2) as u64,
                streams_per_sec: 1_000,
                streams_burst: 2_000,
                datagrams_per_sec: u64::max((sessions as u64) * 64, 200_000),
                datagrams_burst: u64::max((sessions as u64) * 128, 400_000),
            },
        }
    }
}

#[derive(Clone, Debug)]
struct TokenBucket {
    rate_per_sec: u64,
    burst: u64,
    tokens: f64,
    last_ms: Option<u64>,
}

impl TokenBucket {
    fn new(rate_per_sec: u64, burst: u64) -> Self {
        Self {
            rate_per_sec,
            burst,
            tokens: burst as f64,
            last_ms: None,
        }
    }

    fn allow_at(&mut self, now_ms: u64) -> bool {
        if self.burst == 0 {
            return false;
        }
        if let Some(last_ms) = self.last_ms {
            let elapsed_ms = now_ms.saturating_sub(last_ms);
            self.tokens = f64::min(
                self.burst as f64,
                self.tokens + elapsed_ms as f64 * (self.rate_per_sec as f64 / 1000.0),
            );
        } else {
            self.tokens = self.burst as f64;
        }
        self.last_ms = Some(now_ms);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SessionKind {
    Player,
    Publisher,
    Raid,
}

#[derive(Default, Clone, Copy, Debug, Eq, PartialEq)]
struct EmitterCounters {
    snapshot_due: u64,
    snapshot_issued: u64,
    ack_due: u64,
    ack_issued: u64,
    raid_forwarded: u64,
    send_errors: u64,
}

#[derive(Default, Clone, Debug, Eq, PartialEq)]
struct ServerCounters {
    rx_total: u64,
    rx_unstamped: u64,
    rx_move: u64,
    rx_action: u64,
    rx_snapshot: u64,
    rx_raid: u64,
    rx_raid_join: u64,
    rate_limited_count: u64,
    limit_exceeded_count: u64,
    emitter: EmitterCounters,
}

#[derive(Default, Clone, Copy, Debug, Eq, PartialEq)]
struct RawConnectionStats {
    datagram_frames_sent: u64,
    datagram_frames_received: u64,
    udp_datagrams_sent: u64,
    udp_datagrams_received: u64,
}

#[derive(Clone)]
struct SessionHandle {
    connection: Connection,
    kind: Arc<Mutex<SessionKind>>,
    alive: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
enum PrefixKey {
    V4(u32),
    V6(u64),
}

struct SharedState {
    counters: Mutex<ServerCounters>,
    connections: Mutex<Vec<SessionHandle>>,
    measurements: Mutex<MeasurementState>,
    settings: ServerSettings,
    handshakes_in_flight: Mutex<usize>,
    handshake_bucket: Mutex<TokenBucket>,
    handshake_prefix_buckets: Mutex<HashMap<PrefixKey, TokenBucket>>,
    sessions_in_use: Mutex<usize>,
    datagram_bucket: Mutex<TokenBucket>,
    stream_bucket: Mutex<TokenBucket>,
    streams_in_use: Mutex<u64>,
}

impl SharedState {
    fn new(settings: ServerSettings) -> Self {
        Self {
            counters: Mutex::new(ServerCounters::default()),
            connections: Mutex::new(Vec::new()),
            measurements: Mutex::new(MeasurementState::default()),
            settings,
            handshakes_in_flight: Mutex::new(0),
            handshake_bucket: Mutex::new(TokenBucket::new(
                settings.rate_limits.handshakes_per_sec,
                settings.rate_limits.handshakes_burst,
            )),
            handshake_prefix_buckets: Mutex::new(HashMap::new()),
            sessions_in_use: Mutex::new(0),
            datagram_bucket: Mutex::new(TokenBucket::new(
                settings.rate_limits.datagrams_per_sec,
                settings.rate_limits.datagrams_burst,
            )),
            stream_bucket: Mutex::new(TokenBucket::new(
                settings.rate_limits.streams_per_sec,
                settings.rate_limits.streams_burst,
            )),
            streams_in_use: Mutex::new(0),
        }
    }
}

#[derive(Default, Clone, Copy, Debug)]
struct MeasurementSnapshot {
    cpu_ms: Option<f64>,
    rss_mb: Option<f64>,
    raw: RawConnectionStats,
}

#[derive(Default, Clone, Debug)]
struct MeasurementState {
    steady_start: Option<MeasurementSnapshot>,
    drain_start: Option<MeasurementSnapshot>,
    synchronized: bool,
    rss_max_mb: Option<f64>,
}

#[derive(Clone, Debug)]
struct Options {
    port: u16,
    sessions: usize,
    cert_pem: PathBuf,
    key_pem: PathBuf,
    duration_secs: u64,
    idle_secs: u64,
    drain_ms: u64,
    server_settings: ServerSettings,
    phase_path: Option<PathBuf>,
    summary_json: Option<PathBuf>,
    ready_path: Option<PathBuf>,
}

impl Options {
    fn parse() -> Result<Self, String> {
        Self::parse_from(std::env::args().skip(1))
    }

    fn parse_from<I>(args: I) -> Result<Self, String>
    where
        I: IntoIterator<Item = String>,
    {
        let mut args = args.into_iter();
        let mut port = DEFAULT_PORT;
        let mut sessions = None;
        let mut cert_pem = None;
        let mut key_pem = None;
        let mut duration_secs = DEFAULT_DURATION_SECS;
        let mut idle_secs = DEFAULT_IDLE_SECS;
        let mut drain_ms = DEFAULT_DRAIN_MS;
        let mut phase_path = None;
        let mut summary_json = None;
        let mut ready_path = None;
        let mut max_sessions = None;
        let mut max_handshakes_in_flight = None;
        let mut max_streams_per_session_bidi = None;
        let mut max_streams_per_session_uni = None;
        let mut max_streams_global = None;
        let mut max_datagram_size = None;
        let mut max_queued_bytes_per_session = None;
        let mut max_queued_bytes_per_stream = None;
        let mut idle_timeout_ms = None;
        let mut handshakes_per_sec = None;
        let mut handshakes_burst = None;
        let mut handshakes_burst_per_prefix = None;
        let mut streams_per_sec = None;
        let mut streams_burst = None;
        let mut datagrams_per_sec = None;
        let mut datagrams_burst = None;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--port" => {
                    port = parse_arg::<u16>(&mut args, "--port")?;
                }
                "--sessions" => {
                    sessions = Some(parse_arg::<usize>(&mut args, "--sessions")?);
                }
                "--cert-pem" => {
                    cert_pem = Some(PathBuf::from(parse_string_arg(&mut args, "--cert-pem")?));
                }
                "--key-pem" => {
                    key_pem = Some(PathBuf::from(parse_string_arg(&mut args, "--key-pem")?));
                }
                "--duration-secs" => {
                    duration_secs = parse_arg::<u64>(&mut args, "--duration-secs")?;
                }
                "--idle-secs" => {
                    idle_secs = parse_arg::<u64>(&mut args, "--idle-secs")?;
                }
                "--drain-ms" => {
                    drain_ms = parse_arg::<u64>(&mut args, "--drain-ms")?;
                }
                "--max-sessions" => {
                    max_sessions = Some(parse_arg::<usize>(&mut args, "--max-sessions")?);
                }
                "--max-handshakes-in-flight" => {
                    max_handshakes_in_flight =
                        Some(parse_arg::<usize>(&mut args, "--max-handshakes-in-flight")?);
                }
                "--max-streams-per-session-bidi" => {
                    max_streams_per_session_bidi = Some(parse_arg::<u64>(
                        &mut args,
                        "--max-streams-per-session-bidi",
                    )?);
                }
                "--max-streams-per-session-uni" => {
                    max_streams_per_session_uni = Some(parse_arg::<u64>(
                        &mut args,
                        "--max-streams-per-session-uni",
                    )?);
                }
                "--max-streams-global" => {
                    max_streams_global = Some(parse_arg::<u64>(&mut args, "--max-streams-global")?);
                }
                "--max-datagram-size" => {
                    max_datagram_size = Some(parse_arg::<usize>(&mut args, "--max-datagram-size")?);
                }
                "--max-queued-bytes-per-session" => {
                    max_queued_bytes_per_session = Some(parse_arg::<usize>(
                        &mut args,
                        "--max-queued-bytes-per-session",
                    )?);
                }
                "--max-queued-bytes-per-stream" => {
                    max_queued_bytes_per_stream = Some(parse_arg::<usize>(
                        &mut args,
                        "--max-queued-bytes-per-stream",
                    )?);
                }
                "--idle-timeout-ms" => {
                    idle_timeout_ms = Some(parse_arg::<u64>(&mut args, "--idle-timeout-ms")?);
                }
                "--handshakes-per-sec" => {
                    handshakes_per_sec = Some(parse_arg::<u64>(&mut args, "--handshakes-per-sec")?);
                }
                "--handshakes-burst" => {
                    handshakes_burst = Some(parse_arg::<u64>(&mut args, "--handshakes-burst")?);
                }
                "--handshakes-burst-per-prefix" => {
                    handshakes_burst_per_prefix = Some(parse_arg::<u64>(
                        &mut args,
                        "--handshakes-burst-per-prefix",
                    )?);
                }
                "--streams-per-sec" => {
                    streams_per_sec = Some(parse_arg::<u64>(&mut args, "--streams-per-sec")?);
                }
                "--streams-burst" => {
                    streams_burst = Some(parse_arg::<u64>(&mut args, "--streams-burst")?);
                }
                "--datagrams-per-sec" => {
                    datagrams_per_sec = Some(parse_arg::<u64>(&mut args, "--datagrams-per-sec")?);
                }
                "--datagrams-burst" => {
                    datagrams_burst = Some(parse_arg::<u64>(&mut args, "--datagrams-burst")?);
                }
                "--phase-path" => {
                    phase_path = Some(PathBuf::from(parse_string_arg(&mut args, "--phase-path")?));
                }
                "--summary-json" => {
                    summary_json = Some(PathBuf::from(parse_string_arg(
                        &mut args,
                        "--summary-json",
                    )?));
                }
                "--ready-path" => {
                    ready_path = Some(PathBuf::from(parse_string_arg(&mut args, "--ready-path")?));
                }
                _ => {}
            }
        }
        let sessions = sessions.ok_or("g6-server: --sessions is required")?;
        let defaults = ServerSettings::for_sessions(sessions);
        Ok(Self {
            port,
            sessions,
            cert_pem: cert_pem.ok_or("g6-server: --cert-pem is required")?,
            key_pem: key_pem.ok_or("g6-server: --key-pem is required")?,
            duration_secs,
            idle_secs,
            drain_ms,
            server_settings: ServerSettings {
                limits: LimitSettings {
                    max_sessions: max_sessions.unwrap_or(defaults.limits.max_sessions),
                    max_handshakes_in_flight: max_handshakes_in_flight
                        .unwrap_or(defaults.limits.max_handshakes_in_flight),
                    max_streams_per_session_bidi: max_streams_per_session_bidi
                        .unwrap_or(defaults.limits.max_streams_per_session_bidi),
                    max_streams_per_session_uni: max_streams_per_session_uni
                        .unwrap_or(defaults.limits.max_streams_per_session_uni),
                    max_streams_global: max_streams_global
                        .unwrap_or(defaults.limits.max_streams_global),
                    max_datagram_size: max_datagram_size
                        .unwrap_or(defaults.limits.max_datagram_size),
                    max_queued_bytes_per_session: max_queued_bytes_per_session
                        .unwrap_or(defaults.limits.max_queued_bytes_per_session),
                    max_queued_bytes_per_stream: max_queued_bytes_per_stream
                        .unwrap_or(defaults.limits.max_queued_bytes_per_stream),
                    idle_timeout_ms: idle_timeout_ms.unwrap_or(defaults.limits.idle_timeout_ms),
                },
                rate_limits: RateLimitSettings {
                    handshakes_per_sec: handshakes_per_sec
                        .unwrap_or(defaults.rate_limits.handshakes_per_sec),
                    handshakes_burst: handshakes_burst
                        .unwrap_or(defaults.rate_limits.handshakes_burst),
                    handshakes_burst_per_prefix: handshakes_burst_per_prefix
                        .unwrap_or(defaults.rate_limits.handshakes_burst_per_prefix),
                    streams_per_sec: streams_per_sec
                        .unwrap_or(defaults.rate_limits.streams_per_sec),
                    streams_burst: streams_burst.unwrap_or(defaults.rate_limits.streams_burst),
                    datagrams_per_sec: datagrams_per_sec
                        .unwrap_or(defaults.rate_limits.datagrams_per_sec),
                    datagrams_burst: datagrams_burst
                        .unwrap_or(defaults.rate_limits.datagrams_burst),
                },
            },
            phase_path,
            summary_json,
            ready_path,
        })
    }
}

fn ready_marker_temp_path(path: &Path) -> PathBuf {
    let mut temp = path.as_os_str().to_os_string();
    temp.push(format!(".tmp.{}", std::process::id()));
    PathBuf::from(temp)
}

fn remove_file_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn clear_ready_marker(path: &Path) -> std::io::Result<()> {
    remove_file_if_present(path)?;
    remove_file_if_present(&ready_marker_temp_path(path))
}

fn publish_ready_marker(path: &Path, port: u16) -> std::io::Result<()> {
    let temp = ready_marker_temp_path(path);
    remove_file_if_present(&temp)?;
    std::fs::write(
        &temp,
        format!("{{\"schema\":\"g6-rust-server-ready/1\",\"port\":{port}}}\n"),
    )?;
    std::fs::rename(temp, path)
}

fn parse_string_arg(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("g6-server: {flag} requires a value"))
}

fn parse_arg<T>(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<T, String>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    parse_string_arg(args, flag)?
        .parse()
        .map_err(|e| format!("g6-server: invalid {flag}: {e}"))
}

fn planned_sessions_in_slice(
    planned_sessions: usize,
    slices_per_tick: usize,
    slice_index: usize,
) -> usize {
    let safe_slices = usize::max(1, slices_per_tick);
    let per_slice = planned_sessions.div_ceil(safe_slices);
    let slot = slice_index % safe_slices;
    let from = slot * per_slice;
    let to = usize::min(from + per_slice, planned_sessions);
    to.saturating_sub(from)
}

fn planned_snapshot_due_for_slice(
    planned_sessions: usize,
    plan: &G6ServerCorePlan,
    slice_index: usize,
) -> u64 {
    (planned_sessions_in_slice(planned_sessions, plan.slices_per_tick, slice_index)
        * plan.snapshot_datagrams) as u64
}

fn book_snapshot_due_until(
    counters: &mut ServerCounters,
    planned_sessions: usize,
    plan: &G6ServerCorePlan,
    booked_slices: &mut usize,
    target_slices: usize,
) {
    while *booked_slices < target_slices {
        counters.emitter.snapshot_due +=
            planned_snapshot_due_for_slice(planned_sessions, plan, *booked_slices);
        *booked_slices += 1;
    }
}

fn escape_json(raw: &str) -> String {
    raw.chars()
        .flat_map(|ch| match ch {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            '\n' | '\r' | '\t' => vec![' '],
            c if (c as u32) < 0x20 => vec![' '],
            c => vec![c],
        })
        .collect()
}

fn rusage_self() -> Option<libc::rusage> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    Some(unsafe { usage.assume_init() })
}

fn self_cpu_ms() -> Option<f64> {
    let usage = rusage_self()?;
    let user_ms = usage.ru_utime.tv_sec as f64 * 1000.0 + usage.ru_utime.tv_usec as f64 / 1000.0;
    let system_ms = usage.ru_stime.tv_sec as f64 * 1000.0 + usage.ru_stime.tv_usec as f64 / 1000.0;
    Some(user_ms + system_ms)
}

fn self_rss_mb() -> Option<f64> {
    let usage = rusage_self()?;
    let raw = usage.ru_maxrss as f64;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        Some(raw / 1024.0 / 1024.0)
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        Some(raw / 1024.0)
    }
}

fn phase_from_file(path: Option<&PathBuf>) -> String {
    let Some(path) = path else {
        return "steady".to_string();
    };
    std::fs::read_to_string(path)
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "connect".to_string())
}

fn note_class(counters: &mut ServerCounters, class: u8) -> bool {
    match class {
        CLASS_MOVE => counters.rx_move += 1,
        CLASS_ACTION => counters.rx_action += 1,
        CLASS_SNAPSHOT => counters.rx_snapshot += 1,
        CLASS_RAID => counters.rx_raid += 1,
        CLASS_RAID_JOIN => counters.rx_raid_join += 1,
        _ => return false,
    }
    true
}

fn record_action_ack(counters: &mut ServerCounters, sent_ok: bool) {
    counters.emitter.ack_due += 1;
    if sent_ok {
        counters.emitter.ack_issued += 1;
    } else {
        counters.emitter.send_errors += 1;
    }
}

fn monotonic_ms() -> u64 {
    latency_probe::monotonic_ns() / 1_000_000
}

fn prefix_key_for(address: SocketAddr) -> PrefixKey {
    match address.ip() {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            PrefixKey::V4(u32::from_be_bytes([octets[0], octets[1], octets[2], 0]))
        }
        std::net::IpAddr::V6(ip) => {
            let octets = ip.octets();
            PrefixKey::V6(u64::from_be_bytes([
                octets[0], octets[1], octets[2], octets[3], octets[4], octets[5], octets[6],
                octets[7],
            ]))
        }
    }
}

fn admit_handshake(shared: &SharedState, now_ms: u64, remote_address: SocketAddr) -> bool {
    let mut bucket = shared
        .handshake_bucket
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !bucket.allow_at(now_ms) {
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.rate_limited_count += 1;
        return false;
    }
    drop(bucket);
    let prefix_key = prefix_key_for(remote_address);
    let mut prefix_buckets = shared
        .handshake_prefix_buckets
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let prefix_bucket = prefix_buckets.entry(prefix_key).or_insert_with(|| {
        TokenBucket::new(
            shared.settings.rate_limits.handshakes_per_sec,
            shared.settings.rate_limits.handshakes_burst_per_prefix,
        )
    });
    if !prefix_bucket.allow_at(now_ms) {
        drop(prefix_buckets);
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.rate_limited_count += 1;
        return false;
    }
    drop(prefix_buckets);
    let mut handshakes = shared
        .handshakes_in_flight
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *handshakes >= shared.settings.limits.max_handshakes_in_flight {
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.limit_exceeded_count += 1;
        return false;
    }
    *handshakes += 1;
    true
}

fn release_handshake(shared: &SharedState) {
    let mut handshakes = shared
        .handshakes_in_flight
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *handshakes = handshakes.saturating_sub(1);
}

fn admit_session_slot(shared: &SharedState) -> bool {
    let mut sessions = shared
        .sessions_in_use
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *sessions >= shared.settings.limits.max_sessions {
        drop(sessions);
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.limit_exceeded_count += 1;
        return false;
    }
    *sessions += 1;
    true
}

fn release_session_slot(shared: &SharedState) {
    let mut sessions = shared
        .sessions_in_use
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *sessions = sessions.saturating_sub(1);
}

fn datagram_allowed(shared: &SharedState, len: usize, now_ms: u64) -> bool {
    if len > shared.settings.limits.max_datagram_size {
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.limit_exceeded_count += 1;
        return false;
    }
    let mut bucket = shared
        .datagram_bucket
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !bucket.allow_at(now_ms) {
        drop(bucket);
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.rate_limited_count += 1;
        return false;
    }
    true
}

fn admit_stream(shared: &SharedState, now_ms: u64) -> bool {
    let streams = shared
        .streams_in_use
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *streams >= shared.settings.limits.max_streams_global {
        drop(streams);
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.limit_exceeded_count += 1;
        return false;
    }
    drop(streams);
    let mut bucket = shared
        .stream_bucket
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !bucket.allow_at(now_ms) {
        drop(bucket);
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.rate_limited_count += 1;
        return false;
    }
    drop(bucket);
    let mut streams = shared
        .streams_in_use
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if *streams >= shared.settings.limits.max_streams_global {
        drop(streams);
        let mut counters = shared
            .counters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        counters.limit_exceeded_count += 1;
        return false;
    }
    *streams += 1;
    true
}

fn release_stream(shared: &SharedState) {
    let mut streams = shared
        .streams_in_use
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *streams = streams.saturating_sub(1);
}

fn apply_transport_settings(
    settings: ServerSettings,
) -> Result<QuicTransportConfig, Box<dyn std::error::Error>> {
    let mut transport = QuicTransportConfig::default();
    transport.max_concurrent_bidi_streams(VarInt::from_u32(u32::try_from(
        settings.limits.max_streams_per_session_bidi,
    )?));
    transport.max_concurrent_uni_streams(VarInt::from_u32(u32::try_from(
        settings.limits.max_streams_per_session_uni,
    )?));
    transport.stream_receive_window(VarInt::from_u32(u32::try_from(
        settings.limits.max_queued_bytes_per_stream,
    )?));
    transport.receive_window(VarInt::from_u32(u32::try_from(
        settings.limits.max_queued_bytes_per_session,
    )?));
    transport.send_window(settings.limits.max_queued_bytes_per_session as u64);
    transport.datagram_receive_buffer_size(Some(settings.limits.max_queued_bytes_per_session));
    transport.datagram_send_buffer_size(settings.limits.max_queued_bytes_per_session);
    transport.initial_mtu(u16::try_from(settings.limits.max_datagram_size)?);
    transport.min_mtu(u16::try_from(settings.limits.max_datagram_size)?);
    Ok(transport)
}

fn aggregate_connection_stats(connections: &[SessionHandle]) -> RawConnectionStats {
    let mut totals = RawConnectionStats::default();
    for handle in connections {
        let stats = handle.connection.quic_connection().stats();
        totals.datagram_frames_sent += stats.frame_tx.datagram;
        totals.datagram_frames_received += stats.frame_rx.datagram;
        totals.udp_datagrams_sent += stats.udp_tx.datagrams;
        totals.udp_datagrams_received += stats.udp_rx.datagrams;
    }
    totals
}

fn capture_measurement_snapshot(connections: &[SessionHandle]) -> MeasurementSnapshot {
    MeasurementSnapshot {
        cpu_ms: self_cpu_ms(),
        rss_mb: self_rss_mb(),
        raw: aggregate_connection_stats(connections),
    }
}

fn build_summary_json(
    options: &Options,
    plan: &G6ServerCorePlan,
    counters: &ServerCounters,
    raw_stats: RawConnectionStats,
    measurements: &MeasurementState,
    phase: &str,
) -> String {
    format!(
		concat!(
			"{{",
			"\"schema\":\"g6-rust-server/1\",",
			"\"phase\":\"{}\",",
			"\"plan\":{{\"snapshotPayloadBytes\":{},\"snapshotDatagrams\":{},\"snapshotHz\":{},\"emitterSliceHz\":{},\"sliceMs\":{},\"slicesPerTick\":{}}},",
			"\"config\":{{",
			"\"port\":{},\"durationSec\":{},\"idleSec\":{},\"drainMs\":{},",
			"\"limits\":{{\"maxSessions\":{},\"maxHandshakesInFlight\":{},\"maxStreamsPerSessionBidi\":{},\"maxStreamsPerSessionUni\":{},\"maxStreamsGlobal\":{},\"maxDatagramSize\":{},\"maxQueuedBytesPerSession\":{},\"maxQueuedBytesPerStream\":{},\"idleTimeoutMs\":{}}},",
			"\"rateLimits\":{{\"handshakesPerSec\":{},\"handshakesBurst\":{},\"handshakesBurstPerPrefix\":{},\"streamsPerSec\":{},\"streamsBurst\":{},\"datagramsPerSec\":{},\"datagramsBurst\":{}}}",
			"}},",
			"\"measurements\":{{",
			"\"window\":{{\"kind\":\"steady\",\"startPhase\":\"steady\",\"endPhase\":\"drain\",\"wallMs\":{},\"synchronized\":{}}},",
			"\"serverProcessCpu\":{{\"unit\":\"cpu-ms\",\"value\":{}}},",
			"\"serverRss\":{{\"unit\":\"rss-mib\",\"value\":{}}},",
			"\"rawStages\":{{\"datagramFrameUnit\":\"quic-datagram-frames\",\"udpDatagramUnit\":\"udp-datagrams\",\"datagramFramesSent\":{},\"datagramFramesReceived\":{},\"udpDatagramsSent\":{},\"udpDatagramsReceived\":{},\"capturedBeforeTeardown\":{}}}",
			"}},",
			"\"server\":{{",
			"\"rxTotal\":{},\"rxUnstamped\":{},",
			"\"rateLimitedCount\":{},\"limitExceededCount\":{},",
			"\"rxByClass\":{{\"move\":{},\"action\":{},\"snapshot\":{},\"raid\":{},\"raidJoin\":{}}},",
			"\"emitter\":{{\"snapshotDue\":{},\"snapshotIssued\":{},\"ackDue\":{},\"ackIssued\":{},\"raidForwarded\":{},\"sendErrors\":{}}},",
			"\"rawConnectionStats\":{{\"datagramFramesSent\":{},\"datagramFramesReceived\":{},\"udpDatagramsSent\":{},\"udpDatagramsReceived\":{}}}",
			"}}",
			"}}"
		),
		escape_json(phase),
		plan.snapshot_payload_bytes,
		plan.snapshot_datagrams,
		plan.snapshot_hz,
		plan.emitter_slice_hz,
		plan.slice_ms,
		plan.slices_per_tick,
		options.port,
		options.duration_secs,
		options.idle_secs,
		options.drain_ms,
		options.server_settings.limits.max_sessions,
		options.server_settings.limits.max_handshakes_in_flight,
		options.server_settings.limits.max_streams_per_session_bidi,
		options.server_settings.limits.max_streams_per_session_uni,
		options.server_settings.limits.max_streams_global,
		options.server_settings.limits.max_datagram_size,
		options.server_settings.limits.max_queued_bytes_per_session,
		options.server_settings.limits.max_queued_bytes_per_stream,
		options.server_settings.limits.idle_timeout_ms,
		options.server_settings.rate_limits.handshakes_per_sec,
		options.server_settings.rate_limits.handshakes_burst,
		options.server_settings.rate_limits.handshakes_burst_per_prefix,
		options.server_settings.rate_limits.streams_per_sec,
		options.server_settings.rate_limits.streams_burst,
		options.server_settings.rate_limits.datagrams_per_sec,
		options.server_settings.rate_limits.datagrams_burst,
		options.duration_secs * 1000,
		measurements.synchronized,
		match (
			measurements.steady_start.and_then(|snapshot| snapshot.cpu_ms),
			measurements.drain_start.and_then(|snapshot| snapshot.cpu_ms),
		) {
			(Some(start), Some(end)) => format!("{:.3}", end - start),
			_ => "null".to_string(),
		},
		match measurements.rss_max_mb {
			Some(rss) => format!("{rss:.3}"),
			None => "null".to_string(),
		},
		measurements
			.drain_start
			.map(|snapshot| snapshot.raw.datagram_frames_sent.to_string())
			.unwrap_or_else(|| "null".to_string()),
		measurements
			.drain_start
			.map(|snapshot| snapshot.raw.datagram_frames_received.to_string())
			.unwrap_or_else(|| "null".to_string()),
		measurements
			.drain_start
			.map(|snapshot| snapshot.raw.udp_datagrams_sent.to_string())
			.unwrap_or_else(|| "null".to_string()),
		measurements
			.drain_start
			.map(|snapshot| snapshot.raw.udp_datagrams_received.to_string())
			.unwrap_or_else(|| "null".to_string()),
		measurements.drain_start.is_some(),
		counters.rx_total,
		counters.rx_unstamped,
		counters.rate_limited_count,
		counters.limit_exceeded_count,
		counters.rx_move,
		counters.rx_action,
		counters.rx_snapshot,
		counters.rx_raid,
		counters.rx_raid_join,
		counters.emitter.snapshot_due,
		counters.emitter.snapshot_issued,
		counters.emitter.ack_due,
		counters.emitter.ack_issued,
		counters.emitter.raid_forwarded,
		counters.emitter.send_errors,
		raw_stats.datagram_frames_sent,
		raw_stats.datagram_frames_received,
		raw_stats.udp_datagrams_sent,
		raw_stats.udp_datagrams_received,
	)
}

async fn receive_loop(handle: SessionHandle, shared: Arc<SharedState>) {
    loop {
        let datagram = match handle.connection.receive_datagram().await {
            Ok(datagram) => datagram,
            Err(_) => break,
        };
        let now_ns = latency_probe::monotonic_ns();
        if !datagram_allowed(&shared, datagram.len(), now_ns / 1_000_000) {
            continue;
        }
        let mut maybe_forward = None;
        let mut ack = None;
        {
            let mut counters = shared
                .counters
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            counters.rx_total += 1;
            let Some(stamp) = read_stamp(datagram.as_ref()) else {
                counters.rx_unstamped += 1;
                continue;
            };
            if !note_class(&mut counters, stamp.class) {
                counters.rx_unstamped += 1;
                continue;
            }
            if stamp.class == CLASS_RAID_JOIN {
                if let Ok(mut kind) = handle.kind.lock() {
                    *kind = SessionKind::Raid;
                }
                continue;
            }
            if stamp.class == CLASS_RAID {
                if let Ok(mut kind) = handle.kind.lock() {
                    *kind = SessionKind::Publisher;
                }
                maybe_forward = Some(datagram.as_ref().to_vec());
            }
            if stamp.class == CLASS_ACTION {
                ack = Some(encode_reflected_ack(
                    stamp.actual_ns,
                    now_ns,
                    now_ns.saturating_sub(stamp.actual_ns),
                    stamp.sequence,
                ));
            }
        }
        if let Some(payload) = maybe_forward {
            let targets = shared
                .connections
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            for target in targets {
                if !target.alive.load(Ordering::Relaxed) {
                    continue;
                }
                let kind = target
                    .kind
                    .lock()
                    .map(|value| *value)
                    .unwrap_or(SessionKind::Player);
                if kind != SessionKind::Raid {
                    continue;
                }
                if target.connection.send_datagram(payload.clone()).is_ok() {
                    let mut counters = shared
                        .counters
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    counters.emitter.raid_forwarded += 1;
                } else {
                    let mut counters = shared
                        .counters
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    counters.emitter.send_errors += 1;
                }
            }
            continue;
        }
        if let Some(ack) = ack {
            let sent_ok = handle.connection.send_datagram(ack).is_ok();
            let mut counters = shared
                .counters
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            record_action_ack(&mut counters, sent_ok);
        }
    }
    handle.alive.store(false, Ordering::Relaxed);
    release_session_slot(&shared);
}

async fn reject_incoming_bidi_streams(connection: Connection, shared: Arc<SharedState>) {
    loop {
        tokio::select! {
            _ = connection.closed() => break,
            accepted = connection.accept_bi() => {
                let Ok((mut send, recv)) = accepted else {
                    break;
                };
                if !admit_stream(&shared, monotonic_ms()) {
                    let _ = send.reset(0u32);
                    recv.stop(0u32);
                    continue;
                }
                let _ = send.reset(0u32);
                recv.stop(0u32);
                release_stream(&shared);
            }
        }
    }
}

async fn reject_incoming_uni_streams(connection: Connection, shared: Arc<SharedState>) {
    loop {
        tokio::select! {
            _ = connection.closed() => break,
            accepted = connection.accept_uni() => {
                let Ok(recv) = accepted else {
                    break;
                };
                if !admit_stream(&shared, monotonic_ms()) {
                    recv.stop(0u32);
                    continue;
                }
                recv.stop(0u32);
                release_stream(&shared);
            }
        }
    }
}

fn active_players(connections: &[SessionHandle]) -> Vec<SessionHandle> {
    connections
        .iter()
        .filter(|handle| handle.alive.load(Ordering::Relaxed))
        .filter(|handle| {
            handle
                .kind
                .lock()
                .map(|kind| *kind == SessionKind::Player)
                .unwrap_or(false)
        })
        .cloned()
        .collect()
}

async fn emitter_loop(shared: Arc<SharedState>, phase_path: Option<PathBuf>, options: Options) {
    let plan = G6ServerCorePlan::registered();
    let interval = Duration::from_millis(plan.slice_ms);
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut sequence = 0u64;
    let mut steady_anchor = None;
    let mut booked_slices = 0usize;
    let mut emitted_slices = 0usize;
    let total_steady_slices = (options.duration_secs * plan.emitter_slice_hz) as usize;
    loop {
        let _scheduled = ticker.tick().await;
        let observed = tokio::time::Instant::now();
        let phase = phase_from_file(phase_path.as_ref());
        {
            let connections = shared
                .connections
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let mut measurements = shared
                .measurements
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if phase == "steady" {
                let snapshot = capture_measurement_snapshot(&connections);
                if measurements.steady_start.is_none() {
                    measurements.steady_start = Some(snapshot);
                }
                if let Some(rss) = snapshot.rss_mb {
                    measurements.rss_max_mb = Some(
                        measurements
                            .rss_max_mb
                            .map(|current| current.max(rss))
                            .unwrap_or(rss),
                    );
                }
            } else if measurements.steady_start.is_some()
                && measurements.drain_start.is_none()
                && phase != "connect"
            {
                let snapshot = capture_measurement_snapshot(&connections);
                measurements.drain_start = Some(snapshot);
                measurements.synchronized = phase == "drain";
                if let Some(rss) = snapshot.rss_mb {
                    measurements.rss_max_mb = Some(
                        measurements
                            .rss_max_mb
                            .map(|current| current.max(rss))
                            .unwrap_or(rss),
                    );
                }
            }
        }
        if phase == "stop" {
            break;
        }
        if phase != "steady" {
            if steady_anchor.is_some() {
                let mut counters = shared
                    .counters
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                book_snapshot_due_until(
                    &mut counters,
                    options.sessions,
                    &plan,
                    &mut booked_slices,
                    total_steady_slices,
                );
            }
            steady_anchor = None;
            booked_slices = 0;
            emitted_slices = 0;
            continue;
        }
        let anchor = steady_anchor.get_or_insert(observed);
        let actual_ns = latency_probe::monotonic_ns();
        let elapsed = observed.saturating_duration_since(*anchor);
        let due_slices = usize::min(
            total_steady_slices,
            (elapsed.as_nanos() / interval.as_nanos()) as usize + 1,
        );
        {
            let mut counters = shared
                .counters
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            book_snapshot_due_until(
                &mut counters,
                options.sessions,
                &plan,
                &mut booked_slices,
                due_slices,
            );
        }
        if emitted_slices >= total_steady_slices {
            continue;
        }
        let observation = observe_tick(
            *anchor + interval * (emitted_slices as u32),
            observed,
            actual_ns,
            interval,
        );
        let intended_ns = observation.intended_ns;
        let connections = shared
            .connections
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let players = active_players(&connections);
        if players.is_empty() {
            emitted_slices += 1;
            continue;
        }
        let per_slice = players.len().div_ceil(plan.slices_per_tick);
        let slot = emitted_slices % plan.slices_per_tick;
        let from = slot * per_slice;
        let to = usize::min(from + per_slice, players.len());
        for handle in players.iter().skip(from).take(to.saturating_sub(from)) {
            let mut batch_sent = 0u64;
            for _ in 0..plan.snapshot_datagrams {
                sequence += 1;
                let datagram = encode_snapshot_datagram(intended_ns, actual_ns, sequence);
                if handle.connection.send_datagram(datagram).is_ok() {
                    batch_sent += 1;
                }
            }
            let mut counters = shared
                .counters
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            counters.emitter.snapshot_issued += batch_sent;
            if batch_sent < plan.snapshot_datagrams as u64 {
                counters.emitter.send_errors += 1;
            }
        }
        emitted_slices += 1;
    }
}

async fn run(options: Options) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(path) = options.ready_path.as_deref() {
        clear_ready_marker(path)?;
    }
    let plan = G6ServerCorePlan::registered();
    let identity = Identity::load_pemfiles(&options.cert_pem, &options.key_pem).await?;
    let transport = apply_transport_settings(options.server_settings)?;
    let config = ServerConfig::builder()
        .with_bind_default(options.port)
        .with_custom_transport(identity, transport)
        .max_idle_timeout(Some(Duration::from_millis(
            options.server_settings.limits.idle_timeout_ms,
        )))?
        .build();
    let endpoint = Endpoint::server(config)?;
    let shared = Arc::new(SharedState::new(options.server_settings));
    let emitter = tokio::spawn(emitter_loop(
        Arc::clone(&shared),
        options.phase_path.clone(),
        options.clone(),
    ));
    let accept_stop = Arc::new(AtomicBool::new(false));
    let accept_shared = Arc::clone(&shared);
    let accept_stop_task = Arc::clone(&accept_stop);
    let acceptor = tokio::spawn(async move {
        while !accept_stop_task.load(Ordering::Relaxed) {
            let incoming =
                match tokio::time::timeout(Duration::from_millis(250), endpoint.accept()).await {
                    Ok(incoming) => incoming,
                    Err(_) => continue,
                };
            let accept_shared = Arc::clone(&accept_shared);
            tokio::spawn(async move {
                let remote_address = incoming.remote_address();
                if !admit_handshake(&accept_shared, monotonic_ms(), remote_address) {
                    return;
                }
                let Ok(session_request) = incoming.await else {
                    release_handshake(&accept_shared);
                    return;
                };
                if !admit_session_slot(&accept_shared) {
                    release_handshake(&accept_shared);
                    return;
                }
                let Ok(connection) = session_request.accept().await else {
                    release_handshake(&accept_shared);
                    release_session_slot(&accept_shared);
                    return;
                };
                release_handshake(&accept_shared);
                let handle = SessionHandle {
                    connection: connection.clone(),
                    kind: Arc::new(Mutex::new(SessionKind::Player)),
                    alive: Arc::new(AtomicBool::new(true)),
                };
                accept_shared
                    .connections
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(handle.clone());
                tokio::spawn(reject_incoming_bidi_streams(
                    connection.clone(),
                    Arc::clone(&accept_shared),
                ));
                tokio::spawn(reject_incoming_uni_streams(
                    connection.clone(),
                    Arc::clone(&accept_shared),
                ));
                receive_loop(handle, accept_shared).await;
            });
        }
    });
    if let Some(path) = options.ready_path.as_deref() {
        publish_ready_marker(path, options.port)?;
    }

    let total_wait = Duration::from_secs(options.duration_secs + options.idle_secs)
        + Duration::from_millis(options.drain_ms);
    tokio::time::sleep(total_wait).await;
    accept_stop.store(true, Ordering::Relaxed);
    if let Some(path) = options.phase_path.clone() {
        let _ = std::fs::write(path, "stop\n");
    }
    let _ = emitter.await;
    let connections = shared
        .connections
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    for handle in &connections {
        handle.connection.close(0u32.into(), b"g6-server-stop");
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    acceptor.abort();

    let counters = shared
        .counters
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let measurements = shared
        .measurements
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let raw_stats = aggregate_connection_stats(&connections);
    let phase = phase_from_file(options.phase_path.as_ref());
    let summary = build_summary_json(&options, &plan, &counters, raw_stats, &measurements, &phase);
    if let Some(path) = &options.summary_json {
        std::fs::write(path, format!("{summary}\n"))?;
    }
    println!("g6-server: summary {summary}");
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = Options::parse().map_err(std::io::Error::other)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?;
    runtime.block_on(run(options))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::g6_protocol::{
        action_every_nth_tick, class_for_tick, ticks_due_after, TickObservation,
        SNAPSHOT_DATAGRAMS, SNAPSHOT_PAYLOAD_BYTES,
    };
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    #[test]
    fn protocol_plan_matches_the_registered_js_server_shape() {
        let plan = G6ServerCorePlan::registered();
        assert_eq!(plan.snapshot_payload_bytes, 1150);
        assert_eq!(plan.snapshot_datagrams, 3);
        assert_eq!(plan.snapshot_hz, 5);
        assert_eq!(plan.emitter_slice_hz, 50);
        assert_eq!(SNAPSHOT_PAYLOAD_BYTES, 1150);
        assert_eq!(SNAPSHOT_DATAGRAMS, 3);
    }

    #[test]
    fn scheduler_due_counts_and_tick_classes_match_the_registered_client() {
        let interval = Duration::from_millis(250);
        assert_eq!(
            ticks_due_after(Duration::from_secs(120), interval, 0.0),
            480
        );
        assert_eq!(action_every_nth_tick(), 8);
        assert_eq!(class_for_tick(8, action_every_nth_tick()), CLASS_ACTION);
        assert_eq!(class_for_tick(9, action_every_nth_tick()), CLASS_MOVE);
    }

    #[test]
    fn observe_tick_never_reports_negative_lag_or_future_intended_time() {
        let scheduled = tokio::time::Instant::now();
        let observed = scheduled + Duration::from_millis(503);
        let tick = observe_tick(
            scheduled,
            observed,
            4_503_000_000,
            Duration::from_millis(250),
        );
        assert_eq!(
            tick,
            TickObservation {
                intended_ns: 4_000_000_000,
                lag_ns: 503_000_000,
                skipped_ticks: 2,
            }
        );
    }

    #[test]
    fn action_ack_counters_follow_send_outcome() {
        let mut counters = ServerCounters::default();
        record_action_ack(&mut counters, true);
        record_action_ack(&mut counters, false);
        assert_eq!(
            counters.emitter,
            EmitterCounters {
                snapshot_due: 0,
                snapshot_issued: 0,
                ack_due: 2,
                ack_issued: 1,
                raid_forwarded: 0,
                send_errors: 1,
            }
        );
    }

    #[test]
    fn note_class_counts_registered_classes_and_rejects_unknown_values() {
        let mut counters = ServerCounters::default();
        assert!(note_class(&mut counters, CLASS_MOVE));
        assert!(note_class(&mut counters, CLASS_ACTION));
        assert!(note_class(&mut counters, CLASS_SNAPSHOT));
        assert!(note_class(&mut counters, CLASS_RAID));
        assert!(note_class(&mut counters, CLASS_RAID_JOIN));
        assert!(!note_class(&mut counters, 99));
        assert_eq!(counters.rx_move, 1);
        assert_eq!(counters.rx_action, 1);
        assert_eq!(counters.rx_snapshot, 1);
        assert_eq!(counters.rx_raid, 1);
        assert_eq!(counters.rx_raid_join, 1);
    }

    #[test]
    fn immutable_due_accounting_books_the_full_registered_20x5_shape() {
        let plan = G6ServerCorePlan::registered();
        let mut counters = ServerCounters::default();
        let mut booked_slices = 0usize;

        book_snapshot_due_until(&mut counters, 20, &plan, &mut booked_slices, 250);
        assert_eq!(booked_slices, 250);
        assert_eq!(counters.emitter.snapshot_due, 1_500);

        book_snapshot_due_until(&mut counters, 20, &plan, &mut booked_slices, 250);
        assert_eq!(booked_slices, 250);
        assert_eq!(counters.emitter.snapshot_due, 1_500);
    }

    #[test]
    fn parses_shared_server_settings_from_cli_flags() {
        let options = Options::parse_from([
            "--sessions".to_string(),
            "20".to_string(),
            "--cert-pem".to_string(),
            "cert.pem".to_string(),
            "--key-pem".to_string(),
            "key.pem".to_string(),
            "--ready-path".to_string(),
            "ready.json".to_string(),
            "--max-sessions".to_string(),
            "128".to_string(),
            "--max-handshakes-in-flight".to_string(),
            "64".to_string(),
            "--max-streams-per-session-bidi".to_string(),
            "300".to_string(),
            "--max-streams-per-session-uni".to_string(),
            "301".to_string(),
            "--max-streams-global".to_string(),
            "50001".to_string(),
            "--max-datagram-size".to_string(),
            "1300".to_string(),
            "--max-queued-bytes-per-session".to_string(),
            "4096".to_string(),
            "--max-queued-bytes-per-stream".to_string(),
            "2048".to_string(),
            "--idle-timeout-ms".to_string(),
            "12345".to_string(),
            "--handshakes-per-sec".to_string(),
            "90".to_string(),
            "--handshakes-burst".to_string(),
            "91".to_string(),
            "--handshakes-burst-per-prefix".to_string(),
            "92".to_string(),
            "--streams-per-sec".to_string(),
            "93".to_string(),
            "--streams-burst".to_string(),
            "94".to_string(),
            "--datagrams-per-sec".to_string(),
            "95".to_string(),
            "--datagrams-burst".to_string(),
            "96".to_string(),
        ])
        .expect("options");

        assert_eq!(options.server_settings.limits.max_sessions, 128);
        assert_eq!(options.server_settings.limits.max_handshakes_in_flight, 64);
        assert_eq!(
            options.server_settings.limits.max_streams_per_session_bidi,
            300
        );
        assert_eq!(
            options.server_settings.limits.max_streams_per_session_uni,
            301
        );
        assert_eq!(options.server_settings.limits.max_streams_global, 50_001);
        assert_eq!(options.server_settings.limits.max_datagram_size, 1300);
        assert_eq!(
            options.server_settings.limits.max_queued_bytes_per_session,
            4096
        );
        assert_eq!(
            options.server_settings.limits.max_queued_bytes_per_stream,
            2048
        );
        assert_eq!(options.server_settings.limits.idle_timeout_ms, 12_345);
        assert_eq!(options.server_settings.rate_limits.handshakes_per_sec, 90);
        assert_eq!(options.server_settings.rate_limits.handshakes_burst, 91);
        assert_eq!(
            options
                .server_settings
                .rate_limits
                .handshakes_burst_per_prefix,
            92
        );
        assert_eq!(options.server_settings.rate_limits.streams_per_sec, 93);
        assert_eq!(options.server_settings.rate_limits.streams_burst, 94);
        assert_eq!(options.server_settings.rate_limits.datagrams_per_sec, 95);
        assert_eq!(options.server_settings.rate_limits.datagrams_burst, 96);
        assert_eq!(options.ready_path, Some(PathBuf::from("ready.json")));
    }

    #[test]
    fn publishes_atomic_source_owned_readiness_marker() {
        let marker = std::env::temp_dir().join(format!(
            "g6-server-ready-test-{}-{}.json",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock after epoch")
                .as_nanos()
        ));
        let temp = ready_marker_temp_path(&marker);

        publish_ready_marker(&marker, 4_433).expect("publish marker");

        assert_eq!(
            std::fs::read_to_string(&marker).expect("read marker"),
            "{\"schema\":\"g6-rust-server-ready/1\",\"port\":4433}\n"
        );
        assert!(!temp.exists());
        clear_ready_marker(&marker).expect("clear marker");
        assert!(!marker.exists());
    }

    #[test]
    fn token_bucket_enforces_rate_and_burst() {
        let mut bucket = TokenBucket::new(2, 2);
        assert!(bucket.allow_at(0));
        assert!(bucket.allow_at(0));
        assert!(!bucket.allow_at(0));
        assert!(bucket.allow_at(500));
        assert!(!bucket.allow_at(500));
    }

    #[test]
    fn handshake_and_session_admission_increment_refusal_counters() {
        let settings = ServerSettings {
            limits: LimitSettings {
                max_sessions: 0,
                max_handshakes_in_flight: 1,
                ..ServerSettings::for_sessions(20).limits
            },
            rate_limits: RateLimitSettings {
                handshakes_per_sec: 1,
                handshakes_burst: 1,
                ..ServerSettings::for_sessions(20).rate_limits
            },
        };
        let shared = SharedState::new(settings);
        let peer = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 4433);

        assert!(admit_handshake(&shared, 0, peer));
        assert!(!admit_handshake(&shared, 0, peer));
        release_handshake(&shared);
        assert!(admit_handshake(&shared, 1000, peer));
        release_handshake(&shared);
        assert!(!admit_session_slot(&shared));
        let counters = shared.counters.lock().unwrap().clone();
        assert_eq!(counters.rate_limited_count, 1);
        assert_eq!(counters.limit_exceeded_count, 1);
    }

    #[test]
    fn datagram_limit_checks_increment_refusal_counters() {
        let settings = ServerSettings::for_sessions(20);
        let shared = SharedState::new(settings);
        assert!(!datagram_allowed(
            &shared,
            settings.limits.max_datagram_size + 1,
            0
        ));
        assert!(datagram_allowed(&shared, 64, 0));
        let counters = shared.counters.lock().unwrap().clone();
        assert_eq!(counters.limit_exceeded_count, 1);
    }

    #[test]
    fn handshake_prefix_limit_is_enforced_per_registered_prefix() {
        let defaults = ServerSettings::for_sessions(20);
        let shared = SharedState::new(ServerSettings {
            limits: defaults.limits,
            rate_limits: RateLimitSettings {
                handshakes_per_sec: 10,
                handshakes_burst: 10,
                handshakes_burst_per_prefix: 1,
                ..defaults.rate_limits
            },
        });
        let prefix_a = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1)), 4433);
        let same_prefix = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 200)), 4434);
        let other_prefix = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), 4435);

        assert!(admit_handshake(&shared, 0, prefix_a));
        release_handshake(&shared);
        assert!(!admit_handshake(&shared, 0, same_prefix));
        assert!(admit_handshake(&shared, 0, other_prefix));
        release_handshake(&shared);

        let counters = shared.counters.lock().unwrap().clone();
        assert_eq!(counters.rate_limited_count, 1);
    }

    #[test]
    fn session_slot_reservation_prevents_concurrent_overcommit() {
        let defaults = ServerSettings::for_sessions(20);
        let shared = SharedState::new(ServerSettings {
            limits: LimitSettings {
                max_sessions: 1,
                ..defaults.limits
            },
            rate_limits: defaults.rate_limits,
        });

        assert!(admit_session_slot(&shared));
        assert!(!admit_session_slot(&shared));
        release_session_slot(&shared);
        assert!(admit_session_slot(&shared));
        release_session_slot(&shared);

        let counters = shared.counters.lock().unwrap().clone();
        assert_eq!(counters.limit_exceeded_count, 1);
    }

    #[test]
    fn stream_limit_checks_increment_refusal_counters() {
        let defaults = ServerSettings::for_sessions(20);
        let shared = SharedState::new(ServerSettings {
            limits: LimitSettings {
                max_streams_global: 1,
                ..defaults.limits
            },
            rate_limits: RateLimitSettings {
                streams_per_sec: 1,
                streams_burst: 1,
                ..defaults.rate_limits
            },
        });

        assert!(admit_stream(&shared, 0));
        assert!(!admit_stream(&shared, 0));
        release_stream(&shared);
        assert!(!admit_stream(&shared, 0));
        assert!(admit_stream(&shared, 1000));
        release_stream(&shared);

        let counters = shared.counters.lock().unwrap().clone();
        assert_eq!(counters.limit_exceeded_count, 1);
        assert_eq!(counters.rate_limited_count, 1);
    }
}
