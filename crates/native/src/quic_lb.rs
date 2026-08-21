//! QUIC-LB connection IDs: a cleartext server ID an L4 balancer can read.
//!
//! Written against **draft-ietf-quic-load-balancers-21** (August 2025, expires
//! 28 February 2026), the current revision at the time of writing. Every
//! section reference below is to that revision.
//!
//! This implements the **keyless configuration**: §5.3 makes the 16-octet key
//! optional, and §5.4 says that with no key the server writes the first octet
//! and its server ID into their fields and the connection ID is complete. A
//! keyed configuration is the same CID format with the plaintext block
//! encrypted; it is a later option, not a different scheme.
//!
//! Layout (§5.2 Figure 2, §3.4 Figure 1):
//!
//! ```text
//! QUIC-LB Connection ID {
//!     First Octet {
//!         Config Rotation (3),        // §3.1: MUST NOT be 0b111
//!         CID Len or Random Bits (5), // §3.3: random here (see below)
//!     },
//!     Plaintext Block {
//!         Server ID (8..),            // §5.3: >= 1 octet
//!         Nonce (32..),               // §5.3: >= 4 octets
//!     },
//! }
//! ```
//!
//! The five low bits of the first octet carry length self-description only for
//! hardware crypto offload, which §3.3 calls "a function of particular server
//! devices and is irrelevant to load balancers". We do not use it, so we follow
//! the same section's guidance for that case: choose those bits "so as to have
//! no observable relationship to previous connection IDs issued for that
//! connection" — i.e. random. A balancer learns the CID length from its
//! configuration, exactly as it learns the server-ID and nonce lengths.
//!
//! §5.4 keyless nonce rule: the Nonce field MUST be filled "with bytes that
//! have no observable relationship to the field in previously issued connection
//! IDs". That means a cryptographically random nonce per CID, never a counter.
//! Randomness is also load-bearing for liveness: quinn's `Endpoint::new_cid`
//! loops until the generator produces a CID it has not already issued, so a
//! deterministic generator hangs the endpoint.
//!
//! Privacy cost, stated plainly (§5.3): "failure to define a key means that
//! observers can determine the assigned server of any connection, significantly
//! increasing the linkability of QUIC address migration." That is a deliberate
//! deviation from the `ConnectionIdGenerator` trait doc, which asks that CIDs
//! carry nothing an external observer can use to correlate them
//! (quinn-proto 0.11.16 `cid_generator.rs:11-17`). QUIC-LB's whole point is
//! that the balancer — an external observer of the CID — can read the server
//! ID. Operators trade migration unlinkability for stateless routing.

use std::fmt;

// quinn re-exports `ConnectionId` and `ConnectionIdGenerator` but not
// `InvalidCid`, and `quinn::proto` is a private extern-crate rename, so the
// trait's error type is only reachable through a direct quinn-proto dependency.
// The version is pinned to the one quinn 0.11 locks: two quinn-protos in the
// tree would make this a different trait than the endpoint config wants.
use quinn_proto::{ConnectionId, ConnectionIdGenerator, InvalidCid};

/// §3.2: the reserved config-rotation codepoint meaning "unroutable".
const RESERVED_CONFIG_ROTATION: u8 = 0b111;
/// §5.3: "The server ID length MUST be at least 1 octet."
const MIN_SERVER_ID_LEN: usize = 1;
/// §5.3: "The nonce length MUST be at least 4 octets."
const MIN_NONCE_LEN: usize = 4;
/// §5.3: "the server ID and nonce lengths MUST sum to 19 octets or less",
/// because QUIC version 1 caps connection IDs at 20 and the first octet takes
/// one of them.
const MAX_PLAINTEXT_BLOCK_LEN: usize = 19;

/// A rejected QUIC-LB configuration, with the draft bound it violated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuicLbConfigError {
    ServerIdTooShort,
    NonceTooShort(usize),
    BlockTooLong(usize),
    ReservedConfigRotation,
    ConfigRotationOutOfRange(u8),
}

impl fmt::Display for QuicLbConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ServerIdTooShort => write!(
                f,
                "quicLb.serverId must be at least {MIN_SERVER_ID_LEN} octet \
                 (draft-ietf-quic-load-balancers-21 §5.3)"
            ),
            Self::NonceTooShort(got) => write!(
                f,
                "quicLb.nonceLen must be at least {MIN_NONCE_LEN} octets, got {got} \
                 (draft-ietf-quic-load-balancers-21 §5.3)"
            ),
            Self::BlockTooLong(got) => write!(
                f,
                "quicLb.serverId length + nonceLen must be at most \
                 {MAX_PLAINTEXT_BLOCK_LEN} octets, got {got} \
                 (draft-ietf-quic-load-balancers-21 §5.3)"
            ),
            Self::ReservedConfigRotation => write!(
                f,
                "quicLb.configRotation must not be 0b111, which is reserved for \
                 unroutable connection IDs (draft-ietf-quic-load-balancers-21 §3.1, §3.2)"
            ),
            Self::ConfigRotationOutOfRange(got) => write!(
                f,
                "quicLb.configRotation must fit in 3 bits (0-6), got {got} \
                 (draft-ietf-quic-load-balancers-21 §3.1)"
            ),
        }
    }
}

/// A validated keyless QUIC-LB configuration for one server instance.
///
/// Every instance behind one balancer shares the nonce length, the server-ID
/// length and the config-rotation codepoint, and each carries a distinct server
/// ID. Distinct server IDs of equal length can never collide in the ID portion,
/// so two instances never claim each other's CIDs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuicLbConfig {
    server_id: Vec<u8>,
    nonce_len: usize,
    config_rotation: u8,
}

impl QuicLbConfig {
    /// Checks every bound the draft places on a configuration. Callers surface
    /// the error verbatim; there is no clamping, because a silently adjusted
    /// length would leave the balancer decoding a different layout than the
    /// server writes.
    pub fn new(
        server_id: Vec<u8>,
        nonce_len: usize,
        config_rotation: u8,
    ) -> Result<Self, QuicLbConfigError> {
        if server_id.len() < MIN_SERVER_ID_LEN {
            return Err(QuicLbConfigError::ServerIdTooShort);
        }
        if nonce_len < MIN_NONCE_LEN {
            return Err(QuicLbConfigError::NonceTooShort(nonce_len));
        }
        let block = server_id.len().saturating_add(nonce_len);
        if block > MAX_PLAINTEXT_BLOCK_LEN {
            return Err(QuicLbConfigError::BlockTooLong(block));
        }
        if config_rotation == RESERVED_CONFIG_ROTATION {
            return Err(QuicLbConfigError::ReservedConfigRotation);
        }
        if config_rotation > RESERVED_CONFIG_ROTATION {
            return Err(QuicLbConfigError::ConfigRotationOutOfRange(
                config_rotation,
            ));
        }
        Ok(Self {
            server_id,
            nonce_len,
            config_rotation,
        })
    }

    pub fn server_id(&self) -> &[u8] {
        &self.server_id
    }

    pub fn nonce_len(&self) -> usize {
        self.nonce_len
    }

    pub fn config_rotation(&self) -> u8 {
        self.config_rotation
    }

    /// First octet + server ID + nonce. Fixed for the life of the endpoint.
    ///
    /// Minimum 6 octets, realistically 11 or more, against quinn's 8-octet
    /// default: QUIC-LB costs a few bytes of every packet header in both
    /// directions once the client starts using the server-issued CID.
    pub fn cid_len(&self) -> usize {
        1 + self.server_id.len() + self.nonce_len
    }
}

/// Reads the server ID out of a QUIC-LB connection ID.
///
/// Pure and keyless — the balancer side of this file. `server_id_len` comes
/// from the balancer's configuration, not from the wire; nothing in the CID
/// encodes it. Returns `None` when the CID is too short to hold a first octet
/// plus that many server-ID octets, which is how a caller distinguishes a
/// QUIC-LB CID from a random one issued by some other endpoint.
///
/// Callers that also route on the configuration must check the first octet's
/// top three bits themselves; a CID whose config rotation is 0b111 is
/// unroutable (§3.2) even though its bytes parse.
pub fn decode_server_id(cid: &[u8], server_id_len: usize) -> Option<&[u8]> {
    if server_id_len == 0 {
        return None;
    }
    cid.get(1..1 + server_id_len)
}

/// Reads the config-rotation codepoint (§3.1) out of a connection ID.
pub fn decode_config_rotation(cid: &[u8]) -> Option<u8> {
    cid.first().map(|octet| octet >> 5)
}

/// Reads the `quicLb` server option out of the JSON options blob.
///
/// Absent (or `null`) means quinn's default CIDs. Present means every field is
/// checked here: nothing is defaulted except `configRotation`, because a
/// balancer that guesses a length decodes a different layout than the server
/// writes. Errors are returned without the `E_INVALID_ARGUMENT:` prefix; the
/// N-API boundary adds it.
pub fn parse_quic_lb_options(opts: &serde_json::Value) -> Result<Option<QuicLbConfig>, String> {
    let Some(raw) = opts.get("quicLb") else {
        return Ok(None);
    };
    if raw.is_null() {
        return Ok(None);
    }
    let table = raw
        .as_object()
        .ok_or_else(|| "quicLb must be an object".to_string())?;

    let server_id_raw = table
        .get("serverId")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "quicLb.serverId must be an array of octets".to_string())?;
    let mut server_id = Vec::with_capacity(server_id_raw.len());
    for (i, octet) in server_id_raw.iter().enumerate() {
        let value = octet
            .as_u64()
            .filter(|v| *v <= u64::from(u8::MAX))
            .ok_or_else(|| format!("quicLb.serverId[{i}] must be an integer in 0-255"))?;
        server_id.push(value as u8);
    }

    let nonce_len = table
        .get("nonceLen")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| {
            "quicLb.nonceLen is required: a balancer decodes the nonce by \
             configured length, never from the wire"
                .to_string()
        })?;
    let nonce_len = usize::try_from(nonce_len)
        .map_err(|_| format!("quicLb.nonceLen is out of range: {nonce_len}"))?;

    let config_rotation = match table.get("configRotation") {
        None | Some(serde_json::Value::Null) => 0u8,
        Some(value) => value
            .as_u64()
            .and_then(|v| u8::try_from(v).ok())
            .ok_or_else(|| "quicLb.configRotation must be an integer in 0-6".to_string())?,
    };

    QuicLbConfig::new(server_id, nonce_len, config_rotation)
        .map(Some)
        .map_err(|e| e.to_string())
}

/// Issues QUIC-LB connection IDs for one endpoint.
///
/// Installed as a factory on the endpoint config, so quinn may build several of
/// these; they are stateless apart from the shared configuration and the
/// system CSPRNG, so instances are interchangeable.
#[derive(Debug)]
pub struct QuicLbCidGenerator {
    config: QuicLbConfig,
    rng: &'static dyn rustls::crypto::SecureRandom,
}

impl QuicLbCidGenerator {
    pub fn new(config: QuicLbConfig) -> Self {
        // The same CSPRNG the TLS stack already uses in this process
        // (`server_tls.rs`, `client.rs`), so QUIC-LB adds no new entropy
        // source and no new dependency.
        Self {
            config,
            rng: rustls::crypto::ring::default_provider().secure_random,
        }
    }

    /// The factory quinn's `EndpointConfig::cid_generator` wants
    /// (quinn-proto 0.11.16 `config/mod.rs:77-83`). The validated config is
    /// captured by the closure, so every generator quinn builds writes the
    /// same server ID.
    pub fn factory(
        config: QuicLbConfig,
    ) -> impl Fn() -> Box<dyn ConnectionIdGenerator> + Send + Sync + 'static {
        move || Box::new(Self::new(config.clone())) as Box<dyn ConnectionIdGenerator>
    }
}

impl ConnectionIdGenerator for QuicLbCidGenerator {
    fn generate_cid(&mut self) -> ConnectionId {
        let mut cid = vec![0u8; self.config.cid_len()];
        let server_id_end = 1 + self.config.server_id.len();
        cid[1..server_id_end].copy_from_slice(&self.config.server_id);
        // Random first octet, then overwrite the top three bits with the
        // config rotation: the five low bits are random per §3.3 for a server
        // not using length self-description.
        self.rng
            .fill(&mut cid[..1])
            .and_then(|()| self.rng.fill(&mut cid[server_id_end..]))
            // A failed system CSPRNG cannot be papered over: a predictable
            // nonce breaks §5.4 and, worse, lets `new_cid` spin. quinn's own
            // generators panic here for the same reason.
            .expect("system CSPRNG must produce QUIC-LB connection ID bytes");
        cid[0] = (self.config.config_rotation << 5) | (cid[0] & 0b0001_1111);
        ConnectionId::new(&cid)
    }

    /// quinn consults this before spending work on a packet whose destination
    /// CID it does not recognize (quinn-proto 0.11.16 `endpoint.rs:249-253`).
    /// Leaving the trait's default `Ok(())` in place would silently drop that
    /// junk-packet filter, so a QUIC-LB endpoint checks the two things its
    /// layout makes cheap to check: the config rotation it issues under, and
    /// its own server ID. False positives are allowed by the trait; the nonce
    /// is not checkable and is not checked.
    fn validate(&self, cid: &ConnectionId) -> Result<(), InvalidCid> {
        let bytes: &[u8] = cid;
        if bytes.len() != self.config.cid_len() {
            return Err(InvalidCid);
        }
        if decode_config_rotation(bytes) != Some(self.config.config_rotation) {
            return Err(InvalidCid);
        }
        match decode_server_id(bytes, self.config.server_id.len()) {
            Some(id) if id == self.config.server_id => Ok(()),
            _ => Err(InvalidCid),
        }
    }

    fn cid_len(&self) -> usize {
        self.config.cid_len()
    }

    /// No time-based rotation, matching quinn's own default. §3.1 rotation is
    /// a configuration change, driven by the configuration agent and delivered
    /// with NEW_CONNECTION_ID frames on demand; a wall-clock lifetime here
    /// would retire CIDs for a reason QUIC-LB does not have.
    fn cid_lifetime(&self) -> Option<std::time::Duration> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn config() -> QuicLbConfig {
        QuicLbConfig::new(vec![0xAB, 0xCD], 8, 3).expect("valid config")
    }

    #[test]
    fn server_id_must_be_at_least_one_octet() {
        assert_eq!(
            QuicLbConfig::new(Vec::new(), 8, 0),
            Err(QuicLbConfigError::ServerIdTooShort)
        );
        assert!(QuicLbConfig::new(vec![7], 4, 0).is_ok());
    }

    #[test]
    fn nonce_must_be_at_least_four_octets() {
        assert_eq!(
            QuicLbConfig::new(vec![1], 3, 0),
            Err(QuicLbConfigError::NonceTooShort(3))
        );
        assert!(QuicLbConfig::new(vec![1], 4, 0).is_ok());
    }

    #[test]
    fn server_id_and_nonce_must_sum_to_nineteen_or_less() {
        assert!(QuicLbConfig::new(vec![0; 15], 4, 0).is_ok());
        assert_eq!(
            QuicLbConfig::new(vec![0; 16], 4, 0),
            Err(QuicLbConfigError::BlockTooLong(20))
        );
    }

    #[test]
    fn config_rotation_rejects_the_reserved_codepoint_and_anything_wider() {
        assert_eq!(
            QuicLbConfig::new(vec![1], 4, 0b111),
            Err(QuicLbConfigError::ReservedConfigRotation)
        );
        assert_eq!(
            QuicLbConfig::new(vec![1], 4, 8),
            Err(QuicLbConfigError::ConfigRotationOutOfRange(8))
        );
        for rotation in 0..=6u8 {
            assert!(QuicLbConfig::new(vec![1], 4, rotation).is_ok());
        }
    }

    #[test]
    fn cid_len_is_first_octet_plus_both_fields() {
        assert_eq!(config().cid_len(), 11);
        assert_eq!(QuicLbConfig::new(vec![1], 4, 0).unwrap().cid_len(), 6);
        assert_eq!(QuicLbConfig::new(vec![0; 15], 4, 0).unwrap().cid_len(), 20);
    }

    #[test]
    fn generated_cids_carry_the_configured_rotation_and_server_id() {
        let cfg = config();
        let mut gen = QuicLbCidGenerator::new(cfg.clone());
        for _ in 0..64 {
            let cid = gen.generate_cid();
            let bytes: &[u8] = &cid;
            assert_eq!(bytes.len(), cfg.cid_len());
            assert_eq!(decode_config_rotation(bytes), Some(3));
            assert_eq!(decode_server_id(bytes, 2), Some(&[0xAB, 0xCD][..]));
        }
    }

    #[test]
    fn nonces_differ_across_many_generations() {
        let cfg = config();
        let mut gen = QuicLbCidGenerator::new(cfg.clone());
        let mut seen = HashSet::new();
        let mut low_bits = HashSet::new();
        for _ in 0..1000 {
            let cid = gen.generate_cid();
            let bytes: &[u8] = &cid;
            low_bits.insert(bytes[0] & 0b0001_1111);
            assert!(
                seen.insert(bytes.to_vec()),
                "a repeated CID would spin quinn's new_cid uniqueness loop"
            );
        }
        assert_eq!(seen.len(), 1000);
        // The five low bits are random, not a constant (§3.3). Seeing at least
        // half the codepoints in 1000 draws is overwhelming for a real CSPRNG.
        assert!(
            low_bits.len() >= 16,
            "first-octet low bits look constant: {} distinct values",
            low_bits.len()
        );
    }

    #[test]
    fn validate_accepts_own_cids() {
        let mut gen = QuicLbCidGenerator::new(config());
        for _ in 0..64 {
            let cid = gen.generate_cid();
            assert!(gen.validate(&cid).is_ok());
        }
    }

    #[test]
    fn validate_rejects_wrong_length_rotation_and_foreign_server_id() {
        let gen = QuicLbCidGenerator::new(config());

        let short = ConnectionId::new(&[0b0110_0000, 0xAB, 0xCD, 0, 0, 0, 0]);
        assert!(gen.validate(&short).is_err(), "wrong length must be junk");

        let mut peer = QuicLbCidGenerator::new(
            QuicLbConfig::new(vec![0xAB, 0xCD], 8, 4).expect("other rotation"),
        );
        let rotated = peer.generate_cid();
        assert!(
            gen.validate(&rotated).is_err(),
            "another configuration's CIDs must be junk"
        );

        let mut foreign =
            QuicLbCidGenerator::new(QuicLbConfig::new(vec![0x01, 0x02], 8, 3).expect("other id"));
        let elsewhere = foreign.generate_cid();
        assert!(
            gen.validate(&elsewhere).is_err(),
            "a sibling instance's CIDs must be junk here"
        );
        assert!(
            foreign.validate(&elsewhere).is_ok(),
            "but must be valid at the instance that issued them"
        );
    }

    #[test]
    fn decode_helper_roundtrips_and_refuses_short_input() {
        let cfg = QuicLbConfig::new(vec![9, 8, 7], 4, 2).expect("config");
        let mut gen = QuicLbCidGenerator::new(cfg);
        let cid = gen.generate_cid();
        let bytes: &[u8] = &cid;
        assert_eq!(decode_server_id(bytes, 3), Some(&[9, 8, 7][..]));
        assert_eq!(decode_config_rotation(bytes), Some(2));

        assert_eq!(decode_server_id(&[0x40, 9, 8], 3), None);
        assert_eq!(decode_server_id(&[], 1), None);
        assert_eq!(decode_server_id(bytes, 0), None);
        assert_eq!(decode_config_rotation(&[]), None);
    }

    #[test]
    fn factory_builds_generators_that_agree_on_the_server_id() {
        let factory = QuicLbCidGenerator::factory(config());
        let mut first = factory();
        let second = factory();
        let cid = first.generate_cid();
        assert!(
            second.validate(&cid).is_ok(),
            "generators from one factory must recognize each other's CIDs"
        );
    }

    #[test]
    fn cid_lifetime_is_none_so_quinn_does_not_time_out_cids() {
        assert_eq!(QuicLbCidGenerator::new(config()).cid_lifetime(), None);
    }
}
