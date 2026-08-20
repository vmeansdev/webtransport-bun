//! Standalone SO_TXTIME/EDT proof. No quinn, no wtransport — a plain UDP
//! socket, libc, and std.
//!
//! The sender stamps every datagram with an SCM_TXTIME cmsg on a strict
//! departure grid and asks the kernel to report EDT failures
//! (SOF_TXTIME_REPORT_ERRORS). It then reads the error queue for both the
//! SO_EE_ORIGIN_TXTIME drop reports and — when SO_TIMESTAMPING is available —
//! the software TX timestamps taken as the packet leaves for the driver,
//! which is the honest post-qdisc departure time. Inter-departure statistics
//! come from those timestamps; if timestamping is unavailable the report falls
//! back to userspace submit times and says so in `departure_clock`.
//!
//! `--clump K` gives K packets a single shared txtime. That is the shape a GSO
//! super-buffer has: one departure time for the whole batch. Measuring it is
//! the point — fq cannot space packets inside one txtime, so the clump is the
//! quantum the kernel pacer actually delivers.
//!
//! fq is the qdisc that honors this. Loopback has no fq, so a loopback run
//! measures the syscall path and the granularity of the clock, not pacing.

use std::env;
use std::fs;
use std::process::ExitCode;

const DEFAULT_SIZE: usize = 1200;

struct Args {
    role: String,
    dest: String,
    bind: String,
    count: usize,
    pps: f64,
    clump: usize,
    size: usize,
    lead_ms: u64,
    no_txtime: bool,
    idle_ms: u64,
    out: Option<String>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut a = Args {
            role: "send".into(),
            dest: "127.0.0.1:4499".into(),
            bind: "0.0.0.0:0".into(),
            count: 10_000,
            pps: 50_000.0,
            clump: 1,
            size: DEFAULT_SIZE,
            lead_ms: 20,
            no_txtime: false,
            idle_ms: 2000,
            out: None,
        };
        let argv: Vec<String> = env::args().skip(1).collect();
        let mut i = 0;
        while i < argv.len() {
            let key = argv[i].clone();
            let mut val = || -> Result<String, String> {
                i += 1;
                argv.get(i)
                    .cloned()
                    .ok_or_else(|| format!("{} needs a value", argv[i - 1]))
            };
            match key.as_str() {
                "--role" => a.role = val()?,
                "--dest" => a.dest = val()?,
                "--bind" => a.bind = val()?,
                "--count" => a.count = val()?.parse().map_err(|_| "bad --count")?,
                "--pps" => a.pps = val()?.parse().map_err(|_| "bad --pps")?,
                "--clump" => a.clump = val()?.parse().map_err(|_| "bad --clump")?,
                "--size" => a.size = val()?.parse().map_err(|_| "bad --size")?,
                "--lead-ms" => a.lead_ms = val()?.parse().map_err(|_| "bad --lead-ms")?,
                "--idle-ms" => a.idle_ms = val()?.parse().map_err(|_| "bad --idle-ms")?,
                "--out" => a.out = Some(val()?),
                "--no-txtime" => a.no_txtime = true,
                "--help" | "-h" => return Err(usage()),
                other => return Err(format!("unknown flag {other}\n{}", usage())),
            }
            i += 1;
        }
        if a.no_txtime {
            // The userspace-pacer baseline submits on the grid itself; a lead
            // would just make every packet early.
            a.lead_ms = 0;
        }
        if a.pps <= 0.0 {
            return Err("--pps must be positive".into());
        }
        if a.clump == 0 {
            return Err("--clump must be >= 1".into());
        }
        if a.size < 8 {
            return Err("--size must be >= 8 (sequence header)".into());
        }
        Ok(a)
    }
}

fn usage() -> String {
    "txtime-probe --role send|recv [--dest ip:port] [--bind addr] [--count N]\n\
     \x20            [--pps R] [--clump K] [--size B] [--lead-ms M]\n\
     \x20            [--idle-ms M] [--no-txtime] [--out file.json]"
        .into()
}

fn main() -> ExitCode {
    let args = match Args::parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::from(2);
        }
    };
    match run(&args) {
        Ok(json) => {
            if let Some(path) = &args.out {
                if let Err(e) = fs::write(path, &json) {
                    eprintln!("write {path}: {e}");
                    return ExitCode::from(1);
                }
            }
            println!("{json}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("txtime-probe: {e}");
            ExitCode::from(1)
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn run(args: &Args) -> Result<String, String> {
    Ok(format!(
        "{{\"supported\":false,\"reason\":\"SO_TXTIME is Linux-only\",\"os\":\"{}\",\"role\":\"{}\"}}",
        env::consts::OS,
        json_escape(&args.role)
    ))
}

#[cfg(target_os = "linux")]
fn run(args: &Args) -> Result<String, String> {
    match args.role.as_str() {
        "send" => linux::send(args),
        "recv" => linux::recv(args),
        other => Err(format!("unknown --role {other}")),
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{json_escape, stats_json, Args, Summary};
    use std::collections::HashMap;
    use std::ffi::c_void;
    use std::mem;
    use std::net::UdpSocket;
    use std::os::fd::AsRawFd;
    use std::ptr;

    // uapi/linux/net_tstamp.h + uapi/linux/errqueue.h. Spelled out here so the
    // probe does not depend on which libc release happens to export them.
    const SO_TXTIME: libc::c_int = 61;
    const SCM_TXTIME: libc::c_int = 61;
    const SOF_TXTIME_REPORT_ERRORS: u32 = 1 << 1;
    const SO_EE_ORIGIN_TIMESTAMPING: u8 = 4;
    const SO_EE_ORIGIN_TXTIME: u8 = 6;
    const SO_EE_CODE_TXTIME_INVALID_PARAM: u8 = 1;
    const SO_EE_CODE_TXTIME_MISSED: u8 = 2;
    const SOF_TIMESTAMPING_TX_SOFTWARE: u32 = 1 << 1;
    const SOF_TIMESTAMPING_SOFTWARE: u32 = 1 << 4;
    const SOF_TIMESTAMPING_OPT_ID: u32 = 1 << 7;
    const SOF_TIMESTAMPING_OPT_TSONLY: u32 = 1 << 11;

    #[repr(C)]
    struct SockTxtime {
        clockid: libc::clockid_t,
        flags: u32,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct SockExtendedErr {
        ee_errno: u32,
        ee_origin: u8,
        ee_type: u8,
        ee_code: u8,
        ee_pad: u8,
        ee_info: u32,
        ee_data: u32,
    }

    #[repr(C)]
    struct ScmTimestamping {
        ts: [libc::timespec; 3],
    }

    #[derive(Default)]
    struct ErrCounts {
        invalid_param: u64,
        missed: u64,
        other_txtime: u64,
        other_origin: u64,
    }

    fn read_clock(id: libc::clockid_t) -> u64 {
        let mut ts: libc::timespec = unsafe { mem::zeroed() };
        unsafe { libc::clock_gettime(id, &mut ts) };
        ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
    }

    fn now_ns() -> u64 {
        read_clock(libc::CLOCK_MONOTONIC)
    }

    /// Software TX timestamps come back on CLOCK_REALTIME; the txtime grid is
    /// CLOCK_MONOTONIC. Without this offset the two are ~decades apart.
    fn realtime_minus_monotonic_ns() -> i128 {
        let a = read_clock(libc::CLOCK_MONOTONIC);
        let rt = read_clock(libc::CLOCK_REALTIME);
        let b = read_clock(libc::CLOCK_MONOTONIC);
        i128::from(rt) - i128::from(a / 2 + b / 2)
    }

    fn sleep_ns(ns: u64) {
        let req = libc::timespec {
            tv_sec: (ns / 1_000_000_000) as libc::time_t,
            tv_nsec: (ns % 1_000_000_000) as libc::c_long,
        };
        unsafe { libc::nanosleep(&req, ptr::null_mut()) };
    }

    fn setsockopt<T>(fd: libc::c_int, level: libc::c_int, name: libc::c_int, val: &T) -> bool {
        let rc = unsafe {
            libc::setsockopt(
                fd,
                level,
                name,
                (val as *const T).cast::<c_void>(),
                mem::size_of::<T>() as libc::socklen_t,
            )
        };
        rc == 0
    }

    pub(super) fn send(args: &Args) -> Result<String, String> {
        let sock = UdpSocket::bind(&args.bind).map_err(|e| format!("bind {}: {e}", args.bind))?;
        sock.connect(&args.dest)
            .map_err(|e| format!("connect {}: {e}", args.dest))?;
        let fd = sock.as_raw_fd();

        let txtime_cfg = SockTxtime {
            clockid: libc::CLOCK_MONOTONIC,
            flags: SOF_TXTIME_REPORT_ERRORS,
        };
        let txtime_on = !args.no_txtime && setsockopt(fd, libc::SOL_SOCKET, SO_TXTIME, &txtime_cfg);
        if !args.no_txtime && !txtime_on {
            return Err(format!(
                "SO_TXTIME rejected: {}",
                std::io::Error::last_os_error()
            ));
        }
        // Extended errors are how SO_EE_ORIGIN_TXTIME reports come back at all.
        setsockopt(fd, libc::IPPROTO_IP, libc::IP_RECVERR, &1i32);

        let ts_flags = SOF_TIMESTAMPING_TX_SOFTWARE
            | SOF_TIMESTAMPING_SOFTWARE
            | SOF_TIMESTAMPING_OPT_ID
            | SOF_TIMESTAMPING_OPT_TSONLY;
        let timestamping = setsockopt(fd, libc::SOL_SOCKET, libc::SO_TIMESTAMPING, &ts_flags);

        let gap_ns = (1_000_000_000.0 / args.pps).round() as u64;
        let lead_ns = args.lead_ms * 1_000_000;
        let mut payload = vec![0u8; args.size];

        let mut submit_ns: Vec<u64> = Vec::with_capacity(args.count);
        let mut scheduled_ns: Vec<u64> = Vec::with_capacity(args.count);
        let mut departures: HashMap<u32, u64> = HashMap::new();
        let mut errs = ErrCounts::default();
        let mut send_errors: u64 = 0;

        let clock_offset = realtime_minus_monotonic_ns();
        let base = now_ns() + lead_ns;
        let t0 = now_ns();
        for seq in 0..args.count {
            // One txtime per clump: the GSO super-buffer shape, on purpose.
            let slot = (seq / args.clump) as u64;
            let txtime = base + slot * gap_ns * args.clump as u64;

            let now = now_ns();
            if txtime > now + lead_ns {
                sleep_ns(txtime - now - lead_ns);
            }

            payload[..8].copy_from_slice(&(seq as u64).to_be_bytes());
            let sent = unsafe { send_one(fd, &payload, txtime_on.then_some(txtime)) };
            if sent < 0 {
                send_errors += 1;
            } else {
                submit_ns.push(now_ns());
                scheduled_ns.push(txtime);
            }
            if seq % 512 == 0 {
                unsafe { drain_errqueue(fd, &mut departures, &mut errs) };
            }
        }
        let wall_ns = now_ns() - t0;

        // Let the tail of the grid actually depart before the last drain.
        sleep_ns(lead_ns + 50_000_000);
        unsafe { drain_errqueue(fd, &mut departures, &mut errs) };

        let (dep_series, clock) = if timestamping && departures.len() > 1 {
            let mut ids: Vec<u32> = departures.keys().copied().collect();
            ids.sort_unstable();
            (
                ids.iter()
                    .map(|id| (i128::from(departures[id]) - clock_offset).max(0) as u64)
                    .collect::<Vec<u64>>(),
                "SO_TIMESTAMPING/TX_SOFTWARE (post-qdisc driver handoff, CLOCK_REALTIME rebased onto CLOCK_MONOTONIC)",
            )
        } else {
            (
                submit_ns.clone(),
                "userspace CLOCK_MONOTONIC at sendmsg return (SUBMIT time, not departure)",
            )
        };

        let gaps = diffs(&dep_series);
        let grid_error = if dep_series.len() == scheduled_ns.len() {
            let mut e: Vec<f64> = Vec::with_capacity(dep_series.len());
            for (d, s) in dep_series.iter().zip(scheduled_ns.iter()) {
                e.push(*d as f64 - *s as f64);
            }
            Some(e)
        } else {
            None
        };

        let target_gap_ns = gap_ns * args.clump as u64;
        let mut json = String::from("{\"supported\":true,\"role\":\"send\"");
        json.push_str(&format!(
            ",\"dest\":\"{}\",\"count\":{},\"pps\":{},\"clump\":{},\"size\":{}",
            json_escape(&args.dest),
            args.count,
            args.pps,
            args.clump,
            args.size
        ));
        json.push_str(&format!(
            ",\"txtime_enabled\":{txtime_on},\"timestamping\":{timestamping}\
             ,\"clockid\":\"CLOCK_MONOTONIC\",\"departure_clock\":\"{}\"",
            json_escape(clock)
        ));
        json.push_str(&format!(
            ",\"lead_ms\":{},\"realtime_minus_monotonic_ns\":{}\
             ,\"target_gap_us\":{:.3},\"wall_ms\":{:.3},\"sent\":{},\"send_errors\":{}\
             ,\"departures_reported\":{}",
            args.lead_ms,
            clock_offset,
            target_gap_ns as f64 / 1000.0,
            wall_ns as f64 / 1e6,
            submit_ns.len(),
            send_errors,
            departures.len()
        ));
        json.push_str(&format!(
            ",\"txtime_errors\":{{\"invalid_param\":{},\"missed\":{},\"other_txtime\":{},\"other_origin\":{}}}",
            errs.invalid_param, errs.missed, errs.other_txtime, errs.other_origin
        ));
        json.push_str(",\"inter_departure_us\":");
        json.push_str(&stats_json(&Summary::from_ns(&gaps)));
        if let Some(e) = grid_error {
            json.push_str(",\"grid_error_us\":");
            json.push_str(&stats_json(&Summary::from_signed_ns(&e)));
        }
        json.push('}');
        Ok(json)
    }

    pub(super) fn recv(args: &Args) -> Result<String, String> {
        let sock = UdpSocket::bind(&args.bind).map_err(|e| format!("bind {}: {e}", args.bind))?;
        sock.set_read_timeout(Some(std::time::Duration::from_millis(args.idle_ms)))
            .map_err(|e| format!("set_read_timeout: {e}"))?;
        let mut buf = vec![0u8; 65_536];
        let mut arrivals: Vec<u64> = Vec::with_capacity(args.count);
        let mut seqs: Vec<u64> = Vec::with_capacity(args.count);
        loop {
            match sock.recv(&mut buf) {
                Ok(n) if n >= 8 => {
                    arrivals.push(now_ns());
                    let mut s = [0u8; 8];
                    s.copy_from_slice(&buf[..8]);
                    seqs.push(u64::from_be_bytes(s));
                    if arrivals.len() >= args.count {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break, // idle timeout ends the run
            }
        }
        let highest = seqs.iter().copied().max().map_or(0, |s| s + 1);
        let gaps = diffs(&arrivals);
        let mut json = String::from("{\"supported\":true,\"role\":\"recv\"");
        json.push_str(&format!(
            ",\"bind\":\"{}\",\"received\":{},\"highest_seq_plus_one\":{},\"missing\":{}",
            json_escape(&args.bind),
            arrivals.len(),
            highest,
            highest.saturating_sub(arrivals.len() as u64)
        ));
        json.push_str(",\"arrival_clock\":\"userspace CLOCK_MONOTONIC at recv return\"");
        json.push_str(",\"inter_arrival_us\":");
        json.push_str(&stats_json(&Summary::from_ns(&gaps)));
        json.push('}');
        Ok(json)
    }

    fn diffs(series: &[u64]) -> Vec<u64> {
        series
            .windows(2)
            .map(|w| w[1].saturating_sub(w[0]))
            .collect()
    }

    unsafe fn send_one(fd: libc::c_int, buf: &[u8], txtime: Option<u64>) -> isize {
        let mut iov = libc::iovec {
            iov_base: buf.as_ptr().cast::<c_void>().cast_mut(),
            iov_len: buf.len(),
        };
        let mut cbuf = [0u8; 64];
        let mut msg: libc::msghdr = mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        if let Some(t) = txtime {
            msg.msg_control = cbuf.as_mut_ptr().cast::<c_void>();
            msg.msg_controllen = libc::CMSG_SPACE(8) as _;
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = SCM_TXTIME;
            (*cmsg).cmsg_len = libc::CMSG_LEN(8) as _;
            ptr::copy_nonoverlapping(
                ptr::addr_of!(t).cast::<u8>(),
                libc::CMSG_DATA(cmsg),
                mem::size_of::<u64>(),
            );
        }
        libc::sendmsg(fd, &msg, 0)
    }

    /// Reads everything queued on MSG_ERRQUEUE: TX timestamps (paired with
    /// their OPT_ID sequence) and SO_EE_ORIGIN_TXTIME drop reports.
    unsafe fn drain_errqueue(
        fd: libc::c_int,
        departures: &mut HashMap<u32, u64>,
        errs: &mut ErrCounts,
    ) {
        let mut data = [0u8; 64];
        loop {
            let mut iov = libc::iovec {
                iov_base: data.as_mut_ptr().cast::<c_void>(),
                iov_len: data.len(),
            };
            let mut cbuf = [0u8; 512];
            let mut msg: libc::msghdr = mem::zeroed();
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = cbuf.as_mut_ptr().cast::<c_void>();
            msg.msg_controllen = cbuf.len() as _;

            let n = libc::recvmsg(fd, &mut msg, libc::MSG_ERRQUEUE | libc::MSG_DONTWAIT);
            if n < 0 {
                return;
            }

            let mut ts_ns: Option<u64> = None;
            let mut ee: Option<SockExtendedErr> = None;
            let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
            while !cmsg.is_null() {
                let level = (*cmsg).cmsg_level;
                let ctype = (*cmsg).cmsg_type;
                let payload = libc::CMSG_DATA(cmsg);
                if level == libc::SOL_SOCKET && ctype == libc::SCM_TIMESTAMPING {
                    let mut t: ScmTimestamping = mem::zeroed();
                    ptr::copy_nonoverlapping(
                        payload,
                        ptr::addr_of_mut!(t).cast::<u8>(),
                        mem::size_of::<ScmTimestamping>(),
                    );
                    let sw = t.ts[0];
                    if sw.tv_sec != 0 || sw.tv_nsec != 0 {
                        ts_ns = Some(sw.tv_sec as u64 * 1_000_000_000 + sw.tv_nsec as u64);
                    }
                } else if (level == libc::IPPROTO_IP && ctype == libc::IP_RECVERR)
                    || (level == libc::IPPROTO_IPV6 && ctype == libc::IPV6_RECVERR)
                {
                    let mut e: SockExtendedErr = mem::zeroed();
                    ptr::copy_nonoverlapping(
                        payload,
                        ptr::addr_of_mut!(e).cast::<u8>(),
                        mem::size_of::<SockExtendedErr>(),
                    );
                    ee = Some(e);
                }
                cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
            }

            match ee {
                Some(e) if e.ee_origin == SO_EE_ORIGIN_TXTIME => match e.ee_code {
                    SO_EE_CODE_TXTIME_INVALID_PARAM => errs.invalid_param += 1,
                    SO_EE_CODE_TXTIME_MISSED => errs.missed += 1,
                    _ => errs.other_txtime += 1,
                },
                Some(e) if e.ee_origin == SO_EE_ORIGIN_TIMESTAMPING => {
                    if let Some(t) = ts_ns {
                        departures.insert(e.ee_data, t);
                    }
                }
                Some(_) => errs.other_origin += 1,
                None => {}
            }
        }
    }
}

/// Microsecond summary of a sample series.
#[derive(Debug, Default, PartialEq)]
pub struct Summary {
    n: usize,
    mean: f64,
    stddev: f64,
    min: f64,
    p50: f64,
    p90: f64,
    p99: f64,
    max: f64,
}

impl Summary {
    #[allow(dead_code)]
    fn from_ns(samples: &[u64]) -> Self {
        let us: Vec<f64> = samples.iter().map(|v| *v as f64 / 1000.0).collect();
        Self::from_us(us)
    }

    #[allow(dead_code)]
    fn from_signed_ns(samples: &[f64]) -> Self {
        Self::from_us(samples.iter().map(|v| v / 1000.0).collect())
    }

    fn from_us(mut us: Vec<f64>) -> Self {
        if us.is_empty() {
            return Self::default();
        }
        let n = us.len();
        let mean = us.iter().sum::<f64>() / n as f64;
        let var = us.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>() / n as f64;
        us.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        Summary {
            n,
            mean,
            stddev: var.sqrt(),
            min: us[0],
            p50: percentile(&us, 0.50),
            p90: percentile(&us, 0.90),
            p99: percentile(&us, 0.99),
            max: us[n - 1],
        }
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = ((p * sorted.len() as f64).ceil() as usize).max(1) - 1;
    sorted[idx.min(sorted.len() - 1)]
}

#[allow(dead_code)]
fn stats_json(s: &Summary) -> String {
    format!(
        "{{\"n\":{},\"mean\":{:.3},\"stddev\":{:.3},\"min\":{:.3},\"p50\":{:.3},\"p90\":{:.3},\"p99\":{:.3},\"max\":{:.3}}}",
        s.n, s.mean, s.stddev, s.min, s.p50, s.p90, s.p99, s.max
    )
}

fn json_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_pick_the_expected_samples() {
        let s: Vec<f64> = (1..=100).map(f64::from).collect();
        assert_eq!(percentile(&s, 0.50), 50.0);
        assert_eq!(percentile(&s, 0.90), 90.0);
        assert_eq!(percentile(&s, 0.99), 99.0);
        assert_eq!(percentile(&[], 0.5), 0.0);
    }

    #[test]
    fn summary_converts_nanoseconds_to_microseconds() {
        let s = Summary::from_ns(&[1_000, 2_000, 3_000]);
        assert_eq!(s.n, 3);
        assert!((s.mean - 2.0).abs() < 1e-9);
        assert!((s.min - 1.0).abs() < 1e-9);
        assert!((s.max - 3.0).abs() < 1e-9);
    }

    #[test]
    fn empty_summary_is_all_zero() {
        assert_eq!(Summary::from_ns(&[]), Summary::default());
    }

    #[test]
    fn json_escaping_survives_quotes() {
        assert_eq!(json_escape("a\"b\\c"), "a\\\"b\\\\c");
    }
}
