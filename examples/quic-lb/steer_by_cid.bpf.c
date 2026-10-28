// SPDX-License-Identifier: MIT
//
// ============================================================================
// EXAMPLE — COMPILES ONLY; NEVER LOADED, NEVER ATTACHED, NEVER TESTED
// ============================================================================
//
// This file is a reference for operators writing their own SK_REUSEPORT
// steering program. It is not built by this repository, not run by any test,
// and not shipped in the npm package. Read it, port it, verify it yourself.
//
// Written against Linux **7.0.0-30-generic** (the campaign's bare-metal box) as
// the reference target. The maps are declared in libbpf's BTF style
// (`__uint`/`__type`), which needs clang with BTF support and libbpf headers —
// kernel >= 5.2, not 4.19. This is NOT a CO-RE build: it includes the kernel
// uapi headers directly rather than a generated `vmlinux.h`, reads no field
// through `BPF_CORE_READ`, and so is compiled against one kernel's ABI rather
// than relocated onto whatever kernel loads it.
//
// Exactly one thing has been established about it: on 2026-08-21, on that box,
// `clang -target bpf -O2 -g -c steer_by_cid.bpf.c` compiled it clean against
// that kernel's headers with libbpf-dev installed — zero diagnostics, a
// 15,984-byte object. That is a syntax and types result and nothing more.
//
// UPDATE (same day): the CURRENT text — with every review fix below — was
// recompiled clean on the same box, same command, at tip f7c9058. The
// original 2026-08-21 object was built
// from the revision before the review fixes below (short-header fixed-bit test
// removed; Initial/0-RTT routed by DCID; `steer_stats` moved to a per-CPU
// array). The re-compile on the box is OWED and has not been run — treat the
// clean-compile claim as applying to the earlier revision until it is redone.
//
// It has NEVER been submitted to a verifier, NEVER attached to a socket, and
// NEVER carried a packet. Verifier acceptance and runtime behavior on any
// kernel you target — including that one — remain entirely yours to establish.
//
// ----------------------------------------------------------------------------
// THE CONFIGURATION MUST MATCH THE SERVER, BYTE FOR BYTE
// ----------------------------------------------------------------------------
//
// A QUIC-LB connection ID does NOT describe its own shape. The first octet's
// three high bits are the config rotation; its five LOW BITS ARE RANDOM. They
// are not a length, not a version, and not anything a program may read. There
// is nothing on the wire that tells you the server-ID length, the nonce length,
// or the total connection-ID length.
//
// Every one of those comes from THIS FILE'S CONSTANTS and must equal the
// server's `quicLb` option exactly:
//
//     createServer({ quicLb: { serverId, nonceLen, configRotation } })
//
//     SERVER_ID_LEN     == serverId.length
//     NONCE_LEN         == nonceLen
//     CONFIG_ROTATION   == configRotation (default 0)
//     CID_LEN           == 1 + SERVER_ID_LEN + NONCE_LEN   (derived)
//
// Get one of them wrong and the program reads a different layout than the
// server writes: it will decode nonce bytes as a server ID, miss in the map,
// and fall back to 4-tuple hashing for every packet. The symptom looks like a
// flaky network, not like a misconfiguration. There is no way to detect the
// mismatch from the wire, because the wire does not carry the answer.
//
// Layout, per draft-ietf-quic-load-balancers-21 §5.2/§5.3 (keyless), the same
// revision `crates/native/src/quic_lb.rs` and
// `packages/webtransport/src/quic-lb.ts` are pinned to:
//
//     first octet   3 config-rotation bits + 5 random bits   §3.1, §3.3
//     server ID     SERVER_ID_LEN octets, >= 1               §5.3
//     nonce         NONCE_LEN octets, >= 4, random per CID   §5.4
//
// ----------------------------------------------------------------------------
// THE HARD PART IS NOT THIS FILE
// ----------------------------------------------------------------------------
//
// Keeping BPF_MAP_TYPE_REUSEPORT_SOCKARRAY correct across instance restarts is
// the operator's problem, and it is the hard part of this whole pattern. A
// socket leaves the sockarray when its process dies; the replacement process
// must re-register its socket at THE SAME SLOT, under the same server ID, or
// its connections are unreachable. Nothing in the kernel does this for you.
// Until the slot is repopulated, that instance's flows fall through to the
// fallback below — that is, to 4-tuple hashing, which is exactly the behaviour
// this program exists to avoid.
//
// See examples/quic-lb/README.md for the restart/rehash discussion and
// docs/quic-lb.md for how the pieces compose.

#include <linux/bpf.h>
#include <linux/in.h>
#include <linux/udp.h>
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_endian.h>

// --- Configuration. Mirror the server's `quicLb` option here. ---------------

#define SERVER_ID_LEN 2
#define NONCE_LEN 8
#define CONFIG_ROTATION 0

#define CID_LEN (1 + SERVER_ID_LEN + NONCE_LEN)

// Slots in the sockarray. One per instance sharing the port. Overridable at
// build time (-DMAX_INSTANCES=N) for boxes with more cores than the default
// assumes.
#ifndef MAX_INSTANCES
#define MAX_INSTANCES 8
#endif

// Fixed-width map key so the hash key has no uninitialised padding. Only the
// first SERVER_ID_LEN octets are ever meaningful; the rest stay zero.
#define SERVER_ID_KEY_LEN 8

#if SERVER_ID_LEN < 1 || SERVER_ID_LEN > SERVER_ID_KEY_LEN
#error "SERVER_ID_LEN must be between 1 and SERVER_ID_KEY_LEN"
#endif
#if NONCE_LEN < 4
#error "draft-ietf-quic-load-balancers-21 §5.3: nonce length must be >= 4"
#endif
#if (SERVER_ID_LEN + NONCE_LEN) > 19
#error "draft-ietf-quic-load-balancers-21 §5.3: serverId + nonce must be <= 19"
#endif

// --- Wire constants ---------------------------------------------------------

#define UDP_HDR_LEN 8

// RFC 9000 §17.2 / §17.3: the header form bit. The fixed bit (0x40) is
// deliberately NOT tested anywhere in this program — see the short-header
// branch for why.
#define QUIC_HEADER_FORM_LONG 0x80

// RFC 9000 §17.2, long header packet types for QUIC version 1.
#define QUIC_LONG_TYPE_MASK 0x30
#define QUIC_LONG_TYPE_INITIAL 0x00
#define QUIC_LONG_TYPE_0RTT 0x10
#define QUIC_LONG_TYPE_HANDSHAKE 0x20
#define QUIC_LONG_TYPE_RETRY 0x30

// Enough for the UDP header plus a long header's first octet, 4-octet version
// and DCID-length octet: bytes 0..13 inclusive.
#define PREFIX_LEN (UDP_HDR_LEN + 6)

#define CONFIG_ROTATION_SHIFT 5
#define CONFIG_ROTATION_UNROUTABLE 0x07 // §3.2

struct server_id_key {
	__u8 id[SERVER_ID_KEY_LEN];
};

struct {
	__uint(type, BPF_MAP_TYPE_REUSEPORT_SOCKARRAY);
	__uint(max_entries, MAX_INSTANCES);
	__type(key, __u32);
	__type(value, __u64);
} socks SEC(".maps");

// Populated by the loader from the same table that configures each instance's
// `quicLb.serverId`. Server ID -> sockarray slot.
struct {
	__uint(type, BPF_MAP_TYPE_HASH);
	__uint(max_entries, MAX_INSTANCES);
	__type(key, struct server_id_key);
	__type(value, __u32);
} slot_by_server_id SEC(".maps");

// Counters, so an operator can see how often the fallback is taken. Index:
// 0 = steered, 1 = fallback (any reason).
//
// PER-CPU, not a shared ARRAY. A global array would need an atomic
// read-modify-write on every packet, putting one cache line under contention
// from every core the NIC steers into — a measurable per-packet cost on the
// hot path, paid purely for observability. A per-CPU array gives each core its
// own copy, so the increment below is an ordinary non-atomic add.
//
// THE CONSEQUENCE IS THE READER'S: `bpftool map dump` returns one value per CPU
// for each key, and the total is their sum. A reader that takes the first
// element sees one core's share and under-reports. See the README and the
// `stats` step in attach.sh.example.
struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, 2);
	__type(key, __u32);
	__type(value, __u64);
} steer_stats SEC(".maps");

// Per-slot packet counters, so a reader can put the number of packets this
// program dispatched to a slot next to that instance's own received-datagram
// count and see whether the two agree. Split by header form: a short header is
// steady-state traffic routed by the decoded server ID, a long header is a
// handshake packet (routed by server ID once the server's CID is in use, or
// placed by client-DCID hash before that).
//
// Deliberately a SEPARATE map from `steer_stats` rather than more keys in it:
// `steer_stats` keys 0/1 are a frozen contract that readers reject other keys
// from. This map is keyed by sockarray slot, so it needs its own dimension.
//
// PER-CPU for the same reason `steer_stats` is, and with the same consequence
// for the reader: `bpftool map dump` returns one value per CPU per key, and
// the total is their sum.
//
// Only packets this program actually SELECTED a socket for are counted here.
// The fail-open path (SK_PASS without a selection) has no slot to attribute
// to and stays counted by `steer_stats` key 1; this program never returns
// SK_DROP, so there is no drop counter.
struct slot_packet_counts {
	__u64 short_header;
	__u64 long_header;
};

struct {
	__uint(type, BPF_MAP_TYPE_PERCPU_ARRAY);
	__uint(max_entries, MAX_INSTANCES);
	__type(key, __u32);
	__type(value, struct slot_packet_counts);
} slot_packets SEC(".maps");

static __always_inline void bump_slot(__u32 slot, __u8 is_long)
{
	struct slot_packet_counts *counts =
		bpf_map_lookup_elem(&slot_packets, &slot);

	// Per-CPU value: this CPU is the only writer, so plain increments are
	// correct and no atomic is needed. An out-of-range slot cannot happen
	// here (bpf_sk_select_reuseport already accepted it) but the lookup is
	// null-checked anyway, which is what the verifier requires.
	if (!counts)
		return;
	if (is_long)
		counts->long_header += 1;
	else
		counts->short_header += 1;
}

static __always_inline void bump(__u32 slot)
{
	__u64 *count = bpf_map_lookup_elem(&steer_stats, &slot);

	// Per-CPU value: this CPU is the only writer, so a plain increment is
	// correct and no atomic is needed.
	if (count)
		*count += 1;
}

// Every early return lands here.
//
// FALLBACK POLICY: SK_PASS WITHOUT SELECTING A SOCKET.
//
// The kernel then applies its own reuseport selection, i.e. the 4-tuple hash.
// This is deliberately a pass, never SK_DROP: the cases that reach it are
// mostly legitimate traffic that simply cannot be routed by connection ID yet
// (see the first-flight case below), and a program that drops what it does not
// understand black-holes new connections and any non-QUIC probe that lands on
// the port. A pass costs correctness of steering, which is already unavailable
// for these packets; a drop would cost the connection outright.
//
// The cost is real and bounded: a flow steered by 4-tuple hash is not
// rebind-stable, so a client address change inside the fallback window lands on
// the wrong instance and stalls that connection to idle timeout. See
// docs/quic-lb.md.
static __always_inline int fallback(void)
{
	bump(1);
	return SK_PASS;
}

// PLACEMENT POLICY FOR CLIENT-CHOSEN DCIDs (long header, QUIC v1 only).
//
// A client's opening Initial carries a DCID the client invented (RFC 9000
// §7.2, at least 8 octets, required random). The CID map cannot route it, and
// the previous policy handed it to the kernel's 4-tuple reuseport hash. That
// hash decides which instance ACCEPTS the connection — the accepting instance
// mints the server CID that pins the session to itself — so session placement
// was 4-tuple-hash luck for the connection's whole lifetime.
//
// Measured on the G6 c-32 rig (r74, 20,000 sessions over 16 instances,
// fixed-source-port generator): the kernel hash concentrated 2,345 sessions on
// one instance against an ideal of 1,250 (uniform placement predicts a maximum
// near 1,350), and that 1.88x-hot instance saturated its two-worker runtime at
// 96% while the host idled at 63% — the sole cause of the ack-p99 cliff
// between 10k and 20k sessions.
//
// So place deliberately instead: FNV-1a over the first 8 octets of the
// client's random DCID, modulo the instance count. Random octets give a
// uniform placement, and the same DCID always lands on the same instance, so
// a retransmitted Initial — or the whole first flight, even across a client
// address change — stays on the instance that will answer it. That is
// strictly more stable than the 4-tuple hash this replaces.
//
// Anything that cannot be placed this way (a DCID shorter than the §7.2
// minimum, a read past the end of a truncated datagram, an empty target slot)
// takes the ordinary fallback: a pass, never a drop, for the reasons above.
static __always_inline int place_by_client_dcid(struct sk_reuseport_md *reuse,
						__u8 dcid_len)
{
	__u8 dcid[8];
	__u32 hash = 0x811c9dc5; // FNV-1a offset basis
	__u32 slot;
	int i;

	// RFC 9000 §7.2: an opening Initial's DCID is at least 8 octets. A
	// shorter DCID is not a v1 opening Initial; leave it to the kernel
	// hash rather than guess a placement from too little entropy.
	if (dcid_len < 8)
		return fallback();
	if (bpf_skb_load_bytes(reuse, UDP_HDR_LEN + 6, dcid, sizeof(dcid)) < 0)
		return fallback();
#pragma unroll
	for (i = 0; i < 8; i++) {
		hash ^= dcid[i];
		hash *= 0x01000193; // FNV-1a prime
	}
	slot = hash % MAX_INSTANCES;
	if (bpf_sk_select_reuseport(reuse, &socks, &slot, 0) != 0)
		// The hashed slot is empty (that instance is down or not yet
		// registered). Fall back rather than drop.
		return fallback();

	// Counted as steered: this is the program deliberately selecting a
	// socket, not the kernel hash. The steered/fallback counters keep
	// their documented meaning of "this program placed it" versus
	// "the kernel decided".
	bump(0);
	// Long header by construction: this path is only reached from the long
	// header branch below.
	bump_slot(slot, 1);
	return SK_PASS;
}

SEC("sk_reuseport")
int steer_by_cid(struct sk_reuseport_md *reuse)
{
	__u8 prefix[PREFIX_LEN];
	__u8 head[1 + SERVER_ID_LEN];
	struct server_id_key key = {};
	__u32 cid_off;
	__u32 *slot;
	__u8 first_octet;
	__u8 is_long;
	__u32 version;
	int i;

	// Only UDP carries QUIC here; a TCP reuseport group sharing this program
	// would be a configuration error.
	if (reuse->ip_protocol != IPPROTO_UDP)
		return fallback();

	// Offsets below are relative to the start of the UDP header, which is
	// where sk_reuseport's payload view begins on the kernels this was
	// written against. VERIFY THIS ON YOUR KERNEL before trusting the
	// program: tools/testing/selftests/bpf/progs/test_select_reuseport_kern.c
	// in the kernel tree is the reference for what ctx offsets mean. If your
	// kernel hands you the payload already past the UDP header, drop
	// UDP_HDR_LEN from every offset here.
	//
	// A short read fails the whole call, which is the too-short-packet case:
	// a datagram that cannot hold a QUIC long header is not ours to route.
	if (bpf_skb_load_bytes(reuse, 0, prefix, sizeof(prefix)) < 0)
		return fallback();

	first_octet = prefix[UDP_HDR_LEN];

	is_long = (first_octet & QUIC_HEADER_FORM_LONG) ? 1 : 0;

	if (is_long) {
		// RFC 9000 §17.2 long header:
		//   +0 first octet, +1..+4 version, +5 DCID length, +6 DCID.
		version = ((__u32)prefix[UDP_HDR_LEN + 1] << 24) |
			  ((__u32)prefix[UDP_HDR_LEN + 2] << 16) |
			  ((__u32)prefix[UDP_HDR_LEN + 3] << 8) |
			  ((__u32)prefix[UDP_HDR_LEN + 4]);

		// Version Negotiation (§17.2.1). Server-to-client only, so it
		// should never arrive on an ingress port; if one does, its DCID
		// is the client's chosen source CID, not ours. Not routable.
		if (version == 0)
			return fallback();

		// Any version but QUIC v1 has a header this parser has not been
		// told how to read. Steering it by these offsets would be a
		// guess. (Add your versions here deliberately, not by
		// widening the check.)
		if (version != 0x00000001)
			return fallback();

		switch (first_octet & QUIC_LONG_TYPE_MASK) {
		case QUIC_LONG_TYPE_RETRY:
			// Server-to-client (§17.2.5); nothing to steer.
			return fallback();
		case QUIC_LONG_TYPE_INITIAL:
		case QUIC_LONG_TYPE_0RTT:
		case QUIC_LONG_TYPE_HANDSHAKE:
		default:
			// Initial and 0-RTT fall through to the same DCID check
			// as Handshake, deliberately. Only the client's *first*
			// Initial carries a destination CID the client invented
			// (RFC 9000 §7.2); from the moment it sees the server's
			// Initial or Retry it uses the server's Source
			// Connection ID as the DCID "for subsequent packets,
			// including any 0-RTT packets" (§7.2). Retransmitted
			// Initials, the Initial that acknowledges the server's
			// flight, and post-Initial 0-RTT therefore all carry OUR
			// server ID and are routable. Rejecting the whole packet
			// type would push every one of them onto the 4-tuple
			// hash and stretch the unsteerable window well past
			// where it actually ends.
			//
			// The genuinely unroutable case — the client's opening
			// Initial — is not special-cased because it does not
			// need to be: its DCID is random, so it fails the
			// CID_LEN check, the rotation check, or the map lookup,
			// and lands in the same fallback by the ordinary path.
			//
			// Residual risk, stated: a client-chosen random CID that
			// is exactly CID_LEN octets AND whose top three bits
			// happen to equal CONFIG_ROTATION AND whose next
			// SERVER_ID_LEN octets happen to hit in the map will be
			// steered. The cost is bounded — an opening Initial is a
			// connection no instance owns yet, so any member may
			// answer it; the worst case is a multi-packet first
			// flight split across two instances, which the client
			// recovers from by retransmission.
			break;
		}

		// The DCID is routable by server ID only if it is the length
		// this configuration issues. Any other length is a client-chosen
		// DCID (the opening Initial) or another endpoint's connection
		// ID; place it deliberately by hashing the client's random
		// octets instead of leaving placement to the kernel hash.
		if (prefix[UDP_HDR_LEN + 5] != CID_LEN)
			return place_by_client_dcid(reuse, prefix[UDP_HDR_LEN + 5]);

		cid_off = UDP_HDR_LEN + 6;
	} else {
		// RFC 9000 §17.3 short header: the destination CID starts at
		// byte 1 and its length IS NOT ON THE WIRE. CID_LEN above is
		// the only source of that number.
		//
		// THE FIXED BIT IS NOT TESTED HERE, AND MUST NOT BE.
		//
		// RFC 9000 §17.3 calls bit 0x40 "fixed" and requires it set,
		// but RFC 9287 (Greasing the QUIC Bit) lets an endpoint that
		// received the `grease_quic_bit` transport parameter clear it
		// at random, precisely so that middleboxes stop treating it as
		// an invariant. quinn enables that by default —
		// `grease_quic_bit: true` in quinn-proto 0.11.16
		// `config/mod.rs:63` — and this repository never overrides it,
		// so a greasing peer (Chrome among them) clears the bit on
		// roughly half its 1-RTT packets. A program that requires the
		// bit sends half of a steady-state connection's traffic to the
		// 4-tuple hash, which is the exact failure this program exists
		// to prevent, and it presents as a flaky network.
		//
		// Nothing is lost by dropping the test. A short header carries
		// no version and no length field, so the fixed bit was never a
		// reliable "is this QUIC" signal in the first place. What
		// actually rejects foreign traffic here is the chain below: the
		// config-rotation codepoint must be ours, and the decoded
		// server ID must hit in `slot_by_server_id`. Anything else
		// takes the fallback, which is a pass, not a drop.
		cid_off = UDP_HDR_LEN + 1;
	}

	// First octet of the connection ID plus the server-ID octets that follow
	// it. The nonce is never read: it is random by construction (§5.4) and
	// carries no routing information.
	if (bpf_skb_load_bytes(reuse, cid_off, head, sizeof(head)) < 0)
		return fallback();

	// §3.1/§3.2: the config-rotation codepoint. 0b111 means the CID is
	// explicitly unroutable. A codepoint that is not ours belongs to another
	// QUIC-LB configuration generation — during a rotation an operator would
	// consult a second table here; this example routes one generation only.
	if ((head[0] >> CONFIG_ROTATION_SHIFT) != CONFIG_ROTATION)
		return fallback();

#pragma unroll
	for (i = 0; i < SERVER_ID_LEN; i++)
		key.id[i] = head[1 + i];

	// Unroutable or foreign connection ID: a CID issued by some endpoint
	// that is not in this group at all, or by an instance whose slot has not
	// been (re-)registered since it restarted. Both miss here, and both take
	// the fallback rather than a drop — the server ID we decoded may be
	// nonsense bytes from a non-QUIC-LB CID, and dropping on that guess
	// would black-hole traffic this group has no business judging.
	slot = bpf_map_lookup_elem(&slot_by_server_id, &key);
	if (!slot)
		return fallback();

	if (bpf_sk_select_reuseport(reuse, &socks, slot, 0) != 0)
		// The slot is empty (the instance is down or not yet
		// re-registered). Fall back rather than drop, so the connection
		// gets an answer from somewhere.
		return fallback();

	bump(0);
	bump_slot(*slot, is_long);
	return SK_PASS;
}

// Dual-licensed so the program can use GPL-only helpers if you add any, while
// the file itself stays under this repository's MIT license.
char _license[] SEC("license") = "Dual MIT/GPL";
