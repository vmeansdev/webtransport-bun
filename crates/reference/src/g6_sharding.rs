//! Client-side placement for the sharded G6 arms (plan
//! `docs/superpowers/plans/2026-10-06-g6-sharded-arms.md`, registered
//! semantics 1 and 3).
//!
//! The sharded deployment steers an opening Initial whose DCID length differs
//! from the server CID length by hashing the client's own DCID
//! (`examples/quic-lb/steer_by_cid.bpf.c`, `place_by_client_dcid`): FNV-1a over
//! the first eight octets, modulo `MAX_INSTANCES`, selects sockarray slot `K`,
//! which holds the shard whose QUIC-LB server id is `K + 1`. So a client that
//! chooses its own opening DCID knows — before the server says anything — which
//! shard will own the connection. That is what lets the raid publisher and its
//! subscribers co-locate on one shard, and what lets every session attribute its
//! samples to a shard without trusting the server.
//!
//! Nothing here is used unless `--shard-count` is passed; without it the
//! endpoint keeps quinn's own provider (also random 20-octet DCIDs:
//! quinn-proto 0.11.16 `ClientConfig::new` uses
//! `RandomConnectionIdGenerator::new(MAX_CID_SIZE)`, `MAX_CID_SIZE == 20`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use wtransport::quinn::ConnectionId;

/// Registered opening-DCID length (plan §1): quinn's default, and different
/// from [`SERVER_CID_LEN`], so the steering program hash-places it.
pub const REGISTERED_DCID_LEN: usize = 20;
/// `CID_LEN` in `steer_by_cid.bpf.c`: 1 + SERVER_ID_LEN (2) + NONCE_LEN (8).
/// An opening DCID of exactly this length takes the server-id path instead of
/// the client-DCID hash and, missing in `slot_by_server_id`, the kernel hash.
pub const SERVER_CID_LEN: usize = 1 + 2 + 8;
/// `place_by_client_dcid` refuses shorter DCIDs (RFC 9000 §7.2).
pub const MIN_HASHED_DCID_LEN: usize = 8;
/// The BPF sockarray build cap the scan uses (`-DMAX_INSTANCES`, ≤ 64).
pub const MAX_SHARDS: u32 = 64;

const FNV_OFFSET_BASIS: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

/// FNV-1a over the first eight octets, exactly as the BPF program computes it.
pub fn fnv1a_first8(dcid: &[u8]) -> Option<u32> {
    if dcid.len() < MIN_HASHED_DCID_LEN {
        return None;
    }
    let mut hash = FNV_OFFSET_BASIS;
    for &octet in &dcid[..8] {
        hash ^= u32::from(octet);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    Some(hash)
}

/// Whether the steering program hash-places an opening long-header packet
/// with a DCID of this length (rather than reading a server id from it).
pub fn hash_placed(dcid_len: usize) -> bool {
    dcid_len >= MIN_HASHED_DCID_LEN && dcid_len != SERVER_CID_LEN
}

/// The sockarray slot `place_by_client_dcid` selects for this DCID with
/// `MAX_INSTANCES == shard_count`. Slot `K` holds server id `K + 1`.
pub fn placement_slot(dcid: &[u8], shard_count: u32) -> Option<u32> {
    if shard_count == 0 {
        return None;
    }
    fnv1a_first8(dcid).map(|hash| hash % shard_count)
}

pub fn server_id_for_slot(slot: u32) -> u32 {
    slot + 1
}

/// SplitMix64 over an atomic counter: uniform 64-bit words for DCID octets
/// without a new dependency. Opening DCIDs need unpredictability against
/// nothing here — only uniformity, so placement of untargeted sessions is the
/// same uniform spread quinn's own random DCIDs give.
pub struct DcidRng {
    state: AtomicU64,
}

impl DcidRng {
    pub fn seeded(seed: u64) -> Self {
        Self {
            state: AtomicU64::new(seed),
        }
    }

    pub fn from_entropy() -> Self {
        let mut seed = [0u8; 8];
        let from_urandom = std::fs::File::open("/dev/urandom")
            .and_then(|mut file| std::io::Read::read_exact(&mut file, &mut seed))
            .is_ok();
        let seed = if from_urandom {
            u64::from_le_bytes(seed)
        } else {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            nanos ^ (u64::from(std::process::id()) << 32)
        };
        Self::seeded(seed)
    }

    pub fn next_u64(&self) -> u64 {
        let mut z = self
            .state
            .fetch_add(0x9e37_79b9_7f4a_7c15, Ordering::Relaxed)
            .wrapping_add(0x9e37_79b9_7f4a_7c15);
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    pub fn fill(&self, out: &mut [u8]) {
        for chunk in out.chunks_mut(8) {
            let word = self.next_u64().to_le_bytes();
            chunk.copy_from_slice(&word[..chunk.len()]);
        }
    }
}

/// What a session's opening DCIDs look like.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DcidPlan {
    pub len: usize,
    pub shard_count: u32,
    /// Draw until the placement slot equals this one (raid co-location).
    pub target_slot: Option<u32>,
}

impl DcidPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.shard_count == 0 || self.shard_count > MAX_SHARDS {
            return Err(format!(
                "mmo-client: --shard-count must be 1..={MAX_SHARDS}, got {}",
                self.shard_count
            ));
        }
        if !(MIN_HASHED_DCID_LEN..=REGISTERED_DCID_LEN).contains(&self.len) {
            return Err(format!(
                "mmo-client: --dcid-len must be {MIN_HASHED_DCID_LEN}..={REGISTERED_DCID_LEN}, got {}",
                self.len
            ));
        }
        if let Some(slot) = self.target_slot {
            if slot >= self.shard_count {
                return Err(format!(
                    "mmo-client: --target-shard {slot} is not a slot of {} shards",
                    self.shard_count
                ));
            }
        }
        Ok(())
    }

    /// One opening DCID and the number of draws it took.
    pub fn draw(&self, rng: &DcidRng) -> (Vec<u8>, u32) {
        let mut attempts = 0u32;
        loop {
            attempts = attempts.saturating_add(1);
            let mut dcid = vec![0u8; self.len];
            rng.fill(&mut dcid);
            match self.target_slot {
                None => return (dcid, attempts),
                Some(target) if placement_slot(&dcid, self.shard_count) == Some(target) => {
                    return (dcid, attempts)
                }
                Some(_) => {}
            }
        }
    }
}

/// The opening DCID quinn actually used for one connection attempt, and the
/// instant it was issued (the provider is called synchronously inside
/// `quinn::Endpoint::connect`, immediately before the first Initial is
/// queued — the client-side Initial issue instant V-R reads).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Opening {
    pub dcid: Vec<u8>,
    pub issued_ns: u64,
}

#[derive(Default)]
pub struct OpeningRecord {
    first: Mutex<Option<Opening>>,
}

impl OpeningRecord {
    fn record(&self, opening: Opening) {
        if let Ok(mut slot) = self.first.lock() {
            if slot.is_none() {
                *slot = Some(opening);
            }
        }
    }

    pub fn take(&self) -> Option<Opening> {
        self.first.lock().ok().and_then(|mut slot| slot.take())
    }
}

tokio::task_local! {
    /// Scoped around one `Endpoint::connect` future: the endpoint is shared by
    /// many sessions, so the provider learns *which* session it is serving from
    /// the task it runs on, never from a shared slot two concurrent connects
    /// could race on.
    pub static OPENING: Arc<OpeningRecord>;
}

pub type DcidProvider = Arc<dyn Fn() -> ConnectionId + Send + Sync>;

pub fn provider(plan: DcidPlan, rng: Arc<DcidRng>, clock: fn() -> u64) -> DcidProvider {
    Arc::new(move || {
        let (dcid, _) = plan.draw(&rng);
        let issued_ns = clock();
        let cid = ConnectionId::new(&dcid);
        let _ = OPENING.try_with(|record| record.record(Opening { dcid, issued_ns }));
        cid
    })
}

/// Process `index`'s share of a cohort split by **global** session index across
/// `processes` generator processes. Global index `g = local * processes +
/// index`; the cohort is `g < cohort`. The share is therefore exactly
/// `evenShare` (`tools/load/g6-client-merge.ts`), and the severed sessions of
/// process `index` are its first `share` local indices.
pub fn cohort_share(cohort: usize, processes: usize, index: usize) -> usize {
    if processes == 0 || index >= processes {
        return 0;
    }
    cohort / processes + usize::from(index < cohort % processes)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BPF_SOURCE: &str = include_str!("../../../examples/quic-lb/steer_by_cid.bpf.c");

    #[test]
    fn hash_constants_and_cid_len_match_the_bpf_program_text() {
        assert!(BPF_SOURCE.contains("__u32 hash = 0x811c9dc5; // FNV-1a offset basis"));
        assert!(BPF_SOURCE.contains("hash *= 0x01000193; // FNV-1a prime"));
        assert!(BPF_SOURCE.contains("hash ^= dcid[i];"));
        assert!(BPF_SOURCE.contains("__u8 dcid[8];"));
        assert!(BPF_SOURCE.contains("for (i = 0; i < 8; i++) {"));
        assert!(BPF_SOURCE.contains("slot = hash % MAX_INSTANCES;"));
        assert!(BPF_SOURCE.contains("if (dcid_len < 8)"));
        assert!(BPF_SOURCE.contains("#define SERVER_ID_LEN 2"));
        assert!(BPF_SOURCE.contains("#define NONCE_LEN 8"));
        assert!(BPF_SOURCE.contains("#define CID_LEN (1 + SERVER_ID_LEN + NONCE_LEN)"));
        assert!(BPF_SOURCE.contains(
            "if (prefix[UDP_HDR_LEN + 5] != CID_LEN)\n\t\t\treturn place_by_client_dcid(reuse, prefix[UDP_HDR_LEN + 5]);"
        ));
        assert_eq!(SERVER_CID_LEN, 11);
    }

    /// Vectors produced by compiling the BPF program's loop verbatim as C
    /// (`uint32_t hash = 0x811c9dc5; for (i = 0; i < 8; i++) { hash ^= dcid[i];
    /// hash *= 0x01000193; }`) on the author's host, 2026-10-06.
    #[test]
    fn fnv_vectors_match_the_c_reference_bit_for_bit() {
        let vectors: [([u8; 8], u32, u32, u32); 7] = [
            ([0x00; 8], 0x9be1_7165, 1, 21),
            ([0xff; 8], 0x6cae_0a5d, 1, 13),
            (
                [0x4b, 0x56, 0x61, 0x6c, 0x77, 0x82, 0x8d, 0x98],
                0x903a_86f5,
                1,
                5,
            ),
            ([1, 2, 3, 4, 5, 6, 7, 8], 0x2804_678d, 1, 21),
            (
                [0xde, 0xad, 0xbe, 0xef, 0x00, 0x11, 0x22, 0x33],
                0xfd6f_eed7,
                3,
                7,
            ),
            (
                [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0],
                0x7a05_bbb5,
                1,
                21,
            ),
            (
                [0x07, 0xc3, 0x5a, 0x90, 0x21, 0xee, 0x4d, 0xb8],
                0x16c4_9453,
                3,
                11,
            ),
        ];
        for (prefix, hash, mod4, mod24) in vectors {
            // Only the first eight octets count; the rest of a 20-octet DCID
            // must not move the placement.
            let mut dcid = [0xa5u8; REGISTERED_DCID_LEN];
            dcid[..8].copy_from_slice(&prefix);
            assert_eq!(fnv1a_first8(&dcid), Some(hash), "{prefix:02x?}");
            assert_eq!(placement_slot(&dcid, 4), Some(mod4));
            assert_eq!(placement_slot(&dcid, 24), Some(mod24));
            assert_eq!(placement_slot(&prefix, 4), Some(mod4));
        }
        assert_eq!(server_id_for_slot(0), 1);
        assert_eq!(server_id_for_slot(23), 24);
        assert_eq!(fnv1a_first8(&[0u8; 7]), None);
        assert_eq!(placement_slot(&[0u8; 20], 0), None);
    }

    #[test]
    fn registered_dcid_length_is_hash_placed_and_the_server_cid_length_is_not() {
        assert_eq!(REGISTERED_DCID_LEN, 20);
        assert_ne!(REGISTERED_DCID_LEN, SERVER_CID_LEN);
        assert!(hash_placed(REGISTERED_DCID_LEN));
        assert!(!hash_placed(SERVER_CID_LEN));
        assert!(!hash_placed(7));
    }

    #[test]
    fn targeted_draws_land_on_the_target_slot_with_the_registered_length() {
        let rng = DcidRng::seeded(42);
        for shard_count in [1u32, 4, 24, 64] {
            for target in [0, shard_count / 2, shard_count - 1] {
                let plan = DcidPlan {
                    len: REGISTERED_DCID_LEN,
                    shard_count,
                    target_slot: Some(target),
                };
                plan.validate().unwrap();
                for _ in 0..50 {
                    let (dcid, attempts) = plan.draw(&rng);
                    assert_eq!(dcid.len(), 20);
                    assert!(attempts >= 1);
                    assert_eq!(placement_slot(&dcid, shard_count), Some(target));
                }
            }
        }
    }

    #[test]
    fn untargeted_draws_spread_uniformly_over_slots() {
        let rng = DcidRng::seeded(7);
        let plan = DcidPlan {
            len: REGISTERED_DCID_LEN,
            shard_count: 4,
            target_slot: None,
        };
        let mut counts = [0u32; 4];
        for _ in 0..40_000 {
            let (dcid, attempts) = plan.draw(&rng);
            assert_eq!(attempts, 1);
            counts[placement_slot(&dcid, 4).unwrap() as usize] += 1;
        }
        for count in counts {
            assert!((9_400..=10_600).contains(&count), "{counts:?}");
        }
    }

    #[test]
    fn plan_validation_refuses_bad_shapes() {
        let ok = DcidPlan {
            len: 20,
            shard_count: 24,
            target_slot: Some(23),
        };
        assert!(ok.validate().is_ok());
        assert!(DcidPlan {
            target_slot: Some(24),
            ..ok
        }
        .validate()
        .is_err());
        assert!(DcidPlan {
            shard_count: 0,
            ..ok
        }
        .validate()
        .is_err());
        assert!(DcidPlan {
            shard_count: 65,
            ..ok
        }
        .validate()
        .is_err());
        assert!(DcidPlan { len: 7, ..ok }.validate().is_err());
        assert!(DcidPlan { len: 21, ..ok }.validate().is_err());
        // The negative control's length is allowed, and is the one the
        // program does not hash-place.
        assert!(DcidPlan { len: 11, ..ok }.validate().is_ok());
    }

    #[tokio::test]
    async fn provider_records_the_opening_dcid_only_inside_its_task_scope() {
        fn clock() -> u64 {
            1234
        }
        let plan = DcidPlan {
            len: 20,
            shard_count: 4,
            target_slot: Some(2),
        };
        let provider = provider(plan, Arc::new(DcidRng::seeded(1)), clock);
        let record = Arc::new(OpeningRecord::default());
        let cid = OPENING
            .scope(Arc::clone(&record), async { (provider)() })
            .await;
        let opening = record.take().expect("recorded");
        assert_eq!(&opening.dcid[..], &cid[..]);
        assert_eq!(opening.issued_ns, 1234);
        assert_eq!(placement_slot(&opening.dcid, 4), Some(2));
        // Outside any scope the provider still works and records nothing.
        let other = (provider)();
        assert_eq!(other.len(), 20);
        assert!(record.take().is_none());
    }

    #[test]
    fn cohort_shares_are_exact_and_equal_the_global_index_rule() {
        for processes in 1..=6usize {
            for cohort in [0usize, 1, 3, 7, 1000, 1001, 8000, 40_000] {
                let shares: Vec<usize> = (0..processes)
                    .map(|index| cohort_share(cohort, processes, index))
                    .collect();
                assert_eq!(shares.iter().sum::<usize>(), cohort);
                for (index, share) in shares.iter().enumerate() {
                    // #{local : local * processes + index < cohort}
                    let by_global = (0..cohort + processes)
                        .filter(|local| local * processes + index < cohort)
                        .count();
                    assert_eq!(*share, by_global, "p={processes} c={cohort} i={index}");
                }
            }
        }
        assert_eq!(cohort_share(10, 0, 0), 0);
        assert_eq!(cohort_share(10, 2, 2), 0);
    }
}
