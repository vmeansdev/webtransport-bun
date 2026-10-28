# About this fork

This is a fork of [BiagioFesta/wtransport](https://github.com/BiagioFesta/wtransport)
carrying 0-RTT support, a set of WebTransport conformance fixes, and QPACK dynamic table
support, branched from upstream `master` at `a11e6a8`.

It exists because [webtransport-bun](https://github.com/vmeansdev/webtransport-bun) needs
0-RTT and upstream does not implement it. It is consumed as a git dependency pinned by
revision, not published to crates.io.

## Versioning

Feature commits leave the version field alone so they stay applicable upstream. The branch
tip carries a single `chore` commit setting `0.7.1-zerortt.N`, which exists only to make it
obvious in a lockfile or `cargo tree` that a build is using this fork rather than upstream
`0.7.1`.

## Contributing this upstream

The feature commits are written to be proposable as they stand: conventional commit
subjects, upstream's formatting and lint settings, no fork-specific naming, and no
references to the consuming project. Each is self-contained and green on its own.

Suggested order, smallest first:

1. `feat(server): support 0-RTT session establishment` — the configuration knobs, the
   accept path, and `SessionRequest::is_0rtt` / `handshake_confirmed`.
2. `feat(client): send the session request as 0-RTT data` — `connect_0rtt` and the
   optimistic `SETTINGS` ordering.
3. `feat(driver): recover from 0-RTT rejection instead of dropping the connection` — the
   one that touches shared code paths, and the one worth discussing first if only one can
   be raised.
4. `docs: describe the 0-RTT replay contract and its operational limits`.

The conformance commits on `feat/track1-conformance` are independent of 0-RTT and of each
other, smallest first:

5. `feat(proto): map stream error codes into the WT_APPLICATION_ERROR range` — the §4.4
   mapping, applied at the WebTransport data stream boundary only.
6. `feat(proto): encode capsules and add WT_DRAIN_SESSION` — the capsule layer could only
   parse; this is the encoder and the missing capsule type.
7. `feat(connection): close a session with a capsule instead of the connection` — the one
   worth discussing first, since it adds `Connection::close_session` alongside the existing
   `Connection::close` rather than changing what `close` means.
8. `feat(connection): support draining a session and GOAWAY` — depends on 6, and also
   fixes a peer's GOAWAY being treated as a connection error.

The QPACK commits on `feat/qpack-dynamic` are independent of both of the above:

9. `feat(qpack): add a dynamic table and decode dynamic field lines` — the table, the
   required insert count codec, and the field line forms upstream answered with
   `DynamicNotSupported`. Self-contained, no behaviour change on its own.
10. `feat(qpack): parse and emit encoder and decoder stream instructions` — the two QPACK
    streams' instruction sets, still without a caller.
11. `feat(config): let an endpoint offer a QPACK dynamic table` — the configuration knob,
    default zero, which is what makes the rest reachable.
12. `feat(qpack): keep decoder state for the connection` — the one worth discussing first:
    it makes header decoding stateful and opens a decoder stream.
13. `feat(qpack): encode field sections against the peer's dynamic table` — the encoder
    side of the table, sized and bounded by what the peer advertised.
14. `feat(qpack): insert on an encoder stream and index acknowledged entries` — the
    encoder stream, and the acknowledgements that make a reference safe to send.

Things a reviewer will reasonably ask about, all deliberate:

- `enable_0rtt` **overrides** any ticketer set through `with_custom_tls`, rather than
  refusing to build. rustls disables early data whenever the ticketer reports itself
  enabled, so the alternative is a configuration that silently does nothing. Documented
  loudly on the method and in `docs/0-RTT.md`.
- The client keeps upstream's `SETTINGS`-before-`CONNECT` ordering on the 1-RTT path and
  only reorders under 0-RTT, where waiting would give back the round trip being saved.
  `connect` is unchanged.
- `SETTINGS_QPACK_BLOCKED_STREAMS` is always advertised as zero, even when a table is
  offered. A non-zero value would oblige the decoder to park a field section until the
  inserts it references arrive, and header decoding here is synchronous and spread across
  two tasks. Zero is what RFC 9204 provides for exactly this case: the peer may only
  reference entries it knows have been received, and a section that would block is a
  connection error rather than something to hold onto.
- The encoder indexes entries but, in WebTransport, never gets to reference one. At
  blocked-streams zero only acknowledged entries may be referenced, and a connection
  carries a single header exchange: nothing is acknowledged when the `CONNECT` request is
  sent, and the response precedes the acknowledgement of its own inserts. The inserts
  still flow, and a connection carrying a second header section would index them. This is
  a property of WebTransport rather than of the implementation, and is documented in
  `docs/QPACK.md` rather than worked around.
- `SendStream::reset` and `RecvStream::stop` take a `u32` rather than a `VarInt`. The
  WebTransport application error code space is 32 bits wide by definition, so a `VarInt`
  parameter could express codes the wire format cannot carry. This is the one breaking
  signature change in the fork.

The integration tests under `wtransport/tests/` are new — upstream had none — and would
come along with the first commit.

## Keeping up with upstream

Rebase `feat/0rtt` onto upstream `master`; do not merge. The consuming project pins a
revision, so this branch's history must stay reachable: no force-pushing away a revision
that has been pinned, and no garbage-collecting it.
