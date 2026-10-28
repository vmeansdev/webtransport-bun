//! Fixed-storage diagnostic primitives. These are not transport budgets.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

const PHASE_COUNT: usize = 5; // unarmed, connect, steady, drain, idle
const BUCKET_COUNT: usize = 32; // 31 finite bounds, then overflow
const GAUGE_BITS: u32 = 30;
const GAUGE_MASK: u64 = (1 << GAUGE_BITS) - 1;
const EXCLUSIVE: u64 = 1 << 63;
const CLOSED: u64 = 1 << 62;
// Control cuts hold the gate only for fixed-size updates and cut metadata,
// never JSON, I/O or waiting for another component. A scheduling stall invalidates diagnostics rather than
// imposing an unbounded wait on transport work.
const MAX_MUTATION_SPINS: usize = 10_000;

#[derive(Default)]
struct PhaseHistogram {
    buckets: [AtomicU64; BUCKET_COUNT],
    crossed_phase: AtomicU64,
    outstanding: AtomicU64,
    censored: AtomicU64,
    rejected: AtomicU64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistogramSnapshot {
    count: u64,
    buckets: Vec<u64>,
    crossed_phase: u64,
    outstanding: u64,
    censored: u64,
    rejected: u64,
    overflow: u64,
}

impl PhaseHistogram {
    fn observe(&self, ns: u64, crossed: bool) {
        // Integer ceil(log2(ns / 1000)); exactly one bucket update per event.
        let bucket = if ns <= 1_000 {
            0
        } else {
            (64 - ((ns - 1) / 1_000).leading_zeros()) as usize
        }
        .min(BUCKET_COUNT - 1);
        self.buckets[bucket].fetch_add(1, Ordering::Relaxed);
        if crossed {
            self.crossed_phase.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn started(&self) {
        self.outstanding.fetch_add(1, Ordering::Relaxed);
    }

    fn completed(&self, ns: u64, crossed: bool) {
        self.observe(ns, crossed);
        self.outstanding.fetch_sub(1, Ordering::Release);
    }

    fn snapshot(&self) -> HistogramSnapshot {
        let outstanding = self.outstanding.load(Ordering::Acquire);
        let buckets: Vec<u64> = self
            .buckets
            .iter()
            .map(|count| count.load(Ordering::Relaxed))
            .collect();
        HistogramSnapshot {
            count: buckets.iter().sum(),
            overflow: buckets[BUCKET_COUNT - 1],
            buckets,
            outstanding,
            crossed_phase: self.crossed_phase.load(Ordering::Relaxed),
            censored: self.censored.load(Ordering::Relaxed),
            rejected: self.rejected.load(Ordering::Relaxed),
        }
    }
}

/// Counts diagnostic ownership reservations, not the internal channel length.
/// The same CAS linearizes live count, current phase and its high-water mark.
/// Phase transitions/readout are serialized by the component registry; packet
/// updates do not take that lock. Finished phase maxima are never reset/deltaed.
#[derive(Default)]
struct PhaseGauge {
    state: AtomicU64,
    sealed_high_water: [AtomicU64; PHASE_COUNT],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GaugeSnapshot {
    current: u64,
    phase: usize,
    phase_high_water: Vec<u64>,
}

impl PhaseGauge {
    fn advance(&self, next_phase: usize) -> Result<(), &'static str> {
        let mut old = self.state.load(Ordering::Acquire);
        loop {
            let phase = (old >> (2 * GAUGE_BITS)) as usize;
            if phase == next_phase {
                return Ok(());
            }
            if next_phase != phase + 1 || next_phase >= PHASE_COUNT {
                return Err("diagnostic gauge phase must advance by one");
            }
            let current = old & GAUGE_MASK;
            let high_water = (old >> GAUGE_BITS) & GAUGE_MASK;
            let next =
                ((next_phase as u64) << (2 * GAUGE_BITS)) | (current << GAUGE_BITS) | current;
            match self
                .state
                .compare_exchange_weak(old, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => {
                    self.sealed_high_water[phase].store(high_water, Ordering::Release);
                    return Ok(());
                }
                Err(actual) => old = actual,
            }
        }
    }

    fn change(&self, delta: i64) -> Result<(), &'static str> {
        let mut old = self.state.load(Ordering::Acquire);
        loop {
            let current = old & GAUGE_MASK;
            let next_count = current
                .checked_add_signed(delta)
                .filter(|&value| value <= GAUGE_MASK)
                .ok_or("diagnostic ownership gauge underflow/overflow")?;
            let next_max = ((old >> GAUGE_BITS) & GAUGE_MASK).max(next_count);
            let next = (old & !(GAUGE_MASK | (GAUGE_MASK << GAUGE_BITS)))
                | (next_max << GAUGE_BITS)
                | next_count;
            match self
                .state
                .compare_exchange_weak(old, next, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return Ok(()),
                Err(actual) => old = actual,
            }
        }
    }

    fn snapshot(&self) -> GaugeSnapshot {
        let state = self.state.load(Ordering::Acquire);
        let phase = (state >> (2 * GAUGE_BITS)) as usize;
        let mut phase_high_water: Vec<u64> = self
            .sealed_high_water
            .iter()
            .map(|value| value.load(Ordering::Acquire))
            .collect();
        phase_high_water[phase] = (state >> GAUGE_BITS) & GAUGE_MASK;
        GaugeSnapshot {
            current: state & GAUGE_MASK,
            phase,
            phase_high_water,
        }
    }
}

const PHASE_NAMES: [&str; PHASE_COUNT] = ["unarmed", "connect", "steady", "drain", "idle"];
const INTERVAL_NAMES: [&str; 5] = [
    "reflectQueueWait",
    "reflectSendCall",
    "ringFull",
    "flusherEagain",
    "udpQueueWait",
];
const GAUGE_NAMES: [&str; 4] = [
    "reflectReservedSlots",
    "udpPendingPackets",
    "udpPendingBytes",
    "waiterRegistrations",
];
const MAX_COMPONENTS: usize = 64;

#[derive(Clone, Copy)]
pub(crate) enum IntervalKind {
    ReflectQueueWait,
    ReflectSendCall,
    RingFull,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    FlusherEagain,
    UdpQueueWait,
}
#[derive(Clone, Copy)]
pub(crate) enum GaugeKind {
    ReflectReservedSlots,
    UdpPendingPackets,
    UdpPendingBytes,
    WaiterRegistrations,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseCut {
    phase: &'static str,
    begin_ns: String,
    end_ns: String,
}
#[derive(Serialize)]
struct NamedHistogram {
    name: &'static str,
    histogram: HistogramSnapshot,
}
#[derive(Serialize)]
struct NamedGauge {
    name: &'static str,
    gauge: GaugeSnapshot,
}
#[derive(Serialize)]
struct PhaseSnapshot {
    phase: &'static str,
    intervals: Vec<NamedHistogram>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentSnapshot {
    kind: &'static str,
    phase: &'static str,
    created_ns: String,
    created_phase: &'static str,
    errors: u64,
    cuts: Vec<PhaseCut>,
    phases: Vec<PhaseSnapshot>,
    gauges: Vec<NamedGauge>,
}

/// One reflector sender or socket owns these cache lines, not a global packet
/// histogram. Hot observations use a per-component atomic mutation gate. A
/// control cut is exclusive with those short mutations, not interval lifetimes.
pub(crate) struct Component {
    kind: &'static str,
    created_ns: u64,
    created_phase: usize,
    phase: AtomicU64,
    activity: AtomicU64,
    errors: AtomicU64,
    intervals: [[PhaseHistogram; 5]; PHASE_COUNT],
    gauges: [PhaseGauge; 4],
    cuts: Mutex<Vec<PhaseCut>>,
}

struct Mutation<'a>(&'a Component);
impl Drop for Mutation<'_> {
    fn drop(&mut self) {
        self.0.activity.fetch_sub(1, Ordering::Release);
    }
}
struct Exclusive<'a> {
    component: &'a Component,
    sealed: bool,
}
impl Exclusive<'_> {
    fn seal(mut self) {
        self.sealed = true;
        self.component.activity.store(CLOSED, Ordering::Release);
    }
}
impl Drop for Exclusive<'_> {
    fn drop(&mut self) {
        if !self.sealed {
            self.component.activity.store(0, Ordering::Release);
        }
    }
}

impl Component {
    #[cfg(test)]
    pub(crate) fn test_armed(kind: &'static str) -> Arc<Self> {
        Arc::new(Self::new_at(kind, 1))
    }

    #[cfg(test)]
    pub(crate) fn test_snapshot(&self) -> serde_json::Value {
        serde_json::to_value(self.snapshot()).unwrap()
    }

    #[cfg(test)]
    pub(crate) fn test_advance(&self, phase: usize) {
        self.advance(phase, now_ns()).unwrap();
    }
    #[cfg(test)]
    fn new(kind: &'static str) -> Self {
        Self::new_at(kind, 0)
    }

    fn new_at(kind: &'static str, phase: usize) -> Self {
        assert!(phase < PHASE_COUNT);
        Self {
            kind,
            created_ns: now_ns(),
            created_phase: phase,
            phase: AtomicU64::new(phase as u64),
            activity: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            intervals: std::array::from_fn(|_| std::array::from_fn(|_| PhaseHistogram::default())),
            gauges: std::array::from_fn(|_| PhaseGauge {
                state: AtomicU64::new((phase as u64) << (2 * GAUGE_BITS)),
                ..PhaseGauge::default()
            }),
            cuts: Mutex::new(Vec::with_capacity(4)),
        }
    }

    fn mutation(&self) -> Option<Mutation<'_>> {
        let mut old = self.activity.load(Ordering::Acquire);
        for _ in 0..MAX_MUTATION_SPINS {
            if old & CLOSED != 0 {
                break;
            }
            if old & EXCLUSIVE == 0 {
                match self.activity.compare_exchange_weak(
                    old,
                    old + 1,
                    Ordering::Acquire,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => return Some(Mutation(self)),
                    Err(actual) => {
                        old = actual;
                        continue;
                    }
                }
            }
            std::hint::spin_loop();
            old = self.activity.load(Ordering::Acquire);
        }
        self.errors.fetch_add(1, Ordering::Relaxed);
        None
    }

    // A busy control cut is retried by the bounded harness; it never waits while
    // holding another component's gate. CAS, rather than an observed zero,
    // linearizes the cut with starts, reservations and releases.
    fn try_exclusive(&self) -> Result<Exclusive<'_>, &'static str> {
        self.activity
            .compare_exchange(0, EXCLUSIVE, Ordering::Acquire, Ordering::Relaxed)
            .map(|_| Exclusive {
                component: self,
                sealed: false,
            })
            .map_err(|_| "native diagnostic cut busy; retry within the boundary deadline")
    }

    #[cfg(test)]
    fn advance(&self, phase: usize, begin_ns: u64) -> Result<(), &'static str> {
        let _cut = self.try_exclusive()?;
        self.advance_exclusive(phase, begin_ns)
    }

    // Caller owns the exclusive mutation gate and registry control lock. The
    // bracket is the real cut latency, not a fabricated simultaneous host time.
    fn advance_exclusive(&self, phase: usize, begin_ns: u64) -> Result<(), &'static str> {
        let previous = self.phase.load(Ordering::Acquire) as usize;
        if phase == previous {
            return Ok(());
        }
        if phase != previous + 1 || phase >= PHASE_COUNT {
            return Err("native diagnostic phase is out of order");
        }
        for gauge in &self.gauges {
            gauge.advance(phase)?;
        }
        self.phase.store(phase as u64, Ordering::Release);
        self.cuts.lock().expect("diagnostic cuts").push(PhaseCut {
            phase: PHASE_NAMES[phase],
            begin_ns: begin_ns.to_string(),
            end_ns: now_ns().max(begin_ns).to_string(),
        });
        Ok(())
    }

    fn start_at(self: &Arc<Self>, kind: IntervalKind, ns: u64) -> Option<Interval> {
        let _mutation = self.mutation()?;
        let phase = self.phase.load(Ordering::Acquire) as usize;
        if phase == 0 {
            return None;
        }
        self.intervals[phase][kind as usize].started();
        Some(Interval {
            owner: Arc::clone(self),
            phase,
            kind,
            started_ns: ns,
            finished: false,
        })
    }

    pub(crate) fn start(self: &Arc<Self>, kind: IntervalKind) -> Option<Interval> {
        self.start_at(kind, now_ns())
    }

    pub(crate) fn change_gauge(&self, kind: GaugeKind, delta: i64) {
        let mutation = self.mutation();
        if mutation.is_none() && delta >= 0 {
            return;
        }
        // Even invalidated diagnostics must release already-owned reservations.
        // Failure to enter the gate is counted above, so this cannot prove a pass.
        if self.gauges[kind as usize].change(delta).is_err() {
            self.errors.fetch_add(1, Ordering::Relaxed);
        }
    }

    pub(crate) fn reserve(self: &Arc<Self>, kind: GaugeKind, amount: i64) -> Option<Reservation> {
        let _mutation = self.mutation()?;
        if amount <= 0 || self.gauges[kind as usize].change(amount).is_err() {
            self.errors.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        Some(Reservation {
            owner: Arc::clone(self),
            kind,
            amount,
        })
    }

    fn quiescent(&self) -> bool {
        self.gauges
            .iter()
            .all(|gauge| gauge.snapshot().current == 0)
            && self
                .intervals
                .iter()
                .flatten()
                .all(|hist| hist.outstanding.load(Ordering::Acquire) == 0)
    }

    fn snapshot(&self) -> ComponentSnapshot {
        ComponentSnapshot {
            kind: self.kind,
            phase: PHASE_NAMES[self.phase.load(Ordering::Acquire) as usize],
            created_ns: self.created_ns.to_string(),
            created_phase: PHASE_NAMES[self.created_phase],
            errors: self.errors.load(Ordering::Acquire),
            cuts: self.cuts.lock().expect("diagnostic cuts").clone(),
            phases: (1..PHASE_COUNT)
                .map(|phase| PhaseSnapshot {
                    phase: PHASE_NAMES[phase],
                    intervals: INTERVAL_NAMES
                        .iter()
                        .enumerate()
                        .map(|(kind, &name)| NamedHistogram {
                            name,
                            histogram: self.intervals[phase][kind].snapshot(),
                        })
                        .collect(),
                })
                .collect(),
            gauges: GAUGE_NAMES
                .iter()
                .enumerate()
                .map(|(kind, &name)| NamedGauge {
                    name,
                    gauge: self.gauges[kind].snapshot(),
                })
                .collect(),
        }
    }
}

/// Owned operation timing. An unfinished drop is censored, never a zero sample.
pub(crate) struct Interval {
    owner: Arc<Component>,
    phase: usize,
    kind: IntervalKind,
    started_ns: u64,
    finished: bool,
}
impl Interval {
    fn finish_at(mut self, end_ns: u64) {
        let mutation = self.owner.mutation();
        if let Some(ns) = end_ns.checked_sub(self.started_ns) {
            self.owner.intervals[self.phase][self.kind as usize].completed(
                ns,
                self.owner.phase.load(Ordering::Acquire) as usize != self.phase,
            );
            self.finished = true;
        } else {
            self.owner.errors.fetch_add(1, Ordering::Relaxed);
        }
        drop(mutation);
    }
    pub(crate) fn finish(self) {
        self.finish_at(now_ns());
    }
    pub(crate) fn reject(mut self) {
        let _mutation = self.owner.mutation();
        let bank = &self.owner.intervals[self.phase][self.kind as usize];
        bank.rejected.fetch_add(1, Ordering::Relaxed);
        bank.outstanding.fetch_sub(1, Ordering::Release);
        self.finished = true;
    }
}
impl Drop for Interval {
    fn drop(&mut self) {
        if !self.finished {
            let _mutation = self.owner.mutation();
            let bank = &self.owner.intervals[self.phase][self.kind as usize];
            bank.censored.fetch_add(1, Ordering::Relaxed);
            bank.outstanding.fetch_sub(1, Ordering::Release);
        }
    }
}

pub(crate) struct Reservation {
    owner: Arc<Component>,
    kind: GaugeKind,
    amount: i64,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.owner.change_gauge(self.kind, -self.amount);
    }
}

pub(crate) fn now_ns() -> u64 {
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    ORIGIN
        .get_or_init(Instant::now)
        .elapsed()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}

fn parse_enabled(raw: Option<&str>) -> Result<bool, &'static str> {
    match raw.map(str::trim) {
        None | Some("") | Some("0") => Ok(false),
        Some("1") => Ok(true),
        _ => Err("WEBTRANSPORT_NATIVE_SEND_PATH_DIAGNOSTICS must be 0 or 1"),
    }
}
pub(crate) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        match parse_enabled(
            std::env::var("WEBTRANSPORT_NATIVE_SEND_PATH_DIAGNOSTICS")
                .ok()
                .as_deref(),
        ) {
            Ok(value) => value,
            Err(message) => {
                crate::warn_invalid_knob(message, "0");
                false
            }
        }
    })
}

#[derive(Default)]
struct Registry {
    phase: usize,
    closed: bool,
    finalized_ns: Option<u64>,
    components: Vec<Arc<Component>>,
    errors: u64,
}
impl Registry {
    fn close(&mut self) -> Result<(), &'static str> {
        if self.closed {
            return Ok(());
        }
        if self.phase != 4 {
            return Err("native send diagnostics require idle phase before closing");
        }
        let cuts: Vec<_> = self
            .components
            .iter()
            .map(|component| component.try_exclusive())
            .collect::<Result<_, _>>()?;
        if !self
            .components
            .iter()
            .all(|component| component.quiescent())
        {
            return Err("native send diagnostics require quiescent ownership before closing");
        }
        for cut in cuts {
            cut.seal();
        }
        self.closed = true;
        self.finalized_ns = Some(now_ns());
        Ok(())
    }

    fn advance(&mut self, next: usize) -> Result<(), &'static str> {
        if self.closed || (next != self.phase && next != self.phase + 1) {
            return Err("native diagnostic phase is out of order");
        }
        if next == self.phase {
            return Ok(());
        }
        let cuts: Vec<_> = self
            .components
            .iter()
            .map(|component| component.try_exclusive())
            .collect::<Result<_, _>>()?;
        for component in &self.components {
            component.advance_exclusive(next, now_ns())?;
        }
        drop(cuts);
        self.phase = next;
        Ok(())
    }

    fn json(&self, enabled: bool) -> Result<String, &'static str> {
        serde_json::to_string(&serde_json::json!({
            "schema": "g6-native-send-path/1", "enabled": enabled,
            "finalized": enabled && self.closed, "phase": PHASE_NAMES[self.phase],
            "monoNs": self.finalized_ns.unwrap_or_else(now_ns).to_string(),
            "phaseOrder": PHASE_NAMES, "bucketUpperBoundsNs": (0..BUCKET_COUNT-1).map(|i| 1_000_u64 << i).collect::<Vec<_>>(),
            "errors": self.errors, "components": self.components.iter().map(|component| component.snapshot()).collect::<Vec<_>>()
        })).map_err(|_| "native diagnostic snapshot serialization failed")
    }
}
fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

pub(crate) fn register(kind: &'static str) -> Option<Arc<Component>> {
    if !enabled() {
        return None;
    }
    let mut registry = registry().lock().expect("diagnostic registry");
    if registry.closed || registry.components.len() >= MAX_COMPONENTS {
        registry.errors += 1;
        return None;
    }
    let component = Arc::new(Component::new_at(kind, registry.phase));
    registry.components.push(Arc::clone(&component));
    Some(component)
}

/// Private diagnostic seam, never an application performance promise. Call
/// `closed` only after endpoint shutdown and bounded quiescence. Reads before
/// that are provisional: old-origin intervals can still finish in later phases.
pub(crate) fn control(phase: Option<&str>) -> Result<String, &'static str> {
    let enabled = enabled();
    let mut registry = registry().lock().expect("diagnostic registry");
    if phase.is_some_and(|name| name != "closed" && !PHASE_NAMES[1..].contains(&name)) {
        return Err("unknown native diagnostic phase");
    }
    if enabled {
        if let Some(name) = phase {
            if name == "closed" {
                registry.close()?;
            } else {
                let next = PHASE_NAMES
                    .iter()
                    .position(|&entry| entry == name)
                    .filter(|&index| index > 0)
                    .ok_or("unknown native diagnostic phase")?;
                registry.advance(next)?;
            }
        }
    }
    registry.json(enabled)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn close_is_exclusive_with_admission_and_preserves_owned_releases() {
        let component = Arc::new(Component::new("reflector"));
        component.advance(1, 1).unwrap();
        let mutation = component.mutation().unwrap();
        assert!(component.try_exclusive().is_err());
        drop(mutation);
        let interval = component
            .start_at(IntervalKind::ReflectQueueWait, 100)
            .unwrap();
        let reservation = component
            .reserve(GaugeKind::ReflectReservedSlots, 1)
            .unwrap();
        let cut = component.try_exclusive().unwrap();
        assert!(!component.quiescent());
        drop(cut);
        interval.finish_at(1_100);
        drop(reservation);
        let cut = component.try_exclusive().unwrap();
        assert!(component.quiescent());
        cut.seal();
        assert!(component
            .start_at(IntervalKind::ReflectQueueWait, 2_000)
            .is_none());
        assert!(component
            .reserve(GaugeKind::ReflectReservedSlots, 1)
            .is_none());
        assert!(component.quiescent());
        assert_eq!(component.snapshot().errors, 2);
    }

    #[test]
    fn late_component_reports_creation_phase_without_fabricated_earlier_cuts() {
        let component = Arc::new(Component::new_at("reflector", 2));
        let snap = component.snapshot();
        assert_eq!(snap.created_phase, "steady");
        assert_eq!(snap.phase, "steady");
        assert!(snap.cuts.is_empty());
        assert!(snap.gauges.iter().all(|entry| entry.gauge.phase == 2));
        component.advance(3, now_ns()).unwrap();
        let snap = component.snapshot();
        assert_eq!(snap.cuts.len(), 1);
        assert_eq!(snap.cuts[0].phase, "drain");
        assert!(component
            .start_at(IntervalKind::ReflectSendCall, 1)
            .is_some());
    }

    #[test]
    fn registry_close_is_atomic_across_components_and_terminal_clock_is_stable() {
        let first = Arc::new(Component::new_at("udp-socket", 4));
        let second = Arc::new(Component::new_at("reflector", 4));
        let mut registry = Registry {
            phase: 4,
            components: vec![first.clone(), second.clone()],
            ..Registry::default()
        };
        let outstanding = second.reserve(GaugeKind::ReflectReservedSlots, 1).unwrap();
        assert!(registry.close().is_err());
        assert!(!registry.closed);
        let first_still_open = first.start_at(IntervalKind::UdpQueueWait, 10).unwrap();
        first_still_open.finish_at(20);
        drop(outstanding);
        registry.close().unwrap();
        let frozen = registry.json(true).unwrap();
        registry.close().unwrap();
        assert_eq!(registry.json(true).unwrap(), frozen);
        assert!(first.mutation().is_none());
        assert!(second.mutation().is_none());
    }

    #[test]
    fn origin_phase_keeps_queue_wait_separate_from_send_call_and_exposes_crossing() {
        let component = Arc::new(Component::new("reflector"));
        component.advance(1, 10).unwrap();
        let queued = component
            .start_at(IntervalKind::ReflectQueueWait, 100)
            .unwrap();
        component.advance(2, 1_000_000).unwrap();
        queued.finish_at(5_000_100);
        let send = component
            .start_at(IntervalKind::ReflectSendCall, 5_000_100)
            .unwrap();
        send.finish_at(5_001_100);
        let snap = component.snapshot();
        let queue_hist = &snap.phases[0].intervals[0].histogram;
        let send_hist = &snap.phases[1].intervals[1].histogram;
        assert_eq!(queue_hist.count, 1);
        assert_eq!(queue_hist.crossed_phase, 1);
        assert_eq!(queue_hist.buckets[13], 1); // 5 ms is in (4.096, 8.192] ms
        assert_eq!(send_hist.buckets[0], 1); // exactly 1 us, not the 5 ms queue wait
        assert!(component.quiescent());
    }

    #[test]
    fn dropped_or_rejected_intervals_do_not_claim_completed_latency() {
        let component = Arc::new(Component::new("udp-socket"));
        component.advance(1, 1).unwrap();
        let waiting = component.start_at(IntervalKind::FlusherEagain, 10).unwrap();
        assert!(!component.quiescent());
        drop(waiting);
        component
            .start_at(IntervalKind::UdpQueueWait, 20)
            .unwrap()
            .reject();
        let snap = component.snapshot();
        assert_eq!(snap.phases[0].intervals[3].histogram.censored, 1);
        assert_eq!(snap.phases[0].intervals[4].histogram.rejected, 1);
        assert_eq!(snap.phases[0].intervals[3].histogram.count, 0);
        assert!(component.quiescent());
    }

    #[test]
    fn reservation_releases_on_drop_and_carried_high_water_does_not_leak() {
        let component = Arc::new(Component::new("reflector"));
        component.advance(1, 1).unwrap();
        let guard = component
            .reserve(GaugeKind::ReflectReservedSlots, 3)
            .unwrap();
        component.advance(2, 2).unwrap();
        assert!(!component.quiescent());
        drop(guard);
        let snapshot = component.snapshot();
        assert_eq!(snapshot.gauges[0].gauge.current, 0);
        assert_eq!(snapshot.gauges[0].gauge.phase_high_water[2], 3);
        assert!(component.quiescent());
        assert!(component.advance(4, 4).is_err());
        assert!(component.advance(2, 3).is_ok());
        assert_eq!(component.snapshot().cuts.len(), 2);
    }

    #[test]
    fn exclusive_nanosecond_buckets_cover_sub_microsecond_and_long_waits() {
        let histogram = PhaseHistogram::default();
        for ns in [0, 1, 1_000, 1_001, 8_000, 2_000_000_000] {
            histogram.observe(ns, false);
        }
        let snapshot = histogram.snapshot();
        assert_eq!(snapshot.count, 6);
        assert_eq!(snapshot.buckets.iter().sum::<u64>(), 6);
        assert_eq!(snapshot.buckets[0], 3);
        assert_eq!(snapshot.buckets[1], 1);
        assert_eq!(snapshot.buckets[3], 1);
        assert_eq!(snapshot.crossed_phase, 0);
        assert_eq!(snapshot.overflow, 0);
    }

    #[test]
    fn crossing_and_censored_intervals_are_not_zero_duration_completions() {
        let bank = PhaseHistogram::default();
        bank.started();
        bank.started();
        bank.completed(5_000_000, true);
        let snapshot = bank.snapshot();
        assert_eq!(snapshot.count, 1);
        assert_eq!(snapshot.crossed_phase, 1);
        assert_eq!(snapshot.outstanding, 1);
        assert_eq!(snapshot.buckets.iter().sum::<u64>(), 1);
    }

    #[test]
    fn high_water_cut_carries_existing_ownership_without_reset_races() {
        let gauge = PhaseGauge::default();
        gauge.advance(1).unwrap();
        gauge.change(7).unwrap();
        gauge.change(-2).unwrap();
        gauge.advance(2).unwrap();
        gauge.change(-4).unwrap();
        let snapshot = gauge.snapshot();
        assert_eq!(snapshot.current, 1);
        assert_eq!(snapshot.phase_high_water[1], 7);
        assert_eq!(snapshot.phase_high_water[2], 5);
        gauge.change(8).unwrap();
        gauge.advance(3).unwrap();
        let snapshot = gauge.snapshot();
        assert_eq!(snapshot.phase_high_water[2], 9);
        assert_eq!(snapshot.phase_high_water[3], 9);
    }

    #[test]
    fn gauge_rejects_underflow_overflow_and_invalid_phase_without_mutation() {
        let gauge = PhaseGauge::default();
        assert!(gauge.change(-1).is_err());
        assert!(gauge.change(1_i64 << 30).is_err());
        assert!(gauge.advance(2).is_err());
        gauge.advance(1).unwrap();
        gauge.advance(1).unwrap();
        assert!(gauge.advance(0).is_err());
        assert!(gauge.advance(9).is_err());
        assert_eq!(gauge.snapshot().current, 0);
    }

    #[test]
    fn concurrent_updates_and_phase_cuts_preserve_count_and_high_water() {
        let gauge = Arc::new(PhaseGauge::default());
        gauge.advance(1).unwrap();
        let mut threads = Vec::new();
        for _ in 0..4 {
            let gauge = Arc::clone(&gauge);
            threads.push(std::thread::spawn(move || {
                for _ in 0..10_000 {
                    gauge.change(1).unwrap();
                    gauge.change(-1).unwrap();
                }
            }));
        }
        gauge.advance(2).unwrap();
        gauge.advance(3).unwrap();
        gauge.advance(4).unwrap();
        for thread in threads {
            thread.join().unwrap();
        }
        let snapshot = gauge.snapshot();
        assert_eq!(snapshot.current, 0);
        assert!(snapshot.phase_high_water.iter().all(|&value| value <= 4));
        assert!(snapshot.phase_high_water.iter().any(|&value| value > 0));
    }
}
