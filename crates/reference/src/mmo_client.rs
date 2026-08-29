//! G6's MMO realm generator: a realm of players, a raid publisher, a raid
//! audience, and the reconnect storm.
//!
//! Companion to `tools/load/bench-g6.ts`; the ladder, the clauses and every
//! falsifier are in `docs/research/preregistrations/gate-g6-mmo.md`. This binary
//! offers load and measures the client half; it decides nothing.
//!
//! Three roles, because the fan-out arm needs three processes (ticket 14's
//! registered shape — an in-process publisher is how the retracted run produced
//! a 9–31 µs "ingest" path that never contained a network):
//!
//! * `realm`           — N players. Movement upstream at `--move-interval-ms`,
//!   every `--action-every`-th tick flagged `ACTION`, and a
//!   sink for the server's snapshot and ack classes. The
//!   ack's reflected token is what makes the round trip
//!   measurable on **one** clock, which is the only kind of
//!   latency statement an off-box generator can make.
//! * `publisher` — one raid event source.
//! * `raid-subscriber` — the 40 raid members, receive-only.
//!
//! The storm is here rather than in the harness for the reason ticket 30 gives:
//! the client is where a severed connection and its retry live. What the harness
//! must never do is *infer* the accept rate from this process's pacing — the
//! four-axes retraction showed `acceptsPerSec × mean accept latency ≈ 500` was
//! Little's law on this generator's own permit pool at every rung. So the storm
//! reconnects with **no permit pool at all** (`--storm-concurrency 0`), and the
//! accept series the gate reads is the server's own.

// Shared with the other load binaries so both ends of a stamp are one
// implementation. This binary writes v3 upstream and reads v3 downstream, so
// unlike `scale_client` it uses both halves.
#[allow(dead_code)]
mod g6_protocol;
#[allow(dead_code)]
mod latency_probe;

use g6_protocol::{
    action_every_nth_tick, class_for_tick, first_tick_offset, observe_tick, ticks_due_after,
    TickObservation, UPSTREAM_PAYLOAD_BYTES,
};
use latency_probe::{
    monotonic_ns, read_stamp, write_stamp_v3, AtomicHistogram, CLASS_ACK, CLASS_RAID,
    CLASS_RAID_JOIN, CLASS_SNAPSHOT, STAMP_BYTES_V3,
};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::{watch, Semaphore};
use wtransport::quinn;
use wtransport::{ClientConfig, Endpoint};

const DEFAULT_URL: &str = "https://127.0.0.1:4433";
const G6_CLOSEOUT_SPEC_ID: &str = "g6-mmo-closeout/1";
const G6_CLOSEOUT_SPEC_PATH: &str = "docs/research/preregistrations/gate-g6-mmo-closeout.md";
const DEFAULT_DRAIN_MS: u64 = 1000;
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_IDLE: Duration = Duration::from_secs(60);
const MAX_RECORDED_ERRORS: usize = 5;
const JOIN_TIMEOUT: Duration = Duration::from_secs(20);
const DEFAULT_PHASE_BARRIER_TIMEOUT_MS: u64 = 60_000;
/// Grace for every session task to observe a phase change before counters are
/// snapshotted at that boundary. Carried from `scale_client`, same reason: a
/// session whose `select!` picked its ticker over the phase change would send a
/// datagram the server counts and this snapshot does not.
const PHASE_SETTLE: Duration = Duration::from_millis(250);
const PASSIVE_CLASSIFICATION_SETTLE: Duration = Duration::from_millis(250);
/// Self-guard ceiling for this process's own RSS. A generator that takes the
/// host down leaves no evidence behind; aborting costs one arm. Overridable
/// by the `MMO_CLIENT_RSS_LIMIT_MB` env var so scale-ladder dispatches can
/// raise the ceiling without rebuilding.
fn client_rss_limit_mb() -> f64 {
    std::env::var("MMO_CLIENT_RSS_LIMIT_MB")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|&v| v > 0.0)
        .unwrap_or(12_288.0)
}
const RSS_GUARD_INTERVAL: Duration = Duration::from_secs(2);
const EXIT_RSS_GUARD: i32 = 91;
/// Application close code the severed cohort uses. Models a client-side
/// disconnect; the silent black-hole storm is registered as NOT covered
/// (gate-g6-mmo.md §1.8) because at a 60 s idle timeout the server's reaper
/// would dominate the window.
const SEVER_CLOSE_CODE: u32 = 0;

const PHASE_CONNECT: u8 = 0;
const PHASE_STEADY: u8 = 1;
const PHASE_DRAIN: u8 = 2;
const PHASE_STORM: u8 = 3;
const PHASE_POST: u8 = 4;
const PHASE_IDLE: u8 = 5;
const PHASE_STOP: u8 = 6;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SendWindowKind {
    Steady,
    Storm,
    Post,
}

#[derive(Debug)]
struct ActiveSendWindow {
    kind: SendWindowKind,
    /// The driver's flip instant for this phase, shared by every session, so
    /// the window's schedule is the registered one rather than one that
    /// starts whenever this session happened to wake.
    started_at: tokio::time::Instant,
    ticker: tokio::time::Interval,
    /// Ticks this session has fired or skipped inside this window — its own
    /// local ledger, matched against the window's due count at close so the
    /// never-presented boundary remainder is measured, not inferred.
    processed: u64,
    /// The registered schedule's total demand for this window: ticks due over
    /// the registered phase duration. Sends stop here — the registered window
    /// is the offer, and a late-observed drain flip must not stretch it.
    capacity: Option<u64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Role {
    Realm,
    Publisher,
    RaidSubscriber,
}

impl Role {
    fn parse(raw: &str) -> Option<Role> {
        match raw {
            "realm" => Some(Role::Realm),
            "publisher" => Some(Role::Publisher),
            "raid-subscriber" | "raid" => Some(Role::RaidSubscriber),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Role::Realm => "realm",
            Role::Publisher => "publisher",
            Role::RaidSubscriber => "raid-subscriber",
        }
    }
}

#[derive(Clone)]
struct Options {
    role: Role,
    url: String,
    sessions: usize,
    /// Realm sessions that drive the registered movement/snapshot workload.
    /// The remaining established sessions are receive-only and identify
    /// themselves with RAID_JOIN so the server excludes them from snapshots.
    active_workload_sessions: Option<usize>,
    endpoints: usize,
    /// Skip the 127.0.x.1 per-endpoint source-IP aliases (a co-resident
    /// trick): an off-box Linux generator binds them successfully and then
    /// routes nothing, where macOS fails the bind and falls back anyway.
    bind_default: bool,
    fixed_source_port_base: Option<u16>,
    connect_concurrency: usize,
    /// Maximum offered connection starts per second. Zero preserves the
    /// historical unpaced burst.
    connect_rate_per_sec: u64,
    steady: Duration,
    drain: Duration,
    idle: Duration,
    /// Upstream movement interval. 250 ms = the registered 4 pps (§1.2).
    send_interval: Duration,
    /// Every Nth upstream tick carries `ACTION` and draws an ack (§1.4).
    action_every: u64,
    payload_bytes: usize,
    connect_timeout: Duration,
    json_out: Option<String>,
    pre_registration_sha256: Option<String>,
    started_at: Option<String>,
    phase_barrier_id: Option<String>,
    phase_barrier_dir: Option<String>,
    phase_barrier_parties: usize,
    phase_barrier_timeout: Duration,
    diagnostic_host_udp: bool,
    /// Session *i* of *N* phase-offsets by `i/N` of one interval. On for the
    /// steady realm (G1's registered process, T02's reason); the storm's
    /// alignment is a separate, deliberate thing and lives in the storm phase.
    stagger_sends: bool,
    /// Sessions severed when the storm fires. Zero disables the storm arm.
    storm_cohort: usize,
    storm_reconnect_delay: Duration,
    storm_window: Duration,
    /// Post-storm steady window, so the realm is seen to re-stabilize.
    post_storm: Duration,
    /// Permits the reconnect may use. **Zero means no pool**, which is the
    /// registered configuration: a pool is a semaphore, and a semaphore is what
    /// the retracted accept-rate figures were actually measuring.
    storm_concurrency: usize,
}

impl Options {
    fn defaults() -> Options {
        Options {
            role: Role::Realm,
            url: DEFAULT_URL.to_string(),
            sessions: 100,
            active_workload_sessions: None,
            endpoints: 1,
            bind_default: false,
            fixed_source_port_base: None,
            connect_concurrency: 500,
            connect_rate_per_sec: 0,
            steady: Duration::from_secs(120),
            drain: Duration::from_millis(DEFAULT_DRAIN_MS),
            idle: Duration::from_secs(30),
            send_interval: Duration::from_millis(250),
            action_every: action_every_nth_tick(),
            payload_bytes: UPSTREAM_PAYLOAD_BYTES,
            connect_timeout: Duration::from_secs(300),
            json_out: None,
            pre_registration_sha256: None,
            started_at: None,
            phase_barrier_id: None,
            phase_barrier_dir: None,
            phase_barrier_parties: 0,
            phase_barrier_timeout: Duration::from_millis(DEFAULT_PHASE_BARRIER_TIMEOUT_MS),
            diagnostic_host_udp: false,
            stagger_sends: true,
            storm_cohort: 0,
            storm_reconnect_delay: Duration::from_millis(1000),
            storm_window: Duration::from_secs(120),
            post_storm: Duration::from_secs(60),
            storm_concurrency: 0,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct HostUdpCounters {
    in_datagrams: u64,
    no_ports: u64,
    in_errors: u64,
    out_datagrams: u64,
    rcvbuf_errors: u64,
    sndbuf_errors: u64,
}

impl HostUdpCounters {
    fn to_json(self) -> String {
        format!(
            concat!(
                "{{\"InDatagrams\":{},\"NoPorts\":{},\"InErrors\":{},",
                "\"OutDatagrams\":{},\"RcvbufErrors\":{},\"SndbufErrors\":{}}}"
            ),
            self.in_datagrams,
            self.no_ports,
            self.in_errors,
            self.out_datagrams,
            self.rcvbuf_errors,
            self.sndbuf_errors,
        )
    }
}

#[derive(Default)]
struct HostUdpSamples {
    connect: Option<HostUdpCounters>,
    steady: Option<HostUdpCounters>,
    drain: Option<HostUdpCounters>,
    idle: Option<HostUdpCounters>,
}

impl HostUdpSamples {
    fn to_json(&self) -> String {
        format!(
            "{{\"connect\":{},\"steady\":{},\"drain\":{},\"idle\":{}}}",
            self.connect
                .map(HostUdpCounters::to_json)
                .unwrap_or_else(|| "null".to_string()),
            self.steady
                .map(HostUdpCounters::to_json)
                .unwrap_or_else(|| "null".to_string()),
            self.drain
                .map(HostUdpCounters::to_json)
                .unwrap_or_else(|| "null".to_string()),
            self.idle
                .map(HostUdpCounters::to_json)
                .unwrap_or_else(|| "null".to_string()),
        )
    }
}

const HOST_UDP_COUNTER_FIELDS: [&str; 6] = [
    "InDatagrams",
    "NoPorts",
    "InErrors",
    "OutDatagrams",
    "RcvbufErrors",
    "SndbufErrors",
];

fn parse_host_udp_counter(keys: &[&str], values: &[&str], field: &str) -> Option<u64> {
    let index = keys.iter().position(|key| *key == field)?;
    if keys.iter().filter(|key| **key == field).count() != 1 {
        return None;
    }
    let raw = *values.get(index)?;
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    raw.parse().ok()
}

fn parse_host_udp_counters(text: &str) -> Option<HostUdpCounters> {
    let mut udp_lines = text
        .lines()
        .filter(|line| line.trim_start().starts_with("Udp:"));
    let header = udp_lines.next()?;
    let values = udp_lines.next()?;
    let keys = header.split_whitespace().skip(1).collect::<Vec<_>>();
    let values = values.split_whitespace().skip(1).collect::<Vec<_>>();
    for field in HOST_UDP_COUNTER_FIELDS {
        if keys.iter().filter(|key| **key == field).count() != 1 {
            return None;
        }
    }
    Some(HostUdpCounters {
        in_datagrams: parse_host_udp_counter(&keys, &values, "InDatagrams")?,
        no_ports: parse_host_udp_counter(&keys, &values, "NoPorts")?,
        in_errors: parse_host_udp_counter(&keys, &values, "InErrors")?,
        out_datagrams: parse_host_udp_counter(&keys, &values, "OutDatagrams")?,
        rcvbuf_errors: parse_host_udp_counter(&keys, &values, "RcvbufErrors")?,
        sndbuf_errors: parse_host_udp_counter(&keys, &values, "SndbufErrors")?,
    })
}

fn sample_host_udp() -> Option<HostUdpCounters> {
    fs::read_to_string("/proc/net/snmp")
        .ok()
        .and_then(|text| parse_host_udp_counters(&text))
}

fn host_udp_json(enabled: bool, samples: &HostUdpSamples) -> Option<String> {
    enabled.then(|| samples.to_json())
}

/* -------------------------------------------------------------------------- */
/* Pure helpers — everything a unit test can reach without a network           */
/* -------------------------------------------------------------------------- */

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[cfg(test)]
struct ScheduleAccounting {
    due: u64,
    fired: u64,
    skipped: u64,
    unpresented: u64,
}

#[cfg(test)]
impl ScheduleAccounting {
    fn reconciled(self) -> bool {
        self.due
            == self
                .fired
                .saturating_add(self.skipped)
                .saturating_add(self.unpresented)
    }
}

#[cfg(test)]
fn schedule_accounting(
    elapsed: Duration,
    interval: Duration,
    phase_offset: f64,
    fired: u64,
    skipped: u64,
    processed: u64,
    capacity: Option<u64>,
) -> ScheduleAccounting {
    let wall_due = ticks_due_after(elapsed, interval, phase_offset);
    let due = capacity.map_or(wall_due, |cap| wall_due.min(cap));
    ScheduleAccounting {
        due,
        fired,
        skipped,
        unpresented: due.saturating_sub(processed),
    }
}

fn send_window_kind(phase: u8) -> Option<SendWindowKind> {
    match phase {
        PHASE_STEADY => Some(SendWindowKind::Steady),
        PHASE_STORM => Some(SendWindowKind::Storm),
        PHASE_POST => Some(SendWindowKind::Post),
        _ => None,
    }
}

fn phase_records_steady_drain(phase: u8) -> bool {
    matches!(phase, PHASE_STEADY | PHASE_DRAIN)
}

fn phase_records_storm_survivors(phase: u8, severed: bool) -> bool {
    !severed && phase == PHASE_STORM
}

/// Whether session `index` is in the severed cohort. The cohort is the *first*
/// `cohort` indices and nothing about a session's behaviour depends on its
/// index otherwise, so "severed" and "survivor" are decided before the run and
/// cannot be chosen after it.
fn is_severed(index: usize, cohort: usize) -> bool {
    index < cohort
}

fn parse_or_default<T>(flag: &str, raw: Option<String>, default: T) -> T
where
    T: std::str::FromStr + Copy,
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    match raw {
        Some(v) => match v.parse::<T>() {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!("mmo-client: invalid value for {flag} ('{v}'): {e}; using default");
                default
            }
        },
        None => default,
    }
}

fn rusage_self() -> Option<libc::rusage> {
    let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
    let result = unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) };
    if result != 0 {
        return None;
    }
    Some(unsafe { usage.assume_init() })
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

fn self_cpu_ms() -> Option<f64> {
    let usage = rusage_self()?;
    let user_ms = usage.ru_utime.tv_sec as f64 * 1000.0 + usage.ru_utime.tv_usec as f64 / 1000.0;
    let system_ms = usage.ru_stime.tv_sec as f64 * 1000.0 + usage.ru_stime.tv_usec as f64 / 1000.0;
    Some(user_ms + system_ms)
}

fn percentile(sorted: &[u64], p: f64) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted.get(idx).copied()
}

fn json_num(v: Option<f64>) -> String {
    match v {
        Some(n) if n.is_finite() => format!("{n:.3}"),
        _ => "null".to_string(),
    }
}

fn json_u64(v: Option<u64>) -> String {
    match v {
        Some(n) => n.to_string(),
        None => "null".to_string(),
    }
}

fn json_string(v: Option<&str>) -> String {
    match v {
        Some(value) => format!("\"{}\"", escape(value)),
        None => "null".to_string(),
    }
}

fn escape(s: &str) -> String {
    s.chars()
        .flat_map(|c| match c {
            '"' => vec!['\\', '"'],
            '\\' => vec!['\\', '\\'],
            '\n' | '\r' | '\t' => vec![' '],
            c if (c as u32) < 0x20 => vec![' '],
            c => vec![c],
        })
        .collect()
}

/* -------------------------------------------------------------------------- */
/* Counters                                                                    */
/* -------------------------------------------------------------------------- */

/// One set of counters. Two instances exist during the storm: the realm's, and
/// the survivors' alone — §5.3 requires the survivor clause to be computed over
/// the survivor cohort and never over a realm-wide aggregate the reconnecting
/// cohort's own traffic would contaminate.
#[derive(Default)]
struct Counters {
    sent: AtomicU64,
    send_err: AtomicU64,
    ticks_due: AtomicU64,
    ticks_fired: AtomicU64,
    ticks_skipped: AtomicU64,
    /// Ticks the registered schedule made due inside the window that the
    /// session's ticker never presented before the window closed. Measured per
    /// session at close from its own schedule position — a fourth counter,
    /// never inferred from the other three after the fact.
    ticks_unpresented: AtomicU64,
    rx_snapshot: AtomicU64,
    rx_ack: AtomicU64,
    rx_raid: AtomicU64,
    rx_other: AtomicU64,
    rx_unstamped: AtomicU64,
    /// Acks whose reflected token was zero — a server that forgot to reflect.
    /// Counted rather than recorded as a round trip measured from the epoch.
    ack_unreflected: AtomicU64,
    /// Unexpected session losses attributable to this measurement population.
    sessions_lost: AtomicU64,
}

impl Counters {
    fn ticks_reconciled(&self) -> bool {
        self.ticks_due.load(Ordering::Relaxed)
            == self
                .ticks_fired
                .load(Ordering::Relaxed)
                .saturating_add(self.ticks_skipped.load(Ordering::Relaxed))
                .saturating_add(self.ticks_unpresented.load(Ordering::Relaxed))
    }

    fn to_json_fields(&self) -> String {
        format!(
            concat!(
                "\"sent\":{},\"sendErr\":{},",
                "\"scheduleTicksDue\":{},\"scheduleTicksFired\":{},",
                "\"scheduleTicksSkipped\":{},\"scheduleTicksUnpresented\":{},",
                "\"scheduleTicksReconciled\":{},",
                "\"rxSnapshot\":{},\"rxAck\":{},\"rxRaid\":{},\"rxOther\":{},",
                "\"rxUnstamped\":{},\"ackUnreflected\":{},\"sessionsLost\":{}"
            ),
            self.sent.load(Ordering::Relaxed),
            self.send_err.load(Ordering::Relaxed),
            self.ticks_due.load(Ordering::Relaxed),
            self.ticks_fired.load(Ordering::Relaxed),
            self.ticks_skipped.load(Ordering::Relaxed),
            self.ticks_unpresented.load(Ordering::Relaxed),
            self.ticks_reconciled(),
            self.rx_snapshot.load(Ordering::Relaxed),
            self.rx_ack.load(Ordering::Relaxed),
            self.rx_raid.load(Ordering::Relaxed),
            self.rx_other.load(Ordering::Relaxed),
            self.rx_unstamped.load(Ordering::Relaxed),
            self.ack_unreflected.load(Ordering::Relaxed),
            self.sessions_lost.load(Ordering::Relaxed),
        )
    }
}

#[derive(Default)]
struct WindowStats {
    counters: Counters,
    rtt: AtomicHistogram,
    one_way: AtomicHistogram,
    server_hold: AtomicHistogram,
    schedule_lag: AtomicHistogram,
}

impl WindowStats {
    fn record_class(&self, class: u8) {
        match class {
            CLASS_SNAPSHOT => self.counters.rx_snapshot.fetch_add(1, Ordering::Relaxed),
            CLASS_ACK => self.counters.rx_ack.fetch_add(1, Ordering::Relaxed),
            CLASS_RAID => self.counters.rx_raid.fetch_add(1, Ordering::Relaxed),
            _ => self.counters.rx_other.fetch_add(1, Ordering::Relaxed),
        };
    }

    fn record_unstamped(&self) {
        self.counters.rx_unstamped.fetch_add(1, Ordering::Relaxed);
    }

    fn record_ack_unreflected(&self) {
        self.counters
            .ack_unreflected
            .fetch_add(1, Ordering::Relaxed);
    }

    fn record_session_loss(&self) {
        self.counters.sessions_lost.fetch_add(1, Ordering::Relaxed);
    }

    fn record_send(&self, ok: bool) {
        if ok {
            self.counters.sent.fetch_add(1, Ordering::Relaxed);
        } else {
            self.counters.send_err.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_tick(&self, observation: TickObservation) {
        self.counters.ticks_fired.fetch_add(1, Ordering::Relaxed);
        self.counters
            .ticks_skipped
            .fetch_add(observation.skipped_ticks, Ordering::Relaxed);
        self.schedule_lag.record(observation.lag_ns);
    }

    fn record_due(&self, due: u64) {
        self.counters.ticks_due.fetch_add(due, Ordering::Relaxed);
    }

    fn record_unpresented(&self, unpresented: u64) {
        self.counters
            .ticks_unpresented
            .fetch_add(unpresented, Ordering::Relaxed);
    }

    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "{},",
                "\"scheduleLag\":{},",
                "\"rtt\":{},",
                "\"oneWay\":{},",
                "\"serverHold\":{}",
                "}}"
            ),
            self.counters.to_json_fields(),
            self.schedule_lag.to_json(),
            self.rtt.to_json(),
            self.one_way.to_json(),
            self.server_hold.to_json(),
        )
    }
}

#[derive(Default)]
struct SessionCounters {
    ok: AtomicU64,
    err: AtomicU64,
    lost: AtomicU64,
    connect_done: AtomicU64,
    /// Severed sessions that got back in. The *client's* view; the gate's accept
    /// series is the server's, and these two are never conflated.
    reconnect_ok: AtomicU64,
    reconnect_err: AtomicU64,
}

/// Per-window QUIC tap, summed over live connections. `frame_tx_datagram` is the
/// stage-ledger tap between "the client enqueued it" and "the wire carried it";
/// the gap is quinn's silent send-buffer eviction and is the only way a datagram
/// can vanish before the kernel sees it.
#[derive(Clone, Copy, Default)]
struct QuicTap {
    connections: u64,
    frame_tx_datagram: u64,
    frame_rx_datagram: u64,
    sent_packets: u64,
    lost_packets: u64,
}

impl QuicTap {
    fn add(&mut self, s: &quinn::ConnectionStats) {
        self.connections += 1;
        self.frame_tx_datagram += s.frame_tx.datagram;
        self.frame_rx_datagram += s.frame_rx.datagram;
        self.sent_packets += s.path.sent_packets;
        self.lost_packets += s.path.lost_packets;
    }

    fn delta(&self, base: &QuicTap) -> QuicTap {
        QuicTap {
            connections: self.connections,
            frame_tx_datagram: self
                .frame_tx_datagram
                .saturating_sub(base.frame_tx_datagram),
            frame_rx_datagram: self
                .frame_rx_datagram
                .saturating_sub(base.frame_rx_datagram),
            sent_packets: self.sent_packets.saturating_sub(base.sent_packets),
            lost_packets: self.lost_packets.saturating_sub(base.lost_packets),
        }
    }

    fn to_json(self) -> String {
        format!(
            concat!(
                "{{\"connections\":{},\"frameTxDatagram\":{},\"frameRxDatagram\":{},",
                "\"sentPackets\":{},\"lostPackets\":{}}}"
            ),
            self.connections,
            self.frame_tx_datagram,
            self.frame_rx_datagram,
            self.sent_packets,
            self.lost_packets,
        )
    }
}

type ConnRegistry = Arc<Mutex<Vec<quinn::Connection>>>;

fn sample_quic(registry: &ConnRegistry) -> QuicTap {
    let mut tap = QuicTap::default();
    let conns = match registry.lock() {
        Ok(c) => c,
        Err(poisoned) => poisoned.into_inner(),
    };
    for conn in conns.iter() {
        tap.add(&conn.stats());
    }
    tap
}

/// Everything a session task shares with the run.
struct Shared {
    steady: WindowStats,
    steady_drain: WindowStats,
    storm_survivors: WindowStats,
    lifetime: WindowStats,
    sessions: SessionCounters,
    registry: ConnRegistry,
    errors: Mutex<Vec<String>>,
    latencies: Mutex<Vec<u64>>,
    reconnect_latencies: Mutex<Vec<u64>>,
    connect_start_offsets_ns: Mutex<Vec<u64>>,
}

impl Shared {
    fn new(capacity: usize) -> Shared {
        Shared {
            steady: WindowStats::default(),
            steady_drain: WindowStats::default(),
            storm_survivors: WindowStats::default(),
            lifetime: WindowStats::default(),
            sessions: SessionCounters::default(),
            registry: Arc::new(Mutex::new(Vec::with_capacity(capacity))),
            errors: Mutex::new(Vec::new()),
            latencies: Mutex::new(Vec::with_capacity(capacity)),
            reconnect_latencies: Mutex::new(Vec::new()),
            connect_start_offsets_ns: Mutex::new(Vec::with_capacity(capacity)),
        }
    }

    fn record_error(&self, e: String) {
        if let Ok(mut recorded) = self.errors.lock() {
            if recorded.len() < MAX_RECORDED_ERRORS {
                recorded.push(e);
            }
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

type ClientEndpoint = Endpoint<wtransport::endpoint::endpoint_side::Client>;

struct EndpointPool {
    endpoints: Vec<Arc<ClientEndpoint>>,
    distinct_source_ips: usize,
    source_addresses: Vec<SocketAddr>,
}

const LOOPBACK_DISTINCT_IP_ENDPOINT_CAP: usize = 250;
const ENDPOINT_FD_RESERVE: u64 = 64;

fn current_nofile_soft_limit() -> Option<u64> {
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    let status = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) };
    if status != 0 {
        return None;
    }
    let limit = unsafe { limit.assume_init() };
    if limit.rlim_cur == libc::RLIM_INFINITY {
        None
    } else {
        Some(limit.rlim_cur)
    }
}

fn validate_endpoint_configuration(
    count: usize,
    bind_default: bool,
    fixed_source_port_base: Option<u16>,
    nofile_soft_limit: Option<u64>,
) -> Result<(), Box<dyn std::error::Error>> {
    if count == 0 {
        return Err("mmo-client: --endpoints must be a positive integer".into());
    }
    if !bind_default
        && fixed_source_port_base.is_none()
        && count > LOOPBACK_DISTINCT_IP_ENDPOINT_CAP
    {
        return Err(format!(
            "mmo-client: loopback-distinct-IP mode supports at most {LOOPBACK_DISTINCT_IP_ENDPOINT_CAP} endpoints"
        )
        .into());
    }
    if let Some(base) = fixed_source_port_base {
        if base == 0 || usize::from(base).saturating_add(count - 1) > usize::from(u16::MAX) {
            return Err(format!(
                "mmo-client: fixed source port range {base}..+{} exceeds 1..65535",
                count - 1
            )
            .into());
        }
    }
    if let Some(limit) = nofile_soft_limit {
        let required = u64::try_from(count)
            .unwrap_or(u64::MAX)
            .saturating_add(ENDPOINT_FD_RESERVE);
        if required > limit {
            return Err(format!(
                "mmo-client: endpoint file-descriptor preflight requires {required} descriptors but soft limit is {limit}"
            )
            .into());
        }
    }
    Ok(())
}

fn fixed_source_address(base: u16, index: usize) -> Result<SocketAddr, Box<dyn std::error::Error>> {
    let port = usize::from(base)
        .checked_add(index)
        .filter(|port| *port <= usize::from(u16::MAX))
        .ok_or_else(|| "mmo-client: fixed source port range overflow".to_string())?;
    Ok(SocketAddr::new(
        IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        port as u16,
    ))
}

fn connect_start_offset(index: usize, rate_per_sec: u64) -> Duration {
    if rate_per_sec == 0 {
        return Duration::ZERO;
    }
    let nanos = (index as u128)
        .saturating_mul(1_000_000_000u128)
        .checked_div(u128::from(rate_per_sec))
        .unwrap_or(0)
        .min(u128::from(u64::MAX));
    Duration::from_nanos(nanos as u64)
}

fn achieved_connect_start_rate(offsets_ns: &[u64]) -> Option<f64> {
    let first = *offsets_ns.first()?;
    let last = *offsets_ns.last()?;
    if offsets_ns.len() < 2 || last <= first {
        return None;
    }
    Some((offsets_ns.len() - 1) as f64 * 1_000_000_000.0 / (last - first) as f64)
}

#[derive(Debug, PartialEq)]
struct ConnectStartProof {
    offered: usize,
    achieved: usize,
    achieved_rate_per_sec: Option<f64>,
}

impl ConnectStartProof {
    fn from_offsets(offered: usize, offsets_ns: &mut [u64]) -> Self {
        offsets_ns.sort_unstable();
        Self {
            offered,
            achieved: offsets_ns.len(),
            achieved_rate_per_sec: achieved_connect_start_rate(offsets_ns),
        }
    }

    fn to_json(&self) -> String {
        format!(
            "{{\"offered\":{},\"achieved\":{},\"achievedRatePerSec\":{}}}",
            self.offered,
            self.achieved,
            json_num(self.achieved_rate_per_sec),
        )
    }
}

fn endpoint_source_addresses_json(addresses: &[SocketAddr]) -> String {
    addresses
        .iter()
        .map(|address| format!("\"{}\"", escape(&address.to_string())))
        .collect::<Vec<_>>()
        .join(",")
}

fn endpoint_index(session_index: usize, endpoint_count: usize) -> usize {
    session_index % endpoint_count.max(1)
}

fn build_endpoints(
    count: usize,
    bind_default: bool,
    fixed_source_port_base: Option<u16>,
) -> Result<EndpointPool, Box<dyn std::error::Error>> {
    validate_endpoint_configuration(
        count,
        bind_default,
        fixed_source_port_base,
        current_nofile_soft_limit(),
    )?;
    let mut endpoints = Vec::with_capacity(count);
    let mut source_addresses = Vec::with_capacity(count);
    let mut distinct_source_ips = 0usize;
    for k in 0..count {
        let mut endpoint = None;
        if let Some(base) = fixed_source_port_base {
            let addr = fixed_source_address(base, k)?;
            let config = ClientConfig::builder()
                .with_bind_address(addr)
                .with_no_cert_validation()
                .keep_alive_interval(Some(KEEP_ALIVE))
                .max_idle_timeout(Some(MAX_IDLE))?
                .build();
            endpoint = Some(Endpoint::client(config).map_err(|error| {
                format!("mmo-client: fixed source bind {addr} failed: {error}")
            })?);
        } else if count > 1 && !bind_default {
            let octet = u8::try_from(1 + (k % 250)).unwrap_or(1);
            let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, octet, 1)), 0);
            let config = ClientConfig::builder()
                .with_bind_address(addr)
                .with_no_cert_validation()
                .keep_alive_interval(Some(KEEP_ALIVE))
                .max_idle_timeout(Some(MAX_IDLE))?
                .build();
            match Endpoint::client(config) {
                Ok(e) => {
                    distinct_source_ips += 1;
                    endpoint = Some(e);
                }
                Err(e) => eprintln!("mmo-client: bind {addr} failed ({e}); using default bind"),
            }
        }
        let endpoint = match endpoint {
            Some(e) => e,
            None => {
                let config = ClientConfig::builder()
                    .with_bind_default()
                    .with_no_cert_validation()
                    .keep_alive_interval(Some(KEEP_ALIVE))
                    .max_idle_timeout(Some(MAX_IDLE))?
                    .build();
                Endpoint::client(config)?
            }
        };
        source_addresses.push(endpoint.local_addr()?);
        endpoints.push(Arc::new(endpoint));
    }
    Ok(EndpointPool {
        endpoints,
        distinct_source_ips,
        source_addresses,
    })
}

fn spawn_rss_guard() {
    match self_rss_mb() {
        Some(rss) => {
            println!(
                "mmo-client: rss guard armed limitMb={:.0} rssMb={rss:.1}",
                client_rss_limit_mb()
            )
        }
        None => println!("mmo-client: rss guard inactive (no /proc/self/status)"),
    }
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(RSS_GUARD_INTERVAL).await;
            let Some(rss) = self_rss_mb() else { continue };
            if rss > client_rss_limit_mb() {
                println!(
                    "mmo-client: abort client-rss-guard rssMb={rss:.1} limitMb={:.0}",
                    client_rss_limit_mb()
                );
                let _ = std::io::Write::flush(&mut std::io::stdout());
                std::process::exit(EXIT_RSS_GUARD);
            }
        }
    });
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

fn parse_strict<T>(flag: &str, raw: Option<String>) -> Result<T, Box<dyn std::error::Error>>
where
    T: std::str::FromStr,
    <T as std::str::FromStr>::Err: std::fmt::Display,
{
    let value = raw.ok_or_else(|| format!("mmo-client: {flag} requires a value"))?;
    value.parse::<T>().map_err(|error| {
        format!("mmo-client: invalid value for {flag} ('{value}'): {error}").into()
    })
}

fn validate_connect_concurrency(value: usize) -> Result<(), Box<dyn std::error::Error>> {
    if value == 0 {
        Err("mmo-client: --connect-concurrency must be a positive integer".into())
    } else {
        Ok(())
    }
}

fn validate_active_workload_sessions(
    sessions: usize,
    active: Option<usize>,
) -> Result<usize, Box<dyn std::error::Error>> {
    let resolved = active.unwrap_or(sessions);
    if resolved == 0 || resolved > sessions {
        Err(
            format!("mmo-client: --active-sessions must be in 1..={sessions}, got {resolved}")
                .into(),
        )
    } else {
        Ok(resolved)
    }
}

fn session_drives_workload(index: usize, active_workload_sessions: usize) -> bool {
    index < active_workload_sessions
}

fn parse_args() -> Result<Options, Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mut o = Options::defaults();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--role" => {
                let raw = args.next().unwrap_or_default();
                match Role::parse(&raw) {
                    Some(r) => o.role = r,
                    None => eprintln!("mmo-client: unknown --role '{raw}'; using realm"),
                }
            }
            "--url" => o.url = args.next().unwrap_or_else(|| DEFAULT_URL.to_string()),
            "--sessions" => o.sessions = parse_or_default("--sessions", args.next(), o.sessions),
            "--active-sessions" => {
                o.active_workload_sessions = Some(parse_strict("--active-sessions", args.next())?);
            }
            "--endpoints" => {
                o.endpoints = parse_strict("--endpoints", args.next())?;
            }
            "--bind-default" => o.bind_default = true,
            "--fixed-source-port-base" => {
                o.fixed_source_port_base =
                    Some(parse_strict("--fixed-source-port-base", args.next())?);
            }
            "--connect-concurrency" => {
                o.connect_concurrency = parse_strict("--connect-concurrency", args.next())?;
            }
            "--connect-rate-per-sec" => {
                o.connect_rate_per_sec = parse_strict("--connect-rate-per-sec", args.next())?;
            }
            "--steady-secs" => {
                o.steady = Duration::from_secs(parse_or_default(
                    "--steady-secs",
                    args.next(),
                    o.steady.as_secs(),
                ))
            }
            "--drain-ms" => {
                o.drain = Duration::from_millis(parse_or_default(
                    "--drain-ms",
                    args.next(),
                    o.drain.as_millis() as u64,
                ))
            }
            "--idle-secs" => {
                o.idle = Duration::from_secs(parse_or_default(
                    "--idle-secs",
                    args.next(),
                    o.idle.as_secs(),
                ))
            }
            "--send-interval-ms" => {
                o.send_interval = Duration::from_millis(
                    parse_or_default(
                        "--send-interval-ms",
                        args.next(),
                        o.send_interval.as_millis() as u64,
                    )
                    .max(1),
                )
            }
            "--action-every" => {
                o.action_every = parse_or_default("--action-every", args.next(), o.action_every)
            }
            "--payload-bytes" => {
                o.payload_bytes = parse_or_default("--payload-bytes", args.next(), o.payload_bytes)
                    // Every upstream datagram carries a version-3 stamp; a
                    // payload too short to hold one is not a smaller
                    // measurement, it is no measurement.
                    .max(STAMP_BYTES_V3)
            }
            "--connect-timeout-secs" => {
                o.connect_timeout = Duration::from_secs(parse_or_default(
                    "--connect-timeout-secs",
                    args.next(),
                    o.connect_timeout.as_secs(),
                ))
            }
            "--json-out" => o.json_out = args.next(),
            "--preregistration-sha256" => o.pre_registration_sha256 = args.next(),
            "--started-at" => o.started_at = args.next(),
            "--phase-barrier-id" => o.phase_barrier_id = args.next(),
            "--phase-barrier-dir" => o.phase_barrier_dir = args.next(),
            "--phase-barrier-parties" => {
                o.phase_barrier_parties = parse_or_default(
                    "--phase-barrier-parties",
                    args.next(),
                    o.phase_barrier_parties,
                )
            }
            "--phase-barrier-timeout-ms" => {
                o.phase_barrier_timeout = Duration::from_millis(parse_or_default(
                    "--phase-barrier-timeout-ms",
                    args.next(),
                    o.phase_barrier_timeout.as_millis() as u64,
                ))
            }
            "--diagnostic-host-udp" => o.diagnostic_host_udp = true,
            "--no-stagger" => o.stagger_sends = false,
            "--storm-cohort" => {
                o.storm_cohort = parse_or_default("--storm-cohort", args.next(), o.storm_cohort)
            }
            "--storm-reconnect-delay-ms" => {
                o.storm_reconnect_delay = Duration::from_millis(parse_or_default(
                    "--storm-reconnect-delay-ms",
                    args.next(),
                    o.storm_reconnect_delay.as_millis() as u64,
                ))
            }
            "--storm-window-secs" => {
                o.storm_window = Duration::from_secs(parse_or_default(
                    "--storm-window-secs",
                    args.next(),
                    o.storm_window.as_secs(),
                ))
            }
            "--post-storm-secs" => {
                o.post_storm = Duration::from_secs(parse_or_default(
                    "--post-storm-secs",
                    args.next(),
                    o.post_storm.as_secs(),
                ))
            }
            "--storm-concurrency" => {
                o.storm_concurrency =
                    parse_or_default("--storm-concurrency", args.next(), o.storm_concurrency)
            }
            _ => {}
        }
    }
    validate_connect_concurrency(o.connect_concurrency)?;
    validate_active_workload_sessions(o.sessions, o.active_workload_sessions)?;
    validate_endpoint_configuration(
        o.endpoints,
        o.bind_default,
        o.fixed_source_port_base,
        current_nofile_soft_limit(),
    )?;
    Ok(o)
}

fn validate_pre_registration_sha256(
    value: Option<&str>,
) -> Result<String, Box<dyn std::error::Error>> {
    let Some(sha) = value else {
        return Err(
            "mmo-client: --preregistration-sha256 is required for mmo-client/2 reports".into(),
        );
    };
    if sha.len() != 64 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "mmo-client: --preregistration-sha256 must be 64 hex chars, got '{sha}'"
        )
        .into());
    }
    Ok(sha.to_string())
}

fn validate_started_at(value: Option<&str>) -> Result<String, Box<dyn std::error::Error>> {
    let Some(started_at) = value else {
        return Err("mmo-client: --started-at is required for mmo-client/2 reports".into());
    };
    let bytes = started_at.as_bytes();
    let is_digits = |slice: &[u8]| slice.iter().all(u8::is_ascii_digit);
    let parse_u32 =
        |slice: &[u8]| -> Option<u32> { std::str::from_utf8(slice).ok()?.parse::<u32>().ok() };
    let is_leap_year = |year: u32| {
        (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
    };
    let fractional = if bytes.len() == 20 {
        &[][..]
    } else if bytes.len() > 21 && bytes[19] == b'.' {
        &bytes[20..bytes.len() - 1]
    } else {
        &[0u8][..]
    };
    let year = bytes.get(0..4).and_then(parse_u32);
    let month = bytes.get(5..7).and_then(parse_u32);
    let day = bytes.get(8..10).and_then(parse_u32);
    let hour = bytes.get(11..13).and_then(parse_u32);
    let minute = bytes.get(14..16).and_then(parse_u32);
    let second = bytes.get(17..19).and_then(parse_u32);
    let max_day = match month {
        Some(1 | 3 | 5 | 7 | 8 | 10 | 12) => Some(31),
        Some(4 | 6 | 9 | 11) => Some(30),
        Some(2) => Some(if year.is_some_and(is_leap_year) {
            29
        } else {
            28
        }),
        _ => None,
    };
    let valid = bytes.len() >= 20
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && is_digits(&bytes[0..4])
        && is_digits(&bytes[5..7])
        && is_digits(&bytes[8..10])
        && is_digits(&bytes[11..13])
        && is_digits(&bytes[14..16])
        && is_digits(&bytes[17..19])
        && matches!(bytes.last(), Some(b'Z'))
        && (bytes.len() == 20 || (!fractional.is_empty() && is_digits(fractional)))
        && month.is_some_and(|value| (1..=12).contains(&value))
        && day
            .zip(max_day)
            .is_some_and(|(value, limit)| (1..=limit).contains(&value))
        && hour.is_some_and(|value| value <= 23)
        && minute.is_some_and(|value| value <= 59)
        && second.is_some_and(|value| value <= 59);
    if !valid {
        return Err(format!(
            "mmo-client: --started-at must be an RFC3339 UTC timestamp, got '{started_at}'"
        )
        .into());
    }
    Ok(started_at.to_string())
}

#[derive(Clone, Debug)]
struct PhaseBarrierProof {
    id: String,
    role: String,
    parties: usize,
    ready_unix_ms: u64,
    ready_monotonic_ns: u64,
    release_unix_ms: u64,
    release_monotonic_ns: u64,
    steady_enter_unix_ms: u64,
    steady_enter_monotonic_ns: u64,
}

impl PhaseBarrierProof {
    fn to_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"id\":\"{}\",",
                "\"role\":\"{}\",",
                "\"parties\":{},",
                "\"readyUnixMs\":{},",
                "\"readyMonotonicNs\":{},",
                "\"releaseUnixMs\":{},",
                "\"releaseMonotonicNs\":{},",
                "\"steadyEnterUnixMs\":{},",
                "\"steadyEnterMonotonicNs\":{}",
                "}}"
            ),
            escape(&self.id),
            escape(&self.role),
            self.parties,
            self.ready_unix_ms,
            self.ready_monotonic_ns,
            self.release_unix_ms,
            self.release_monotonic_ns,
            self.steady_enter_unix_ms,
            self.steady_enter_monotonic_ns
        )
    }
}

fn unix_now_ms() -> Result<u64, Box<dyn std::error::Error>> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX))
}

fn validate_phase_barrier_component(
    label: &str,
    value: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    if value.is_empty()
        || !value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(
            format!("mmo-client: --{label} must use only [A-Za-z0-9._-], got '{value}'").into(),
        );
    }
    Ok(())
}

async fn wait_for_phase_barrier(
    options: &Options,
) -> Result<Option<PhaseBarrierProof>, Box<dyn std::error::Error>> {
    let Some(id) = options.phase_barrier_id.as_deref() else {
        if options.phase_barrier_dir.is_some() || options.phase_barrier_parties > 0 {
            return Err(
                "mmo-client: --phase-barrier-id is required when phase barrier options are set"
                    .into(),
            );
        }
        return Ok(None);
    };
    let Some(dir) = options.phase_barrier_dir.as_deref() else {
        return Err(
            "mmo-client: --phase-barrier-dir is required when --phase-barrier-id is set".into(),
        );
    };
    if options.phase_barrier_parties == 0 {
        return Err(
            "mmo-client: --phase-barrier-parties must be at least 1 when --phase-barrier-id is set"
                .into(),
        );
    }
    validate_phase_barrier_component("phase-barrier-id", id)?;
    validate_phase_barrier_component("role", options.role.as_str())?;
    fs::create_dir_all(dir)?;
    let dir_path = Path::new(dir);
    let ready_path = dir_path.join(format!("{id}.{}.ready", options.role.as_str()));
    let release_path = dir_path.join(format!("{id}.release"));
    let ready_unix_ms = unix_now_ms()?;
    let ready_monotonic_ns = monotonic_ns();
    fs::write(
        &ready_path,
        format!(
            concat!(
                "role={}\n",
                "parties={}\n",
                "readyUnixMs={}\n",
                "readyMonotonicNs={}\n"
            ),
            options.role.as_str(),
            options.phase_barrier_parties,
            ready_unix_ms,
            ready_monotonic_ns,
        ),
    )?;
    let deadline = Instant::now() + options.phase_barrier_timeout;
    let prefix = format!("{id}.");
    let suffix = ".ready";
    let mut release_unix_ms: Option<u64> = None;
    let mut release_monotonic_ns: Option<u64> = None;
    loop {
        if Instant::now() >= deadline {
            return Err(format!(
                "mmo-client: phase barrier timed out waiting for {}/{}, role={}",
                fs::read_dir(dir_path)?
                    .filter_map(Result::ok)
                    .filter(|entry| {
                        entry
                            .file_name()
                            .to_str()
                            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(suffix))
                    })
                    .count(),
                options.phase_barrier_parties,
                options.role.as_str()
            )
            .into());
        }
        let ready_count = fs::read_dir(dir_path)?
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(suffix))
            })
            .count();
        if ready_count >= options.phase_barrier_parties {
            let release_value = unix_now_ms()?;
            let release_monotonic_value = monotonic_ns();
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&release_path)
            {
                Ok(mut file) => {
                    writeln!(file, "releaseUnixMs={release_value}")?;
                    writeln!(file, "releaseMonotonicNs={release_monotonic_value}")?;
                    release_unix_ms = Some(release_value);
                    release_monotonic_ns = Some(release_monotonic_value);
                    break;
                }
                Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                    let mut buf = String::new();
                    fs::File::open(&release_path)?.read_to_string(&mut buf)?;
                    for line in buf.lines() {
                        if let Some(value) = line.strip_prefix("releaseUnixMs=") {
                            release_unix_ms = value.parse::<u64>().ok();
                        } else if let Some(value) = line.strip_prefix("releaseMonotonicNs=") {
                            release_monotonic_ns = value.parse::<u64>().ok();
                        }
                    }
                    if release_unix_ms.is_some() && release_monotonic_ns.is_some() {
                        break;
                    }
                }
                Err(err) => return Err(Box::new(err)),
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let release_unix_ms = release_unix_ms
        .ok_or("mmo-client: phase barrier release file existed but was unreadable")?;
    let release_monotonic_ns = release_monotonic_ns
        .ok_or("mmo-client: phase barrier release file omitted releaseMonotonicNs")?;
    Ok(Some(PhaseBarrierProof {
        id: id.to_string(),
        role: options.role.as_str().to_string(),
        parties: options.phase_barrier_parties,
        ready_unix_ms,
        ready_monotonic_ns,
        release_unix_ms,
        release_monotonic_ns,
        steady_enter_unix_ms: 0,
        steady_enter_monotonic_ns: 0,
    }))
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = parse_args()?;
    let active_workload_sessions =
        validate_active_workload_sessions(options.sessions, options.active_workload_sessions)?;
    let pre_registration_sha256 =
        validate_pre_registration_sha256(options.pre_registration_sha256.as_deref())?;
    let started_at_iso = validate_started_at(options.started_at.as_deref())?;
    println!(
        "mmo-client: role={} url={} sessions={} activeSessions={} endpoints={} interval={}ms actionEvery={} payload={}B steady={}s drain={}ms storm={}@{}s window={}s concurrency={} stagger={}",
        options.role.as_str(),
        options.url,
        options.sessions,
        active_workload_sessions,
        options.endpoints,
        options.send_interval.as_millis(),
        options.action_every,
        options.payload_bytes,
        options.steady.as_secs(),
        options.drain.as_millis(),
        options.storm_cohort,
        options.steady.as_secs(),
        options.storm_window.as_secs(),
        options.storm_concurrency,
        options.stagger_sends,
    );
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(run(options, pre_registration_sha256, started_at_iso))
}

async fn run(
    options: Options,
    pre_registration_sha256: String,
    started_at_iso: String,
) -> Result<(), Box<dyn std::error::Error>> {
    spawn_rss_guard();
    let active_workload_sessions =
        validate_active_workload_sessions(options.sessions, options.active_workload_sessions)?;
    let EndpointPool {
        endpoints,
        distinct_source_ips,
        source_addresses,
    } = build_endpoints(
        options.endpoints,
        options.bind_default,
        options.fixed_source_port_base,
    )?;
    let shared = Arc::new(Shared::new(options.sessions));
    let permits = Arc::new(Semaphore::new(options.connect_concurrency));
    // Zero means no pool. `Semaphore::new(usize::MAX >> 3)` is tokio's own
    // effectively-unbounded value; using it rather than skipping the acquire
    // keeps one code path, so the storm cannot accidentally take a different
    // one from the connect phase.
    let storm_permits = Arc::new(Semaphore::new(if options.storm_concurrency == 0 {
        Semaphore::MAX_PERMITS
    } else {
        options.storm_concurrency
    }));
    // The channel carries the flip instant beside the phase so every session
    // opens its send window on the driver's clock, not on its own wake-up
    // time: a late wake shows up as honest first-tick lag and skipped ticks
    // instead of silently shrinking the session's offered denominator.
    let (phase_tx, phase_rx) = watch::channel((PHASE_CONNECT, tokio::time::Instant::now()));

    let mut host_udp_samples = HostUdpSamples {
        connect: options.diagnostic_host_udp.then(sample_host_udp).flatten(),
        ..HostUdpSamples::default()
    };

    let cpu0 = self_cpu_ms();
    let connect_started = Instant::now();
    let connect_deadline = connect_started + options.connect_timeout;
    let mut handles = Vec::with_capacity(options.sessions);
    for i in 0..options.sessions {
        let start_offset = connect_start_offset(i, options.connect_rate_per_sec);
        if connect_started + start_offset >= connect_deadline {
            break;
        }
        if !start_offset.is_zero() {
            tokio::time::sleep_until(tokio::time::Instant::from_std(
                connect_started + start_offset,
            ))
            .await;
        }
        let endpoint = Arc::clone(&endpoints[endpoint_index(i, endpoints.len())]);
        let shared = Arc::clone(&shared);
        let permits = Arc::clone(&permits);
        let storm_permits = Arc::clone(&storm_permits);
        let mut phase = phase_rx.clone();
        let options = options.clone();
        let phase_offset =
            if options.stagger_sends && session_drives_workload(i, active_workload_sessions) {
                i as f64 / active_workload_sessions as f64
            } else {
                0.0
            };
        handles.push(tokio::spawn(async move {
            let permit = match permits.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };
            if let Ok(mut offsets) = shared.connect_start_offsets_ns.lock() {
                offsets.push(
                    connect_started
                        .elapsed()
                        .as_nanos()
                        .min(u128::from(u64::MAX)) as u64,
                );
            }
            let started = Instant::now();
            let connected = endpoint.connect(&options.url).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            drop(permit);
            let conn = match connected {
                Ok(conn) => {
                    shared.sessions.ok.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut l) = shared.latencies.lock() {
                        l.push(elapsed_ms);
                    }
                    conn
                }
                Err(e) => {
                    shared.sessions.err.fetch_add(1, Ordering::Relaxed);
                    shared.record_error(e.to_string());
                    shared.sessions.connect_done.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };
            if let Ok(mut live) = shared.registry.lock() {
                live.push(conn.quic_connection().clone());
            }
            shared.sessions.connect_done.fetch_add(1, Ordering::Relaxed);
            hold_session(
                i,
                conn,
                endpoint,
                storm_permits,
                &mut phase,
                &options,
                phase_offset,
                shared.as_ref(),
            )
            .await;
        }));
    }

    let mut connect_timed_out = false;
    loop {
        if shared.sessions.connect_done.load(Ordering::Relaxed) as usize >= options.sessions {
            break;
        }
        if Instant::now() >= connect_deadline {
            connect_timed_out = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if active_workload_sessions < options.sessions {
        tokio::time::sleep(PASSIVE_CLASSIFICATION_SETTLE).await;
    }
    let connect_wall = connect_started.elapsed();
    let cpu_after_connect = self_cpu_ms();
    println!(
        "mmo-client: connect phase done ok={} err={} wall={:.1}s timed_out={}",
        shared.sessions.ok.load(Ordering::Relaxed),
        shared.sessions.err.load(Ordering::Relaxed),
        connect_wall.as_secs_f64(),
        connect_timed_out
    );

    let quic_after_connect = sample_quic(&shared.registry);
    let quic_before_steady = sample_quic(&shared.registry);
    let cpu_before_steady = self_cpu_ms();
    let rss_before_steady = self_rss_mb();
    let mut phase_barrier = wait_for_phase_barrier(&options).await?;
    if let Some(proof) = phase_barrier.as_mut() {
        proof.steady_enter_unix_ms = unix_now_ms()?;
        proof.steady_enter_monotonic_ns = monotonic_ns();
    }
    host_udp_samples.steady = options.diagnostic_host_udp.then(sample_host_udp).flatten();
    let _ = phase_tx.send((PHASE_STEADY, tokio::time::Instant::now()));
    // Phase markers are line-buffered onto stdout so the harness snapshots
    // server-side counters at exactly the boundaries this process uses.
    println!("mmo-client: phase steady");
    tokio::time::sleep(options.steady).await;
    let quic_after_steady = sample_quic(&shared.registry);
    let cpu_after_steady = self_cpu_ms();
    let rss_after_steady = self_rss_mb();
    host_udp_samples.drain = options.diagnostic_host_udp.then(sample_host_udp).flatten();
    let _ = phase_tx.send((PHASE_DRAIN, tokio::time::Instant::now()));
    println!("mmo-client: phase drain");
    tokio::time::sleep(options.drain).await;

    let storm_ran = options.storm_cohort > 0;
    if storm_ran {
        let _ = phase_tx.send((PHASE_STORM, tokio::time::Instant::now()));
        println!("mmo-client: phase storm cohort={}", options.storm_cohort);
        tokio::time::sleep(options.storm_window).await;
        let _ = phase_tx.send((PHASE_POST, tokio::time::Instant::now()));
        println!("mmo-client: phase post-storm");
        tokio::time::sleep(options.post_storm).await;
    }

    host_udp_samples.idle = options.diagnostic_host_udp.then(sample_host_udp).flatten();
    let _ = phase_tx.send((PHASE_IDLE, tokio::time::Instant::now()));
    println!("mmo-client: phase idle");
    tokio::time::sleep(PHASE_SETTLE).await;
    let quic_after_drive = sample_quic(&shared.registry);
    let cpu_after_drive = self_cpu_ms();
    let rss_drive = self_rss_mb();
    tokio::time::sleep(options.idle.saturating_sub(PHASE_SETTLE)).await;
    let cpu_after_idle = self_cpu_ms();
    let rss_idle = self_rss_mb();

    let _ = phase_tx.send((PHASE_STOP, tokio::time::Instant::now()));
    println!("mmo-client: phase stop");
    let join_deadline = Instant::now() + JOIN_TIMEOUT;
    while Instant::now() < join_deadline && handles.iter().any(|h| !h.is_finished()) {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    for h in &handles {
        if !h.is_finished() {
            h.abort();
        }
    }

    let mut accepts = shared
        .latencies
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    accepts.sort_unstable();
    let mut reconnects = shared
        .reconnect_latencies
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    reconnects.sort_unstable();
    let recorded_errors = shared.errors.lock().map(|e| e.clone()).unwrap_or_default();
    let mut connect_start_offsets = shared
        .connect_start_offsets_ns
        .lock()
        .map(|offsets| offsets.clone())
        .unwrap_or_default();
    let connect_start_proof =
        ConnectStartProof::from_offsets(handles.len(), &mut connect_start_offsets);
    let endpoint_source_addresses = endpoint_source_addresses_json(&source_addresses);

    let window_ms = |from: Option<f64>, to: Option<f64>| match (from, to) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let reconnect_total_ms: u64 = reconnects.iter().copied().sum();
    let reconnect_mean_ms = if reconnects.is_empty() {
        None
    } else {
        Some(reconnect_total_ms as f64 / reconnects.len() as f64)
    };
    let host_udp_field = host_udp_json(options.diagnostic_host_udp, &host_udp_samples)
        .map(|json| format!("\"hostUdp\":{json},"))
        .unwrap_or_default();

    let json = format!(
        concat!(
            "{{",
            "\"schema\":\"mmo-client/2\",",
            "\"startedAt\":\"{}\",",
            "\"preRegistration\":{{\"id\":\"{}\",\"path\":\"{}\",\"sha256\":{}}},",
            "\"role\":\"{}\",",
            "\"staggerSends\":{},",
            "\"sessionsRequested\":{},",
            "\"activeWorkloadSessions\":{},",
            "\"sessionsOk\":{},",
            "\"sessionsErr\":{},",
            "\"sessionsLost\":{},",
            "\"connectWallSec\":{:.3},",
            "\"connectTimedOut\":{},",
            "\"connectConcurrency\":{},",
            "\"connectRatePerSec\":{},",
            "\"connectStarts\":{},",
            "\"acceptMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}},",
            "\"storm\":{{\"concurrency\":{},\"cohort\":{},\"ran\":{},\"windowSec\":{},\"reconnectOk\":{},\"reconnectErr\":{},\"reconnectTotalMs\":{},\"reconnectMeanMs\":{},\"reconnectMs\":{{\"p50\":{},\"p90\":{},\"p99\":{},\"max\":{}}}}},",
            "\"phaseBarrier\":{},",
            "\"windows\":{{\"steady\":{},\"steadyDrain\":{},\"stormSurvivors\":{}}},",
            "\"lifetime\":{},",
            "\"quicSteady\":{},",
            "\"quicDrive\":{},",
            "\"client\":{{\"rssMbSteady\":{},\"rssMbDrive\":{},\"rssMbIdle\":{},\"cpuMsConnect\":{},\"cpuMsSteady\":{},\"cpuMsDrive\":{},\"cpuMsIdle\":{},\"endpoints\":{},\"distinctSourceIps\":{},\"endpointSourceAddresses\":[{}]}},",
            "\"config\":{{\"sendIntervalMs\":{},\"actionEvery\":{},\"payloadBytes\":{},\"steadySec\":{},\"drainMs\":{},\"stormWindowSec\":{},\"postStormSec\":{},\"idleSec\":{},\"passiveClassificationSettleMs\":{},\"fixedSourcePortBase\":{},\"bindDefault\":{}}},",
            "{}",
            "\"connectErrorsSample\":[{}]",
            "}}"
        ),
        started_at_iso,
        G6_CLOSEOUT_SPEC_ID,
        G6_CLOSEOUT_SPEC_PATH,
        json_string(Some(pre_registration_sha256.as_str())),
        options.role.as_str(),
        options.stagger_sends,
        options.sessions,
        active_workload_sessions,
        shared.sessions.ok.load(Ordering::Relaxed),
        shared.sessions.err.load(Ordering::Relaxed),
        shared.sessions.lost.load(Ordering::Relaxed),
        connect_wall.as_secs_f64(),
        connect_timed_out,
        options.connect_concurrency,
        options.connect_rate_per_sec,
        connect_start_proof.to_json(),
        json_u64(percentile(&accepts, 0.50)),
        json_u64(percentile(&accepts, 0.90)),
        json_u64(percentile(&accepts, 0.99)),
        json_u64(accepts.last().copied()),
        if options.storm_concurrency == 0 {
            "null".to_string()
        } else {
            options.storm_concurrency.to_string()
        },
        options.storm_cohort,
        storm_ran,
        options.storm_window.as_secs(),
        shared.sessions.reconnect_ok.load(Ordering::Relaxed),
        shared.sessions.reconnect_err.load(Ordering::Relaxed),
        reconnect_total_ms,
        json_num(reconnect_mean_ms),
        json_u64(percentile(&reconnects, 0.50)),
        json_u64(percentile(&reconnects, 0.90)),
        json_u64(percentile(&reconnects, 0.99)),
        json_u64(reconnects.last().copied()),
        phase_barrier
            .as_ref()
            .map(PhaseBarrierProof::to_json)
            .unwrap_or_else(|| "null".to_string()),
        shared.steady.to_json(),
        shared.steady_drain.to_json(),
        shared.storm_survivors.to_json(),
        shared.lifetime.to_json(),
        quic_after_steady.delta(&quic_before_steady).to_json(),
        quic_after_drive.delta(&quic_after_connect).to_json(),
        json_num(rss_after_steady.or(rss_before_steady)),
        json_num(rss_drive),
        json_num(rss_idle),
        json_num(window_ms(cpu0, cpu_after_connect)),
        json_num(window_ms(cpu_before_steady, cpu_after_steady)),
        json_num(window_ms(cpu_after_connect, cpu_after_drive)),
        json_num(window_ms(cpu_after_drive, cpu_after_idle)),
        options.endpoints,
        distinct_source_ips,
        endpoint_source_addresses,
        options.send_interval.as_millis(),
        options.action_every,
        options.payload_bytes,
        options.steady.as_secs(),
        options.drain.as_millis(),
        options.storm_window.as_secs(),
        options.post_storm.as_secs(),
        options.idle.as_secs(),
        if active_workload_sessions < options.sessions {
            PASSIVE_CLASSIFICATION_SETTLE.as_millis()
        } else {
            0
        },
        options
            .fixed_source_port_base
            .map(|port| port.to_string())
            .unwrap_or_else(|| "null".to_string()),
        options.bind_default,
        host_udp_field,
        recorded_errors
            .iter()
            .map(|e| format!("\"{}\"", escape(e)))
            .collect::<Vec<_>>()
            .join(",")
    );

    if let Some(path) = &options.json_out {
        std::fs::write(path, format!("{json}\n"))?;
    }
    println!("mmo-client: json {json}");
    Ok(())
}

/* -------------------------------------------------------------------------- */
/* Session task                                                                */
/* -------------------------------------------------------------------------- */

/// The registered duration of a send window: what the workload contract says
/// this phase offers, and therefore the cap on its due count. A drain flip the
/// session observes late must not stretch the offer, and a session that died
/// early is charged only for the ticks its schedule actually reached.
fn registered_window_duration(kind: SendWindowKind, options: &Options) -> Duration {
    match kind {
        SendWindowKind::Steady => options.steady,
        SendWindowKind::Storm => options.storm_window,
        SendWindowKind::Post => options.post_storm,
    }
}

/// Book this session's share of the offered denominator, once, at the instant
/// it stops sending. The due count is the registered schedule's demand — the
/// wall-clock due capped at the window's registered capacity — and the ticks
/// that demand covers but the ticker never presented before close are booked
/// to the separate unpresented counter, measured here against the session's
/// own processed ledger rather than inferred later from the global counters.
#[allow(clippy::too_many_arguments)]
fn account_window_ticks(
    shared: &Shared,
    track_schedule: bool,
    kind: SendWindowKind,
    started_at: tokio::time::Instant,
    interval: Duration,
    phase_offset: f64,
    severed: bool,
    processed: u64,
    capacity: Option<u64>,
) {
    if !track_schedule {
        return;
    }
    let wall_due = ticks_due_after(started_at.elapsed(), interval, phase_offset);
    let due = capacity.map_or(wall_due, |cap| wall_due.min(cap));
    let unpresented = due.saturating_sub(processed);
    shared.lifetime.record_due(due);
    shared.lifetime.record_unpresented(unpresented);
    match kind {
        SendWindowKind::Steady => {
            shared.steady.record_due(due);
            shared.steady.record_unpresented(unpresented);
        }
        SendWindowKind::Storm if !severed => {
            shared.storm_survivors.record_due(due);
            shared.storm_survivors.record_unpresented(unpresented);
        }
        SendWindowKind::Post | SendWindowKind::Storm => {}
    }
}

#[cfg(test)]
fn window_schedule_accounting(
    elapsed: Duration,
    interval: Duration,
    phase_offset: f64,
    fired: u64,
    skipped: u64,
    processed: u64,
    capacity: Option<u64>,
) -> ScheduleAccounting {
    schedule_accounting(
        elapsed,
        interval,
        phase_offset,
        fired,
        skipped,
        processed,
        capacity,
    )
}

fn open_send_window(
    kind: SendWindowKind,
    options: &Options,
    phase_offset: f64,
    opened_at: tokio::time::Instant,
) -> ActiveSendWindow {
    let interval = options.send_interval;
    // The window starts at the driver's flip instant, shared by every
    // session. A session that wakes late gets its missed ticks presented
    // immediately by the Skip ticker — honest lag and skips — instead of a
    // silently shorter window.
    let started_at = opened_at;
    let offset = first_tick_offset(interval, phase_offset);
    let mut ticker = tokio::time::interval_at(started_at + offset, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let capacity = Some(ticks_due_after(
        registered_window_duration(kind, options),
        interval,
        phase_offset,
    ));
    ActiveSendWindow {
        kind,
        started_at,
        ticker,
        processed: 0,
        capacity,
    }
}

#[allow(clippy::too_many_arguments)]
fn sync_send_window(
    shared: &Shared,
    track_schedule: bool,
    active: &mut Option<ActiveSendWindow>,
    desired: Option<SendWindowKind>,
    options: &Options,
    phase_offset: f64,
    severed: bool,
    opened_at: tokio::time::Instant,
) {
    if active.as_ref().map(|window| window.kind) == desired {
        return;
    }
    if let Some(window) = active.take() {
        account_window_ticks(
            shared,
            track_schedule,
            window.kind,
            window.started_at,
            options.send_interval,
            phase_offset,
            severed,
            window.processed,
            window.capacity,
        );
    }
    if let Some(kind) = desired {
        *active = Some(open_send_window(kind, options, phase_offset, opened_at));
    }
}

#[allow(clippy::too_many_arguments)]
fn record_reconnect_failure(
    shared: &Shared,
    track_schedule: bool,
    active_window: &mut Option<ActiveSendWindow>,
    options: &Options,
    phase_offset: f64,
    severed: bool,
    error: String,
) {
    sync_send_window(
        shared,
        track_schedule,
        active_window,
        None,
        options,
        phase_offset,
        severed,
        tokio::time::Instant::now(),
    );
    shared
        .sessions
        .reconnect_err
        .fetch_add(1, Ordering::Relaxed);
    shared.record_error(error);
}

/// Count an unexpected loss in every applicable population. The deliberate
/// disconnect of a severed storm session is not a loss; every other receive
/// failure is, and a survivor failure must remain visible in S-C1 without
/// borrowing a whole-realm counter.
fn record_session_loss(phase: u8, severed: bool, shared: &Shared) {
    if severed && phase == PHASE_STORM {
        return;
    }
    shared.sessions.lost.fetch_add(1, Ordering::Relaxed);
    shared.lifetime.record_session_loss();
    if phase_records_steady_drain(phase) {
        shared.steady_drain.record_session_loss();
        if phase == PHASE_STEADY {
            shared.steady.record_session_loss();
        }
    }
    if phase_records_storm_survivors(phase, severed) {
        shared.storm_survivors.record_session_loss();
    }
}

/// Fold one received datagram into the right counters and the right histogram.
///
/// Split out of the session loop so the classification — which class was this,
/// does the ack carry a usable token, whose clock is the token on — is one
/// place, and so the "record a round trip measured from zero" mistake has to be
/// made deliberately rather than by omission.
fn record_arrival(payload: &[u8], now_ns: u64, severed: bool, phase: u8, shared: &Shared) {
    let Some(stamp) = read_stamp(payload) else {
        shared.lifetime.record_unstamped();
        if phase_records_steady_drain(phase) {
            shared.steady_drain.record_unstamped();
        }
        if phase_records_storm_survivors(phase, severed) {
            shared.storm_survivors.record_unstamped();
        }
        return;
    };
    shared.lifetime.record_class(stamp.class);
    if phase_records_steady_drain(phase) {
        shared.steady_drain.record_class(stamp.class);
    }
    if phase_records_storm_survivors(phase, severed) {
        shared.storm_survivors.record_class(stamp.class);
    }

    if stamp.class == CLASS_RAID {
        // Publisher and subscriber are two processes on ONE host, so `actual`
        // is a client-clock instant here and the one-way is honest. It is the
        // only one-way this gate can make; the client↔server legs are RTT-only.
        shared
            .lifetime
            .one_way
            .record_signed(now_ns as i64 - stamp.actual_ns as i64);
        if phase_records_steady_drain(phase) {
            shared
                .steady_drain
                .one_way
                .record_signed(now_ns as i64 - stamp.actual_ns as i64);
        }
        if phase_records_storm_survivors(phase, severed) {
            shared
                .storm_survivors
                .one_way
                .record_signed(now_ns as i64 - stamp.actual_ns as i64);
        }
        return;
    }

    if stamp.class != CLASS_ACK {
        return;
    }
    if stamp.echo_actual_ns == 0 {
        // The server did not reflect. Counted, never recorded: a round trip
        // measured from the epoch is not a small number, it is a wrong one.
        shared.lifetime.record_ack_unreflected();
        if phase_records_steady_drain(phase) {
            shared.steady_drain.record_ack_unreflected();
        }
        if phase_records_storm_survivors(phase, severed) {
            shared.storm_survivors.record_ack_unreflected();
        }
        return;
    }
    let rtt = now_ns as i64 - stamp.echo_actual_ns as i64;
    if stamp.hold_ns > 0 {
        shared.lifetime.server_hold.record(stamp.hold_ns);
        if phase_records_steady_drain(phase) {
            shared.steady_drain.server_hold.record(stamp.hold_ns);
        }
        if phase_records_storm_survivors(phase, severed) {
            shared.storm_survivors.server_hold.record(stamp.hold_ns);
        }
    }
    shared.lifetime.rtt.record_signed(rtt);
    if phase_records_steady_drain(phase) {
        shared.steady_drain.rtt.record_signed(rtt);
    }
    if phase_records_storm_survivors(phase, severed) {
        shared.storm_survivors.rtt.record_signed(rtt);
    }
}

#[allow(clippy::too_many_arguments)]
async fn hold_session(
    index: usize,
    conn: wtransport::Connection,
    endpoint: Arc<ClientEndpoint>,
    storm_permits: Arc<Semaphore>,
    phase: &mut watch::Receiver<(u8, tokio::time::Instant)>,
    options: &Options,
    phase_offset: f64,
    shared: &Shared,
) {
    let active_workload_sessions = options.active_workload_sessions.unwrap_or(options.sessions);
    let passive_realm =
        options.role == Role::Realm && !session_drives_workload(index, active_workload_sessions);
    let receive_only = options.role == Role::RaidSubscriber || passive_realm;
    let track_schedule = !receive_only;
    let mut conn = conn;
    let mut payload = vec![b'x'; options.payload_bytes];
    let mut sequence: u64 = 0;
    let mut severed_yet = false;
    let mut active_send_window: Option<ActiveSendWindow> = None;

    // The server has no path or authority to key a role off, so a receive-only
    // session says what it is exactly once. This applies both to raid audience
    // sessions and to the matched-throughput companion's passive realm tail.
    // The marker is sent before measurement and excluded from every rate.
    if receive_only {
        let now = monotonic_ns();
        write_stamp_v3(&mut payload, now, now, 0, CLASS_RAID_JOIN);
        let _ = conn.send_datagram(&payload);
    }

    while phase.borrow().0 == PHASE_CONNECT {
        if phase.changed().await.is_err() {
            return;
        }
    }
    let severed = track_schedule && is_severed(index, options.storm_cohort);
    // A send window whose registered capacity has been fully offered stays
    // closed until the phase moves on; this remembers which kind is spent so
    // the loop does not reopen it against the same phase.
    let mut spent_window: Option<SendWindowKind> = None;

    loop {
        let (current, current_flip) = *phase.borrow();
        if spent_window.is_some() && send_window_kind(current) != spent_window {
            spent_window = None;
        }
        let desired = match send_window_kind(current) {
            kind if kind == spent_window => None,
            kind => kind,
        };
        sync_send_window(
            shared,
            track_schedule,
            &mut active_send_window,
            desired,
            options,
            phase_offset,
            severed,
            current_flip,
        );

        if current == PHASE_STOP {
            break;
        }

        // The storm, from this session's side: sever, wait the retry delay,
        // reconnect. The reconnect goes through a permit pool only if one was
        // configured; the registered configuration has none, so there is no
        // semaphore for Little's law to be measuring.
        if current == PHASE_STORM && severed && !severed_yet {
            severed_yet = true;
            conn.close(SEVER_CLOSE_CODE.into(), b"g6 storm sever");
            tokio::time::sleep(options.storm_reconnect_delay).await;
            let permit = storm_permits.clone().acquire_owned().await.ok();
            let started = Instant::now();
            let reconnected = endpoint.connect(&options.url).await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            drop(permit);
            match reconnected {
                Ok(fresh) => {
                    shared.sessions.reconnect_ok.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut l) = shared.reconnect_latencies.lock() {
                        l.push(elapsed_ms);
                    }
                    if let Ok(mut live) = shared.registry.lock() {
                        live.push(fresh.quic_connection().clone());
                    }
                    conn = fresh;
                }
                Err(e) => {
                    record_reconnect_failure(
                        shared,
                        track_schedule,
                        &mut active_send_window,
                        options,
                        phase_offset,
                        severed,
                        e.to_string(),
                    );
                    return;
                }
            }
            continue;
        }

        // No live send window to poll: receive-only roles, the drain and idle
        // phases, and a window that already offered its registered capacity
        // all wait here for the next phase flip while keeping receives hot.
        if receive_only || active_send_window.is_none() {
            tokio::select! {
                changed = phase.changed() => {
                    if changed.is_err() { break; }
                }
                received = conn.receive_datagram() => {
                    match received {
                        Ok(d) => record_arrival(
                            d.as_ref(), monotonic_ns(), severed, phase.borrow().0, shared,
                        ),
                        Err(_) => {
                            record_session_loss(phase.borrow().0, severed, shared);
                            return;
                        }
                    }
                }
            }
            continue;
        }

        tokio::select! {
            changed = phase.changed() => {
                if changed.is_err() {
                    sync_send_window(
                        shared,
                        track_schedule,
                        &mut active_send_window,
                        None,
                        options,
                        phase_offset,
                        severed,
                        tokio::time::Instant::now(),
                    );
                    break;
                }
            }
            scheduled = active_send_window.as_mut().expect("send window active").ticker.tick() => {
                let (phase_now, flip_now) = *phase.borrow();
                let desired_window = send_window_kind(phase_now);
                let active_kind = active_send_window.as_ref().map(|window| window.kind);
                if desired_window != active_kind {
                    sync_send_window(
                        shared,
                        track_schedule,
                        &mut active_send_window,
                        desired_window,
                        options,
                        phase_offset,
                        severed,
                        flip_now,
                    );
                    continue;
                }
                // The registered window has offered everything it is due:
                // close it and go quiet until the phase moves on.
                let spent = {
                    let window = active_send_window.as_ref().expect("send window active");
                    window.capacity.is_some_and(|cap| window.processed >= cap)
                };
                if spent {
                    spent_window = active_kind;
                    sync_send_window(
                        shared,
                        track_schedule,
                        &mut active_send_window,
                        None,
                        options,
                        phase_offset,
                        severed,
                        flip_now,
                    );
                    continue;
                }
                sequence = sequence.wrapping_add(1);
                // The stamp goes in immediately before the send, so the instant
                // it carries is the actual send instant and nothing this
                // generator does afterwards is charged to the server.
                let observed = tokio::time::Instant::now();
                let actual_ns = monotonic_ns();
                let mut observation =
                    observe_tick(scheduled, observed, actual_ns, options.send_interval);
                let active_kind = {
                    let window = active_send_window
                        .as_mut()
                        .expect("send window active after resync");
                    // The skip count stays inside the window's registered
                    // capacity: ticks past the registered end belong to no
                    // window and must not inflate this one's ledger.
                    if let Some(cap) = window.capacity {
                        let remaining = cap.saturating_sub(window.processed);
                        observation.skipped_ticks =
                            observation.skipped_ticks.min(remaining.saturating_sub(1));
                    }
                    window.processed = window
                        .processed
                        .saturating_add(1)
                        .saturating_add(observation.skipped_ticks);
                    window.kind
                };
                shared.lifetime.record_tick(observation);
                match active_kind {
                    SendWindowKind::Steady => shared.steady.record_tick(observation),
                    SendWindowKind::Storm if !severed => shared.storm_survivors.record_tick(observation),
                    SendWindowKind::Storm | SendWindowKind::Post => {}
                }
                let class = if options.role == Role::Publisher {
                    CLASS_RAID
                } else {
                    class_for_tick(sequence, options.action_every)
                };
                write_stamp_v3(
                    &mut payload,
                    observation.intended_ns,
                    actual_ns,
                    sequence,
                    class,
                );
                let sent_ok = conn.send_datagram(&payload).is_ok();
                shared.lifetime.record_send(sent_ok);
                match active_kind {
                    SendWindowKind::Steady => shared.steady.record_send(sent_ok),
                    SendWindowKind::Storm if !severed => shared.storm_survivors.record_send(sent_ok),
                    SendWindowKind::Storm | SendWindowKind::Post => {}
                };
            }
            received = conn.receive_datagram() => {
                match received {
                    Ok(d) => record_arrival(
                        d.as_ref(), monotonic_ns(), severed, phase.borrow().0, shared,
                    ),
                    Err(_) => {
                        // A session lost mid-drive still offered whatever its
                        // schedule had made due; not accounting for it would
                        // quietly forgive the shortfall. A severed session in
                        // the storm phase is expected to see this and is not
                        // counted as lost.
                        sync_send_window(
                            shared,
                            track_schedule,
                            &mut active_send_window,
                            None,
                            options,
                            phase_offset,
                            severed,
                            tokio::time::Instant::now(),
                        );
                        record_session_loss(current, severed, shared);
                        return;
                    }
                }
            }
        }
    }

    conn.close(0u32.into(), b"g6 run complete");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::latency_probe::{CLASS_ACTION, CLASS_MOVE};

    #[test]
    fn ticks_due_is_stable_across_the_window_edge() {
        // The half-interval offset puts the boundary in the middle of a slot, so
        // a snapshot taken slightly early or late books the same count.
        let interval = Duration::from_millis(250);
        for skew_ms in [-100i64, -1, 0, 1, 100] {
            let elapsed = Duration::from_millis((120_000 + skew_ms) as u64);
            assert_eq!(
                ticks_due_after(elapsed, interval, 0.0),
                480,
                "skew {skew_ms}"
            );
        }
    }

    #[test]
    fn the_registered_upstream_rate_is_what_the_schedule_produces() {
        // 4 pps over a 120 s window, which is the §1.2 figure.
        let due = ticks_due_after(Duration::from_secs(120), Duration::from_millis(250), 0.0);
        assert_eq!(due, 480);
        assert_eq!(due as f64 / 120.0, 4.0);
    }

    #[test]
    fn stagger_spreads_first_ticks_over_one_interval() {
        let interval = Duration::from_millis(250);
        assert_eq!(first_tick_offset(interval, 0.0), Duration::from_millis(125));
        assert_eq!(first_tick_offset(interval, 0.5), Duration::from_millis(250));
        // Fractions outside [0,1] cannot pull a tick before the window.
        assert_eq!(
            first_tick_offset(interval, -1.0),
            Duration::from_millis(125)
        );
        assert_eq!(first_tick_offset(interval, 9.0), Duration::from_millis(375));
    }

    #[test]
    fn every_eighth_tick_is_an_action() {
        // 4 pps movement, one action every 8 ticks = the registered 0.5 pps.
        let actions = (1..=800u64)
            .filter(|s| class_for_tick(*s, 8) == CLASS_ACTION)
            .count();
        assert_eq!(actions, 100);
        assert_eq!(class_for_tick(8, 8), CLASS_ACTION);
        assert_eq!(class_for_tick(9, 8), CLASS_MOVE);
        // Zero disables actions rather than making every tick one.
        assert_eq!(class_for_tick(8, 0), CLASS_MOVE);
    }

    #[test]
    fn shared_protocol_cadence_matches_the_client_schedule() {
        assert_eq!(g6_protocol::action_every_nth_tick(), 8);
        let shared_actions = (1..=800u64)
            .filter(|s| {
                g6_protocol::class_for_tick(*s, g6_protocol::action_every_nth_tick())
                    == CLASS_ACTION
            })
            .count();
        assert_eq!(shared_actions, 100);
    }

    #[test]
    fn the_severed_cohort_is_decided_before_the_run() {
        assert!(is_severed(0, 1000));
        assert!(is_severed(999, 1000));
        assert!(!is_severed(1000, 1000));
        // A cohort of zero severs nobody: the storm arm is off.
        assert!(!is_severed(0, 0));
    }

    #[test]
    fn observe_tick_reports_nonnegative_lag_without_future_deadlines() {
        let interval = Duration::from_millis(250);
        let scheduled = tokio::time::Instant::now();

        let exact = observe_tick(scheduled, scheduled, 1_000_000_000, interval);
        assert_eq!(
            exact,
            TickObservation {
                intended_ns: 1_000_000_000,
                lag_ns: 0,
                skipped_ticks: 0,
            }
        );

        let late_3ms = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(3),
            1_003_000_000,
            interval,
        );
        assert_eq!(late_3ms.lag_ns, 3_000_000);
        assert_eq!(late_3ms.intended_ns, 1_000_000_000);
        assert_eq!(late_3ms.skipped_ticks, 0);

        let half_plus = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(126),
            2_126_000_000,
            interval,
        );
        assert_eq!(half_plus.lag_ns, 126_000_000);
        assert_eq!(half_plus.intended_ns, 2_000_000_000);
        assert_eq!(half_plus.skipped_ticks, 0);

        let two_exact = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(500),
            3_500_000_000,
            interval,
        );
        assert_eq!(two_exact.lag_ns, 500_000_000);
        assert_eq!(two_exact.intended_ns, 3_000_000_000);
        assert_eq!(two_exact.skipped_ticks, 2);

        let two_plus = observe_tick(
            scheduled,
            scheduled + Duration::from_millis(503),
            4_503_000_000,
            interval,
        );
        assert_eq!(two_plus.lag_ns, 503_000_000);
        assert_eq!(two_plus.intended_ns, 4_000_000_000);
        assert_eq!(two_plus.skipped_ticks, 2);

        let saturated = observe_tick(
            scheduled,
            scheduled + Duration::from_secs(1),
            400_000_000,
            interval,
        );
        assert_eq!(saturated.lag_ns, 1_000_000_000);
        assert_eq!(saturated.intended_ns, 0);
        assert_eq!(saturated.skipped_ticks, 4);
    }

    #[test]
    fn schedule_accounting_respects_phase_offset_and_reconciles() {
        let interval = Duration::from_millis(250);
        let aligned = schedule_accounting(Duration::from_millis(600), interval, 0.0, 2, 0, 2, None);
        assert_eq!(
            aligned,
            ScheduleAccounting {
                due: 2,
                fired: 2,
                skipped: 0,
                unpresented: 0,
            }
        );
        assert!(aligned.reconciled());

        let offset = schedule_accounting(Duration::from_millis(600), interval, 1.0, 1, 0, 1, None);
        assert_eq!(
            offset,
            ScheduleAccounting {
                due: 1,
                fired: 1,
                skipped: 0,
                unpresented: 0,
            }
        );
        assert!(offset.reconciled());

        let skipped = schedule_accounting(Duration::from_millis(875), interval, 1.0, 2, 1, 3, None);
        assert_eq!(
            skipped,
            ScheduleAccounting {
                due: 3,
                fired: 2,
                skipped: 1,
                unpresented: 0,
            }
        );
        assert!(skipped.reconciled());
    }

    #[test]
    fn schedule_accounting_measures_the_window_close_boundary_as_unpresented() {
        let interval = Duration::from_millis(250);
        // The wall clock made three ticks due but the session's loop only
        // processed two before the window closed: the remainder is measured
        // as unpresented and the ledger still reconciles exactly.
        let boundary =
            schedule_accounting(Duration::from_millis(800), interval, 0.0, 2, 0, 2, None);
        assert_eq!(
            boundary,
            ScheduleAccounting {
                due: 3,
                fired: 2,
                skipped: 0,
                unpresented: 1,
            }
        );
        assert!(boundary.reconciled());
    }

    #[test]
    fn schedule_accounting_caps_due_at_the_registered_capacity() {
        let interval = Duration::from_millis(250);
        // The drain flip was observed late — the wall clock says 4 ticks —
        // but the registered window only demanded 3; the offer is the
        // registered demand, not the stretched wall clock.
        let capped = schedule_accounting(
            Duration::from_millis(1_100),
            interval,
            0.0,
            3,
            0,
            3,
            Some(3),
        );
        assert_eq!(
            capped,
            ScheduleAccounting {
                due: 3,
                fired: 3,
                skipped: 0,
                unpresented: 0,
            }
        );
        assert!(capped.reconciled());

        // A session that died early is charged only for what its schedule
        // reached, still under the cap.
        let early =
            schedule_accounting(Duration::from_millis(600), interval, 0.0, 1, 0, 1, Some(3));
        assert_eq!(early.due, 2);
        assert_eq!(early.unpresented, 1);
        assert!(early.reconciled());
    }

    #[test]
    fn schedule_accounting_refuses_to_reconcile_an_overfired_ledger() {
        let interval = Duration::from_millis(250);
        // More ticks processed than the registered demand allows: the
        // unpresented remainder saturates at zero rather than going negative,
        // and the ledger must NOT reconcile — that imbalance is a real
        // accounting defect, not a boundary artifact.
        let overfired = schedule_accounting(
            Duration::from_millis(1_100),
            interval,
            0.0,
            5,
            0,
            5,
            Some(3),
        );
        assert_eq!(overfired.due, 3);
        assert_eq!(overfired.unpresented, 0);
        assert!(!overfired.reconciled());
    }

    #[test]
    fn reconnect_failure_books_schedule_before_returning() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let shared = Shared::new(1);
            shared
                .lifetime
                .counters
                .ticks_fired
                .store(3, Ordering::Relaxed);
            shared
                .lifetime
                .counters
                .ticks_skipped
                .store(1, Ordering::Relaxed);
            let mut active_window = Some(ActiveSendWindow {
                kind: SendWindowKind::Storm,
                started_at: tokio::time::Instant::now() - Duration::from_millis(3600),
                ticker: tokio::time::interval(Duration::from_secs(1)),
                processed: 4,
                capacity: None,
            });
            let options = Options {
                send_interval: Duration::from_secs(1),
                ..Options::defaults()
            };

            record_reconnect_failure(
                &shared,
                true,
                &mut active_window,
                &options,
                0.0,
                false,
                "storm reconnect failed".to_string(),
            );

            assert!(active_window.is_none());
            assert_eq!(shared.sessions.reconnect_err.load(Ordering::Relaxed), 1);
            assert_eq!(
                shared.errors.lock().unwrap().as_slice(),
                ["storm reconnect failed"]
            );
            let accounting = ScheduleAccounting {
                due: shared.lifetime.counters.ticks_due.load(Ordering::Relaxed),
                fired: shared.lifetime.counters.ticks_fired.load(Ordering::Relaxed),
                skipped: shared
                    .lifetime
                    .counters
                    .ticks_skipped
                    .load(Ordering::Relaxed),
                unpresented: shared
                    .lifetime
                    .counters
                    .ticks_unpresented
                    .load(Ordering::Relaxed),
            };
            assert_eq!(
                accounting,
                ScheduleAccounting {
                    due: 4,
                    fired: 3,
                    skipped: 1,
                    unpresented: 0,
                }
            );
            assert!(accounting.reconciled());
        });
    }

    #[test]
    fn active_workload_sessions_must_fit_inside_requested_realm() {
        assert!(validate_active_workload_sessions(20_000, Some(10_000)).is_ok());
        assert!(validate_active_workload_sessions(20_000, None).is_ok());
        assert!(validate_active_workload_sessions(20_000, Some(0)).is_err());
        assert!(validate_active_workload_sessions(20_000, Some(20_001)).is_err());
    }

    #[test]
    fn only_the_registered_prefix_drives_companion_workload() {
        assert!(session_drives_workload(0, 10_000));
        assert!(session_drives_workload(9_999, 10_000));
        assert!(!session_drives_workload(10_000, 10_000));
        assert!(!session_drives_workload(19_999, 10_000));
    }

    #[test]
    fn preregistration_sha256_is_required() {
        let err = validate_pre_registration_sha256(None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "mmo-client: --preregistration-sha256 is required for mmo-client/2 reports"
        );
    }

    #[test]
    fn preregistration_sha256_rejects_malformed_values() {
        for raw in [
            "",
            "abc",
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdeg",
        ] {
            let err = validate_pre_registration_sha256(Some(raw)).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("mmo-client: --preregistration-sha256 must be 64 hex chars, got '{raw}'")
            );
        }
    }

    #[test]
    fn preregistration_sha256_accepts_valid_and_is_json_safe() {
        let sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let parsed = validate_pre_registration_sha256(Some(sha)).unwrap();
        assert_eq!(parsed, sha);
        assert_eq!(json_string(Some(parsed.as_str())), format!("\"{sha}\""));
    }

    #[test]
    fn started_at_is_required() {
        let err = validate_started_at(None).unwrap_err();
        assert_eq!(
            err.to_string(),
            "mmo-client: --started-at is required for mmo-client/2 reports"
        );
    }

    #[test]
    fn started_at_rejects_malformed_values() {
        for raw in [
            "",
            "2026-08-24",
            "2026-08-24T08:00:00",
            "2026-08-24 08:00:00Z",
            "2026-08-24T08:00Z",
            "2026-08-24T08:00:00+00:00",
            "2026-99-24T08:00:00Z",
            "2026-02-30T08:00:00Z",
            "2025-02-29T08:00:00Z",
            "2026-08-24T24:00:00Z",
            "2026-08-24T08:60:00Z",
            "2026-08-24T08:00:60Z",
            "not-a-date",
        ] {
            let err = validate_started_at(Some(raw)).unwrap_err();
            assert_eq!(
                err.to_string(),
                format!("mmo-client: --started-at must be an RFC3339 UTC timestamp, got '{raw}'")
            );
        }
    }

    #[test]
    fn started_at_accepts_valid_and_is_json_safe() {
        for raw in ["2026-08-24T08:00:00Z", "2026-08-24T08:00:00.123Z"] {
            let parsed = validate_started_at(Some(raw)).unwrap();
            assert_eq!(parsed, raw);
            assert_eq!(json_string(Some(parsed.as_str())), format!("\"{raw}\""));
        }
    }

    /// The classification the round trip depends on, exercised without a
    /// network: an ack the server forgot to reflect must be *counted*, never
    /// recorded as a round trip measured from the epoch.
    #[test]
    fn an_unreflected_ack_is_counted_and_not_measured() {
        let shared = Shared::new(1);
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        record_arrival(&buf, monotonic_ns(), false, PHASE_STEADY, &shared);
        assert_eq!(shared.lifetime.counters.rx_ack.load(Ordering::Relaxed), 1);
        assert_eq!(
            shared
                .lifetime
                .counters
                .ack_unreflected
                .load(Ordering::Relaxed),
            1
        );
        assert!(shared.steady_drain.rtt.to_json().contains("\"count\":0"));
    }

    #[test]
    fn a_reflected_ack_produces_exactly_one_round_trip_sample() {
        let shared = Shared::new(1);
        let sent_ns = monotonic_ns();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        // The server's half: reflect the client's instant and report its dwell.
        buf[28..36].copy_from_slice(&sent_ns.to_le_bytes());
        buf[36..44].copy_from_slice(&3_000_000u64.to_le_bytes());
        record_arrival(&buf, sent_ns + 12_000_000, false, PHASE_STEADY, &shared);
        let json = shared.steady_drain.rtt.to_json();
        assert!(json.contains("\"count\":1"), "{json}");
        assert!(json.contains("\"negative\":0"), "{json}");
        assert!(shared
            .steady_drain
            .server_hold
            .to_json()
            .contains("\"count\":1"));
        assert_eq!(
            shared
                .lifetime
                .counters
                .ack_unreflected
                .load(Ordering::Relaxed),
            0
        );
    }

    /// §5.3: the survivor clause is computed over the survivor cohort alone.
    /// A severed session's arrivals must not reach the survivor histogram, and a
    /// survivor's must not reach it outside the storm window.
    #[test]
    fn survivor_accounting_excludes_the_severed_cohort() {
        let shared = Shared::new(1);
        let sent_ns = monotonic_ns();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        buf[28..36].copy_from_slice(&sent_ns.to_le_bytes());

        record_arrival(&buf, sent_ns + 1_000_000, true, PHASE_STORM, &shared);
        assert!(shared.storm_survivors.rtt.to_json().contains("\"count\":0"));
        assert_eq!(
            shared
                .storm_survivors
                .counters
                .rx_ack
                .load(Ordering::Relaxed),
            0
        );

        record_arrival(&buf, sent_ns + 1_000_000, false, PHASE_STORM, &shared);
        assert!(shared.storm_survivors.rtt.to_json().contains("\"count\":1"));
        assert_eq!(
            shared
                .storm_survivors
                .counters
                .rx_ack
                .load(Ordering::Relaxed),
            1
        );

        // Outside the storm window a survivor's ack belongs to the steady
        // histogram, not the survivor one.
        record_arrival(&buf, sent_ns + 1_000_000, false, PHASE_STEADY, &shared);
        assert!(shared.storm_survivors.rtt.to_json().contains("\"count\":1"));
        assert!(shared.steady_drain.rtt.to_json().contains("\"count\":1"));
    }

    #[test]
    fn survivor_loss_accounting_excludes_expected_severed_disconnects() {
        let shared = Shared::new(2);

        record_session_loss(PHASE_STORM, true, &shared);
        assert_eq!(shared.sessions.lost.load(Ordering::Relaxed), 0);
        assert_eq!(
            shared
                .storm_survivors
                .counters
                .sessions_lost
                .load(Ordering::Relaxed),
            0
        );

        record_session_loss(PHASE_STORM, false, &shared);
        assert_eq!(shared.sessions.lost.load(Ordering::Relaxed), 1);
        assert_eq!(
            shared
                .storm_survivors
                .counters
                .sessions_lost
                .load(Ordering::Relaxed),
            1
        );
        assert!(shared
            .storm_survivors
            .to_json()
            .contains("\"sessionsLost\":1"));
    }

    #[test]
    fn a_snapshot_is_counted_but_never_timed() {
        // Snapshots are interpolated client-side; the gate's latency clause is
        // on the ack class alone, and mixing them would measure tick wait.
        let shared = Shared::new(1);
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, monotonic_ns(), 1, CLASS_SNAPSHOT);
        record_arrival(&buf, monotonic_ns(), false, PHASE_STEADY, &shared);
        assert_eq!(
            shared.lifetime.counters.rx_snapshot.load(Ordering::Relaxed),
            1
        );
        assert!(shared.steady_drain.rtt.to_json().contains("\"count\":0"));
    }

    #[test]
    fn drain_phase_keeps_receive_accounting_in_steady_drain_window() {
        let shared = Shared::new(1);
        let sent_ns = monotonic_ns();
        let mut buf = [0u8; STAMP_BYTES_V3];
        write_stamp_v3(&mut buf, 0, 0, 1, CLASS_ACK);
        buf[28..36].copy_from_slice(&sent_ns.to_le_bytes());
        buf[36..44].copy_from_slice(&2_000_000u64.to_le_bytes());

        record_arrival(&buf, sent_ns + 9_000_000, false, PHASE_DRAIN, &shared);

        assert_eq!(
            shared.steady_drain.counters.rx_ack.load(Ordering::Relaxed),
            1
        );
        assert_eq!(
            shared
                .steady_drain
                .counters
                .ack_unreflected
                .load(Ordering::Relaxed),
            0
        );
        assert!(shared.steady_drain.rtt.to_json().contains("\"count\":1"));
        assert!(shared.steady.rtt.to_json().contains("\"count\":0"));
        assert_eq!(
            shared
                .storm_survivors
                .counters
                .rx_ack
                .load(Ordering::Relaxed),
            0
        );
    }

    #[test]
    fn schedule_windows_reanchor_after_drain() {
        let interval = Duration::from_millis(250);
        let steady =
            window_schedule_accounting(Duration::from_millis(600), interval, 0.0, 2, 0, 2, None);
        let storm =
            window_schedule_accounting(Duration::from_millis(375), interval, 0.0, 1, 1, 2, None);

        assert_eq!(
            steady,
            ScheduleAccounting {
                due: 2,
                fired: 2,
                skipped: 0,
                unpresented: 0,
            }
        );
        assert_eq!(
            storm,
            ScheduleAccounting {
                due: 2,
                fired: 1,
                skipped: 1,
                unpresented: 0,
            }
        );
        assert!(steady.reconciled());
        assert!(storm.reconciled());
    }

    #[test]
    fn a_foreign_payload_is_counted_as_unstamped() {
        let shared = Shared::new(1);
        record_arrival(&[0u8; 64], monotonic_ns(), false, PHASE_STEADY, &shared);
        assert_eq!(
            shared
                .lifetime
                .counters
                .rx_unstamped
                .load(Ordering::Relaxed),
            1
        );
        assert_eq!(shared.lifetime.counters.rx_other.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn roles_parse_and_round_trip() {
        assert_eq!(Role::parse("realm"), Some(Role::Realm));
        assert_eq!(Role::parse("publisher"), Some(Role::Publisher));
        assert_eq!(Role::parse("raid-subscriber"), Some(Role::RaidSubscriber));
        assert_eq!(Role::parse("nope"), None);
        assert_eq!(Role::Realm.as_str(), "realm");
    }

    #[test]
    fn json_helpers_emit_null_for_missing_values() {
        assert_eq!(json_num(None), "null");
        assert_eq!(json_num(Some(f64::NAN)), "null");
        assert_eq!(json_u64(None), "null");
        assert_eq!(escape("a\"b\\c\nd"), "a\\\"b\\\\c d");
    }

    #[test]
    fn host_udp_parser_selects_only_the_six_diagnostic_counters() {
        let fixture = concat!(
            "Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors IgnoredMulti\n",
            "Udp: 11 12 13 14 15 16 999\n",
        );

        assert_eq!(
            parse_host_udp_counters(fixture),
            Some(HostUdpCounters {
                in_datagrams: 11,
                no_ports: 12,
                in_errors: 13,
                out_datagrams: 14,
                rcvbuf_errors: 15,
                sndbuf_errors: 16,
            })
        );
    }

    #[test]
    fn host_udp_parser_rejects_missing_or_malformed_selected_fields() {
        let missing = concat!(
            "Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors\n",
            "Udp: 11 12 13 14 15\n",
        );
        let malformed = concat!(
            "Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors\n",
            "Udp: 11 12 nope 14 15 16\n",
        );

        assert_eq!(parse_host_udp_counters(missing), None);
        assert_eq!(parse_host_udp_counters(malformed), None);
    }

    #[test]
    fn host_udp_json_is_opt_in_and_phase_complete() {
        let sample = HostUdpCounters {
            in_datagrams: 11,
            no_ports: 12,
            in_errors: 13,
            out_datagrams: 14,
            rcvbuf_errors: 15,
            sndbuf_errors: 16,
        };
        let samples = HostUdpSamples {
            connect: Some(sample),
            steady: Some(sample),
            drain: Some(sample),
            idle: Some(sample),
        };

        assert_eq!(host_udp_json(false, &samples), None);
        assert_eq!(
            host_udp_json(true, &samples),
            Some(concat!(
                "{\"connect\":{\"InDatagrams\":11,\"NoPorts\":12,\"InErrors\":13,\"OutDatagrams\":14,\"RcvbufErrors\":15,\"SndbufErrors\":16},",
                "\"steady\":{\"InDatagrams\":11,\"NoPorts\":12,\"InErrors\":13,\"OutDatagrams\":14,\"RcvbufErrors\":15,\"SndbufErrors\":16},",
                "\"drain\":{\"InDatagrams\":11,\"NoPorts\":12,\"InErrors\":13,\"OutDatagrams\":14,\"RcvbufErrors\":15,\"SndbufErrors\":16},",
                "\"idle\":{\"InDatagrams\":11,\"NoPorts\":12,\"InErrors\":13,\"OutDatagrams\":14,\"RcvbufErrors\":15,\"SndbufErrors\":16}}"
            ).to_string())
        );
    }

    #[test]
    fn percentile_picks_expected_ranks() {
        let sorted = [1u64, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        assert_eq!(percentile(&sorted, 0.50), Some(6));
        assert_eq!(percentile(&sorted, 0.99), Some(10));
        assert_eq!(percentile(&[], 0.5), None);
    }

    fn phase_barrier_options(
        role: Role,
        dir: Option<&str>,
        id: &str,
        parties: usize,
        timeout_ms: u64,
    ) -> Options {
        let mut options = Options::defaults();
        options.role = role;
        options.phase_barrier_id = Some(id.to_string());
        options.phase_barrier_dir = dir.map(str::to_string);
        options.phase_barrier_parties = parties;
        options.phase_barrier_timeout = Duration::from_millis(timeout_ms);
        options
    }

    fn unique_phase_barrier_dir(label: &str) -> String {
        let dir = std::env::temp_dir().join(format!(
            "g6-phase-barrier-{label}-{}-{}",
            std::process::id(),
            monotonic_ns()
        ));
        dir.to_string_lossy().into_owned()
    }

    #[test]
    fn phase_barrier_synchronizes_three_roles_with_shared_release() {
        let dir = unique_phase_barrier_dir("success");
        let id = format!("barrier-{}", monotonic_ns());
        let roles = [Role::Realm, Role::Publisher, Role::RaidSubscriber];
        let mut workers = Vec::new();
        for role in roles {
            let options = phase_barrier_options(role, Some(&dir), &id, 3, 1_000);
            workers.push(std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap();
                rt.block_on(wait_for_phase_barrier(&options))
                    .unwrap()
                    .unwrap()
            }));
        }
        let proofs = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(proofs.len(), 3);
        let first = &proofs[0];
        assert!(first.ready_monotonic_ns > 0);
        assert!(first.release_monotonic_ns > 0);
        assert_eq!(first.steady_enter_unix_ms, 0);
        assert_eq!(first.steady_enter_monotonic_ns, 0);
        let mut seen_roles = proofs
            .iter()
            .map(|proof| proof.role.as_str())
            .collect::<Vec<_>>();
        seen_roles.sort_unstable();
        assert_eq!(seen_roles, vec!["publisher", "raid-subscriber", "realm"]);
        for proof in &proofs {
            assert_eq!(proof.id, id);
            assert_eq!(proof.parties, 3);
            assert_eq!(proof.release_unix_ms, first.release_unix_ms);
            assert_eq!(proof.release_monotonic_ns, first.release_monotonic_ns);
            assert!(proof.ready_unix_ms <= proof.release_unix_ms);
            assert!(proof.ready_monotonic_ns <= proof.release_monotonic_ns);
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn phase_barrier_times_out_when_parties_never_arrive() {
        let dir = unique_phase_barrier_dir("timeout");
        let options = phase_barrier_options(
            Role::Realm,
            Some(&dir),
            &format!("timeout-{}", monotonic_ns()),
            2,
            50,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(wait_for_phase_barrier(&options))
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn phase_barrier_rejects_missing_dir_configuration() {
        let options = phase_barrier_options(
            Role::Realm,
            None,
            &format!("missing-dir-{}", monotonic_ns()),
            3,
            50,
        );
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let err = rt
            .block_on(wait_for_phase_barrier(&options))
            .unwrap_err()
            .to_string();
        assert!(err.contains("phase-barrier-dir is required"), "{err}");
    }

    #[test]
    fn phase_barrier_json_includes_monotonic_fields() {
        let json = PhaseBarrierProof {
            id: "barrier".to_string(),
            role: "realm".to_string(),
            parties: 3,
            ready_unix_ms: 100,
            ready_monotonic_ns: 200,
            release_unix_ms: 300,
            release_monotonic_ns: 400,
            steady_enter_unix_ms: 500,
            steady_enter_monotonic_ns: 600,
        }
        .to_json();
        assert!(json.contains("\"readyMonotonicNs\":200"), "{json}");
        assert!(json.contains("\"releaseMonotonicNs\":400"), "{json}");
        assert!(json.contains("\"steadyEnterMonotonicNs\":600"), "{json}");
    }

    #[test]
    fn endpoint_modes_enforce_caps_port_ranges_and_file_limits() {
        assert!(validate_endpoint_configuration(250, false, None, Some(1024)).is_ok());
        assert!(
            validate_endpoint_configuration(251, false, None, Some(1024))
                .unwrap_err()
                .to_string()
                .contains("loopback-distinct-IP mode supports at most 250")
        );
        assert!(validate_endpoint_configuration(512, true, None, Some(1024)).is_ok());
        assert!(validate_endpoint_configuration(512, false, Some(45_000), Some(1024)).is_ok());
        assert!(
            validate_endpoint_configuration(512, false, Some(65_100), Some(2048))
                .unwrap_err()
                .to_string()
                .contains("port range")
        );
        assert!(validate_endpoint_configuration(512, true, None, Some(550))
            .unwrap_err()
            .to_string()
            .contains("file-descriptor"));
    }

    #[test]
    fn fixed_source_port_mapping_is_stable_and_wildcard_bound() {
        assert_eq!(
            fixed_source_address(45_000, 0).unwrap(),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 45_000),
        );
        assert_eq!(
            fixed_source_address(45_000, 511).unwrap(),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 45_511),
        );
        assert!(fixed_source_address(65_535, 1).is_err());
    }

    #[test]
    fn connect_start_rate_uses_monotonic_exact_offsets() {
        assert_eq!(connect_start_offset(0, 250), Duration::ZERO);
        assert_eq!(connect_start_offset(1, 250), Duration::from_millis(4));
        assert_eq!(
            connect_start_offset(4_999, 250),
            Duration::from_millis(19_996),
        );
        assert_eq!(connect_start_offset(4_999, 0), Duration::ZERO);
        assert_eq!(achieved_connect_start_rate(&[]), None);
        assert_eq!(achieved_connect_start_rate(&[0]), None);
        assert_eq!(
            achieved_connect_start_rate(&[0, 4_000_000, 8_000_000]),
            Some(250.0),
        );

        let mut out_of_order = vec![8_000_000, 0, 4_000_000];
        let proof = ConnectStartProof::from_offsets(3, &mut out_of_order);
        assert_eq!(
            proof,
            ConnectStartProof {
                offered: 3,
                achieved: 3,
                achieved_rate_per_sec: Some(250.0),
            }
        );
        assert_eq!(
            proof.to_json(),
            "{\"offered\":3,\"achieved\":3,\"achievedRatePerSec\":250.000}"
        );
    }

    #[test]
    fn connect_control_values_fail_closed() {
        assert!(validate_connect_concurrency(1).is_ok());
        assert!(validate_connect_concurrency(0)
            .unwrap_err()
            .to_string()
            .contains("positive integer"));
        assert_eq!(
            parse_strict::<u64>("--connect-rate-per-sec", Some("0".into())).unwrap(),
            0
        );
        assert!(parse_strict::<u64>("--connect-rate-per-sec", Some("-1".into())).is_err());
        assert!(parse_strict::<u64>("--connect-rate-per-sec", None).is_err());
    }

    #[test]
    fn endpoint_mapping_serializes_actual_addresses_in_order() {
        let addresses = [
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 45_000),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 45_001),
        ];
        assert_eq!(
            endpoint_source_addresses_json(&addresses),
            "\"0.0.0.0:45000\",\"0.0.0.0:45001\""
        );
    }

    #[test]
    fn endpoint_assignment_remains_round_robin_and_balanced() {
        assert_eq!(endpoint_index(0, 512), 0);
        assert_eq!(endpoint_index(511, 512), 511);
        assert_eq!(endpoint_index(512, 512), 0);
        let mut counts = vec![0usize; 512];
        let endpoint_count = counts.len();
        for session in 0..5_000 {
            counts[endpoint_index(session, endpoint_count)] += 1;
        }
        assert_eq!(
            counts.iter().max().unwrap() - counts.iter().min().unwrap(),
            1
        );
    }

    #[test]
    fn fixed_source_port_collision_is_refused_without_fallback() {
        let held = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        let port = held.local_addr().unwrap().port();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let _guard = runtime.enter();
        let error = match build_endpoints(1, false, Some(port)) {
            Ok(_) => panic!("fixed source port collision unexpectedly succeeded"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("fixed source bind"), "{error}");
    }
}
