/**
 * Native `reusePortSteering` option tests — the validation surface and the
 * fail-closed contract.
 *
 * Scope, stated honestly: everything kernel-facing (the sockarray insert with
 * BPF_NOEXIST, the program attach, the EEXIST sibling-eviction refusal) lives
 * in the gated Rust test in crates/native/src/reuseport_steering.rs and runs
 * on the Linux bench rig with CAP_BPF. What is portable — and what this file
 * pins — is that a malformed or cross-field-invalid option never reaches the
 * addon, and that on a non-Linux host a well-formed option is refused with
 * `E_UNSUPPORTED_ARGUMENT` instead of binding an unsteered group.
 */

import { describe, expect, it } from "bun:test";
import { createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const isLinux = process.platform === "linux";

const STEERING = {
	sockArrayPinPath: "/sys/fs/bpf/wtb-test/socks",
	key: 1,
	attachProgPinPath: "/sys/fs/bpf/wtb-test/steer_by_cid",
};
const QUIC_LB = { serverId: new Uint8Array([0x00, 0x01]), nonceLen: 8 };

function tryCreate(extra: Record<string, unknown>) {
	const port = nextPort(25310, 2000);
	return () => {
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
			...extra,
		});
		// Only reached when creation unexpectedly succeeds.
		return server.close();
	};
}

describe("native reusePortSteering option", () => {
	it("rejects steering without reusePort", () => {
		expect(tryCreate({ reusePortSteering: STEERING, quicLb: QUIC_LB })).toThrow(
			/E_INVALID_ARGUMENT: reusePortSteering requires reusePort/,
		);
	});

	it("rejects steering without quicLb — an unsteerable group must not look steered", () => {
		expect(tryCreate({ reusePort: true, reusePortSteering: STEERING })).toThrow(
			/E_INVALID_ARGUMENT: reusePortSteering requires quicLb/,
		);
	});

	it("rejects a relative sockarray pin path", () => {
		expect(
			tryCreate({
				reusePort: true,
				quicLb: QUIC_LB,
				reusePortSteering: { ...STEERING, sockArrayPinPath: "rel/socks" },
			}),
		).toThrow(/sockArrayPinPath must be an absolute bpffs path/);
	});

	it("rejects a non-integer or out-of-range key", () => {
		for (const key of [-1, 1.5, 2 ** 32, Number.NaN]) {
			expect(
				tryCreate({
					reusePort: true,
					quicLb: QUIC_LB,
					reusePortSteering: { ...STEERING, key },
				}),
			).toThrow(/key must be a non-negative 32-bit integer/);
		}
	});

	it("rejects a relative attachProgPinPath", () => {
		expect(
			tryCreate({
				reusePort: true,
				quicLb: QUIC_LB,
				reusePortSteering: { ...STEERING, attachProgPinPath: "rel/prog" },
			}),
		).toThrow(/attachProgPinPath must be an absolute bpffs path/);
	});

	it.skipIf(isLinux)(
		"refuses a well-formed option off Linux instead of binding unsteered",
		() => {
			expect(
				tryCreate({
					reusePort: true,
					quicLb: QUIC_LB,
					reusePortSteering: STEERING,
				}),
			).toThrow(/E_UNSUPPORTED_ARGUMENT: reusePortSteering requires Linux/);
		},
	);

	it.skipIf(!isLinux)(
		"fails startup (not fallback) when the pinned map is absent on Linux",
		() => {
			// /sys/fs/bpf/wtb-test/* is never created by tests: the native
			// install path must refuse with the pin-not-found message, proving
			// the fail-closed contract without needing CAP_BPF.
			expect(
				tryCreate({
					reusePort: true,
					quicLb: QUIC_LB,
					reusePortSteering: STEERING,
				}),
			).toThrow(/pin not found|requires CAP_BPF|server startup failed/);
		},
	);
});
