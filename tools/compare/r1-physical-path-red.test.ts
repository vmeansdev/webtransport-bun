import { describe, expect, test } from "bun:test";

import {
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CHILD_OBSERVATION_FORBIDDEN,
	R1_DIRECT_CABLE_RECEIPTS,
	R1_DIRECT_CABLE_RECEIPT_BYTES,
	R1_DIRECT_CABLE_RECEIPT_SHA256,
	R1_SUPERVISOR_COMMAND_RECEIPTS,
	R1_SUPERVISOR_COMMAND_RECEIPT_BYTES,
	R1_SUPERVISOR_COMMAND_RECEIPT_SHA256,
	R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S,
	R1_SUPERVISOR_PATH_RECEIPTS,
	R1_SUPERVISOR_PATH_RECEIPT_BYTES,
	R1_SUPERVISOR_PATH_RECEIPT_SHA256,
	R1_SUPERVISOR_QDISC_RECEIPTS,
	R1_SUPERVISOR_QDISC_RECEIPT_BYTES,
	R1_SUPERVISOR_QDISC_RECEIPT_SHA256,
	R1_SUPERVISOR_CLEANUP_RECEIPTS,
	R1_SUPERVISOR_CLEANUP_RECEIPT_BYTES,
	R1_SUPERVISOR_CLEANUP_RECEIPT_SHA256,
	R1_SSH_HOST_RECEIPT,
	R1_SSH_HOST_RECEIPT_BYTES,
	R1_SSH_HOST_RECEIPT_SHA256,
	R1_SSH_HOST_RECEIPTS,
	R1_SSH_HOST_RECEIPTS_BYTES,
	R1_SSH_HOST_RECEIPTS_SHA256,
	R1_SUPERVISOR_PHYSICAL_OBSERVATION,
	R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES,
	R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256,
	canonicalBytes,
	R1_FINAL_CANDIDATE_HEAD,
	R1_MAC_DIRECTORY_IDENTITY,
	R1_MAC_STAGING_DIRECTORY_IDENTITY,
	R1_LINUX_DIRECTORY_IDENTITY,
	EXPECTED_CELL_IDS,
	byteFlip,
	sha256Hex,
	importExpectedModule,
	requiredExport,
	setAtPath,
} from "./r1-fixtures.ts";

describe("R1 RED: supervisor-owned physical-path observations", () => {
	test("an off-loop arm is indistinguishable from its primary on the wire, the transport and the physical path", () => {
		// The second tier is a consumption strategy, not a protocol. Nothing
		// below the arm — TLS, topology, impairment, capture — may see it.
		const byArm = (suffix: string) =>
			R1_DIRECT_CABLE_RECEIPTS.filter((receipt) =>
				receipt.runId.includes(`/${suffix}/rep-`),
			);
		const wire = (suffix: string) =>
			new Set(
				byArm(suffix).map(
					(receipt) =>
						`${receipt.transport}|${receipt.protocol}|${receipt.peerObservation}|${receipt.interface}|${receipt.serverPort}`,
				),
			);

		expect(byArm("ws-worker")).toHaveLength(126);
		expect(byArm("wt-stream-sink")).toHaveLength(54);
		expect([...wire("ws-worker")]).toEqual([...wire("ws")]);
		expect([...wire("wt-stream-sink")]).toEqual([...wire("wt")]);
		expect([...wire("wt-stream-sink")]).toEqual(["wt|udp|af-packet|eno1|4433"]);
		expect([...wire("ws-worker")]).toEqual(["ws|tcp|inet-diag|eno1|4433"]);
	});

	test("direct-cable receipt set has exactly 768 ordered entries with independent Mac and Linux observations", async () => {
		const mod = await importExpectedModule("./supervisor-protocol.ts");
		expect(R1_DIRECT_CABLE_RECEIPTS).toHaveLength(768);
		expect(
			R1_DIRECT_CABLE_RECEIPTS.map((receipt) => receipt.executionIndex),
		).toEqual(Array.from({ length: 768 }, (_, index) => index));
		expect(
			R1_DIRECT_CABLE_RECEIPTS.every(
				(receipt) =>
					receipt.status === "OBSERVED" &&
					receipt.macAddress === "10.99.0.1" &&
					receipt.interface === "eno1" &&
					receipt.linuxAddress === "10.99.0.2" &&
					receipt.serverPort === 4433 &&
					receipt.packetsMacToLinux > 0 &&
					receipt.packetsLinuxToMac > 0 &&
					receipt.bytesMacToLinux > 0 &&
					receipt.bytesLinuxToMac > 0 &&
					receipt.captureDropCount === 0,
			),
		).toBe(true);
		expect(
			requiredExport(
				mod,
				"validateSupervisorPhysicalReceipts",
			)({
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
				finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
				observation: R1_SUPERVISOR_PHYSICAL_OBSERVATION,
				receipts: R1_DIRECT_CABLE_RECEIPTS,
				commandReceipts: R1_SUPERVISOR_COMMAND_RECEIPTS,
				pathReceipts: R1_SUPERVISOR_PATH_RECEIPTS,
				qdiscReceipts: R1_SUPERVISOR_QDISC_RECEIPTS,
				cleanupReceipts: R1_SUPERVISOR_CLEANUP_RECEIPTS,
				sshHostReceipts: R1_SSH_HOST_RECEIPTS,
				rootIdentities: {
					macCampaign: R1_MAC_DIRECTORY_IDENTITY,
					macStaging: R1_MAC_STAGING_DIRECTORY_IDENTITY,
					linuxStaging: R1_LINUX_DIRECTORY_IDENTITY,
				},
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				receiptCount: 768,
				linuxReceiptCount: 768,
			}),
		);
		expect(
			R1_SUPERVISOR_COMMAND_RECEIPTS.map((receipt) => receipt.argv),
		).toEqual([
			["route", "-n", "get", "10.99.0.2"],
			["ifconfig", "en8"],
			["ip", "-j", "route", "get", "10.99.0.1", "from", "10.99.0.2"],
			["ip", "-j", "address", "show", "dev", "eno1"],
			["tc", "-j", "qdisc", "show", "dev", "eno1"],
		]);
		expect(
			R1_SUPERVISOR_COMMAND_RECEIPTS.map((receipt) => ({
				schema: receipt.schema,
				hostId: receipt.hostId,
				argv: receipt.argv,
				exitCode: receipt.exitCode,
				stdoutSize: receipt.stdoutSize,
				stderrSize: receipt.stderrSize,
				startedAt: receipt.startedAt,
				completedAt: receipt.completedAt,
			})),
		).toEqual([
			{
				schema: "supervisor-command-receipt/v1",
				hostId: "mac-controller-01",
				argv: ["route", "-n", "get", "10.99.0.2"],
				exitCode: 0,
				stdoutSize: 128,
				stderrSize: 0,
				startedAt: "2026-08-24T12:20:00.000Z",
				completedAt: "2026-08-24T12:20:00.010Z",
			},
			{
				schema: "supervisor-command-receipt/v1",
				hostId: "mac-controller-01",
				argv: ["ifconfig", "en8"],
				exitCode: 0,
				stdoutSize: 128,
				stderrSize: 0,
				startedAt: "2026-08-24T12:20:01.000Z",
				completedAt: "2026-08-24T12:20:01.010Z",
			},
			{
				schema: "supervisor-command-receipt/v1",
				hostId: "linux-bench-01",
				argv: ["ip", "-j", "route", "get", "10.99.0.1", "from", "10.99.0.2"],
				exitCode: 0,
				stdoutSize: 128,
				stderrSize: 0,
				startedAt: "2026-08-24T12:20:02.000Z",
				completedAt: "2026-08-24T12:20:02.010Z",
			},
			{
				schema: "supervisor-command-receipt/v1",
				hostId: "linux-bench-01",
				argv: ["ip", "-j", "address", "show", "dev", "eno1"],
				exitCode: 0,
				stdoutSize: 128,
				stderrSize: 0,
				startedAt: "2026-08-24T12:20:03.000Z",
				completedAt: "2026-08-24T12:20:03.010Z",
			},
			{
				schema: "supervisor-command-receipt/v1",
				hostId: "linux-bench-01",
				argv: ["tc", "-j", "qdisc", "show", "dev", "eno1"],
				exitCode: 0,
				stdoutSize: 128,
				stderrSize: 0,
				startedAt: "2026-08-24T12:20:04.000Z",
				completedAt: "2026-08-24T12:20:04.010Z",
			},
		]);
		expect(
			R1_SUPERVISOR_COMMAND_RECEIPTS.every(
				(receipt, index) =>
					R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[index] ===
						sha256Hex(canonicalBytes(receipt)) &&
					/^[a-f0-9]{64}$/.test(receipt.toolSha256) &&
					/^[a-f0-9]{64}$/.test(receipt.stdoutSha256) &&
					/^[a-f0-9]{64}$/.test(receipt.stderrSha256),
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.map(
				(receipt) => `${receipt.cellId}|${receipt.phase}|${receipt.hostId}`,
			),
		).toEqual(
			EXPECTED_CELL_IDS.flatMap((cellId) =>
				(["pre-cell", "post-cell"] as const).flatMap((phase) => [
					`${cellId}|${phase}|mac-controller-01`,
					`${cellId}|${phase}|linux-bench-01`,
				]),
			),
		);
		const expectedPathBindings = EXPECTED_CELL_IDS.flatMap((cellId) =>
			(["pre-cell", "post-cell"] as const).flatMap((phase) => [
				{
					schema: "supervisor-path-receipt/v1" as const,
					phase,
					cellId,
					hostId: "mac-controller-01" as const,
					platform: "darwin-arm64" as const,
					interface: "en8" as const,
					interfaceIndex: 18,
					sourceAddress: "10.99.0.1" as const,
					destinationAddress: "10.99.0.2" as const,
					mtu: 1500 as const,
					routeCommandReceiptSha256: R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[0]!,
					interfaceCommandReceiptSha256:
						R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[1]!,
				},
				{
					schema: "supervisor-path-receipt/v1" as const,
					phase,
					cellId,
					hostId: "linux-bench-01" as const,
					platform: "linux-x86_64" as const,
					interface: "eno1" as const,
					interfaceIndex: 2,
					sourceAddress: "10.99.0.2" as const,
					destinationAddress: "10.99.0.1" as const,
					mtu: 1500 as const,
					routeCommandReceiptSha256: R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[2]!,
					interfaceCommandReceiptSha256:
						R1_SUPERVISOR_COMMAND_RECEIPT_SHA256S[3]!,
				},
			]),
		);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.map((receipt) => ({
				schema: receipt.schema,
				phase: receipt.phase,
				cellId: receipt.cellId,
				hostId: receipt.hostId,
				platform: receipt.platform,
				interface: receipt.interface,
				interfaceIndex: receipt.interfaceIndex,
				sourceAddress: receipt.sourceAddress,
				destinationAddress: receipt.destinationAddress,
				mtu: receipt.mtu,
				routeCommandReceiptSha256: receipt.routeCommandReceiptSha256,
				interfaceCommandReceiptSha256: receipt.interfaceCommandReceiptSha256,
			})),
		).toEqual(expectedPathBindings);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.every(
				(receipt) =>
					/^[a-f0-9]{64}$/.test(receipt.supervisorSha256) &&
					/^[a-f0-9]{64}$/.test(receipt.socketRouteProbeSha256) &&
					/^2026-08-24T12:2\d:(00|30)\.000Z$/.test(receipt.capturedAt),
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_QDISC_RECEIPTS.map((receipt) => receipt.executionIndex),
		).toEqual(Array.from({ length: 768 }, (_, index) => index));
		expect(
			R1_SUPERVISOR_CLEANUP_RECEIPTS.map((receipt) => receipt.executionIndex),
		).toEqual(Array.from({ length: 768 }, (_, index) => index));
		expect(R1_SSH_HOST_RECEIPTS).toEqual([R1_SSH_HOST_RECEIPT]);
	});

	test("physical observation rejects copied plans, loopback, same-host roles, Tailscale measurement, wrong interface/source/MTU, missing Linux, peer, qdisc, tool, SSH, or cleanup facts", async () => {
		const mod = await importExpectedModule("./supervisor-protocol.ts");
		const valid = {
			authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
			observation: R1_SUPERVISOR_PHYSICAL_OBSERVATION,
			receipts: R1_DIRECT_CABLE_RECEIPTS,
			commandReceipts: R1_SUPERVISOR_COMMAND_RECEIPTS,
			pathReceipts: R1_SUPERVISOR_PATH_RECEIPTS,
			qdiscReceipts: R1_SUPERVISOR_QDISC_RECEIPTS,
			cleanupReceipts: R1_SUPERVISOR_CLEANUP_RECEIPTS,
			sshHostReceipts: R1_SSH_HOST_RECEIPTS,
		};
		for (const [mutation, code] of [
			[
				setAtPath(valid, ["observation", "mac", "address"], "127.0.0.1"),
				"TRUST_SOURCE_ADDRESS_MISMATCH",
			],
			[
				setAtPath(valid, ["observation", "linux", "address"], "10.99.0.1"),
				"TRUST_HOST_IDS_MUST_DIFFER",
			],
			[
				setAtPath(valid, ["observation", "mac", "interface"], "en0"),
				"TRUST_ROUTE_MISMATCH",
			],
			[
				setAtPath(valid, ["observation", "linux", "interface"], "tailscale0"),
				"TRUST_TAILSCALE_MEASUREMENT_FORBIDDEN",
			],
			[
				setAtPath(valid, ["observation", "mac", "mtu"], 9000),
				"TRUST_MTU_MISMATCH",
			],
			[
				setAtPath(valid, ["observation", "linux"], undefined),
				"TRUST_LINUX_OBSERVATION_MISSING",
			],
			[
				setAtPath(valid, ["observation", "linux", "peer"], "unknown"),
				"TRUST_SERVER_PEER_MISMATCH",
			],
			[
				setAtPath(valid, ["observation", "mac", "qdiscAfter"], "netem loss 5%"),
				"TRUST_QDISC_MISMATCH",
			],
			[
				setAtPath(valid, ["observation", "linux", "tool"], "child-reported"),
				"TRUST_OBSERVATION_COMMAND_MISMATCH",
			],
			[
				setAtPath(
					valid,
					["observation", "sshHostReceiptSha256"],
					"0".repeat(64),
				),
				"TRUST_SSH_HOST_MISMATCH",
			],
			[
				setAtPath(valid, ["observation", "cleanup", "allRunsRestored"], false),
				"TRUST_CLEANUP_OBSERVATION_MISSING",
			],
			[
				{ ...valid, plannedFacts: R1_SUPERVISOR_PHYSICAL_OBSERVATION },
				"TRUST_CHILD_OBSERVATION_FORBIDDEN",
			],
		] as const) {
			expect(
				requiredExport(mod, "validateSupervisorPhysicalReceipts")(mutation),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		for (const mutation of [
			setAtPath(valid, ["commandReceipts", 0, "argv", 0], "ifconfig"),
			setAtPath(valid, ["pathReceipts", 0, "interface"], "en0"),
			setAtPath(valid, ["qdiscReceipts", 0, "afterKind"], "netem"),
			setAtPath(valid, ["cleanupReceipts", 0, "status"], "DIRTY"),
			setAtPath(valid, ["sshHostReceipts", 0, "hostId"], "untrusted-host"),
		]) {
			expect(
				requiredExport(mod, "validateSupervisorPhysicalReceipts")(mutation),
			).toEqual(expect.objectContaining({ ok: false }));
		}
	});

	test("physical receipt classes are canonical, complete, bidirectional, and mutation-sensitive", () => {
		expect(R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES).toEqual(
			canonicalBytes(R1_SUPERVISOR_PHYSICAL_OBSERVATION),
		);
		expect(sha256Hex(R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES)).toBe(
			R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256,
		);
		const allReceiptBytes = [
			R1_DIRECT_CABLE_RECEIPT_BYTES,
			R1_SUPERVISOR_COMMAND_RECEIPT_BYTES,
			R1_SUPERVISOR_PATH_RECEIPT_BYTES,
			R1_SUPERVISOR_QDISC_RECEIPT_BYTES,
			R1_SUPERVISOR_CLEANUP_RECEIPT_BYTES,
			R1_SSH_HOST_RECEIPT_BYTES,
			R1_SSH_HOST_RECEIPTS_BYTES,
		];
		expect(
			allReceiptBytes.every((bytes) =>
				new TextDecoder().decode(bytes).endsWith("\n"),
			),
		).toBe(true);
		expect(sha256Hex(R1_DIRECT_CABLE_RECEIPT_BYTES)).toBe(
			R1_DIRECT_CABLE_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_SUPERVISOR_COMMAND_RECEIPT_BYTES)).toBe(
			R1_SUPERVISOR_COMMAND_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_SUPERVISOR_PATH_RECEIPT_BYTES)).toBe(
			R1_SUPERVISOR_PATH_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_SUPERVISOR_QDISC_RECEIPT_BYTES)).toBe(
			R1_SUPERVISOR_QDISC_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_SUPERVISOR_CLEANUP_RECEIPT_BYTES)).toBe(
			R1_SUPERVISOR_CLEANUP_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_SSH_HOST_RECEIPT_BYTES)).toBe(
			R1_SSH_HOST_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_SSH_HOST_RECEIPTS_BYTES)).toBe(
			R1_SSH_HOST_RECEIPTS_SHA256,
		);
		expect(R1_SUPERVISOR_COMMAND_RECEIPTS).toHaveLength(5);
		expect(R1_SUPERVISOR_PATH_RECEIPTS).toHaveLength(140);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.every(
				(receipt) =>
					(receipt.hostId === "mac-controller-01" &&
						receipt.platform === "darwin-arm64" &&
						receipt.interface === "en8" &&
						receipt.sourceAddress === "10.99.0.1" &&
						receipt.destinationAddress === "10.99.0.2") ||
					(receipt.hostId === "linux-bench-01" &&
						receipt.platform === "linux-x86_64" &&
						receipt.interface === "eno1" &&
						receipt.sourceAddress === "10.99.0.2" &&
						receipt.destinationAddress === "10.99.0.1"),
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.filter(
				(receipt) => receipt.hostId === "mac-controller-01",
			),
		).toHaveLength(70);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.filter(
				(receipt) => receipt.hostId === "linux-bench-01",
			),
		).toHaveLength(70);
		expect(
			R1_SUPERVISOR_COMMAND_RECEIPTS.map((receipt) => receipt.argv),
		).toEqual([
			["route", "-n", "get", "10.99.0.2"],
			["ifconfig", "en8"],
			["ip", "-j", "route", "get", "10.99.0.1", "from", "10.99.0.2"],
			["ip", "-j", "address", "show", "dev", "eno1"],
			["tc", "-j", "qdisc", "show", "dev", "eno1"],
		]);
		expect(
			R1_SUPERVISOR_PATH_RECEIPTS.map(
				(receipt) => `${receipt.cellId}|${receipt.phase}|${receipt.hostId}`,
			),
		).toEqual(
			EXPECTED_CELL_IDS.flatMap((cellId) =>
				(["pre-cell", "post-cell"] as const).flatMap((phase) => [
					`${cellId}|${phase}|mac-controller-01`,
					`${cellId}|${phase}|linux-bench-01`,
				]),
			),
		);
		expect(
			R1_SUPERVISOR_QDISC_RECEIPTS.map((receipt) => receipt.executionIndex),
		).toEqual(Array.from({ length: 768 }, (_, index) => index));
		expect(
			R1_SUPERVISOR_CLEANUP_RECEIPTS.map((receipt) => receipt.executionIndex),
		).toEqual(Array.from({ length: 768 }, (_, index) => index));
		expect(R1_SSH_HOST_RECEIPTS).toEqual([R1_SSH_HOST_RECEIPT]);
		expect(R1_SUPERVISOR_QDISC_RECEIPTS).toHaveLength(768);
		expect(R1_SUPERVISOR_CLEANUP_RECEIPTS).toHaveLength(768);
		expect(
			R1_DIRECT_CABLE_RECEIPTS.every(
				(receipt) =>
					receipt.packetsMacToLinux > 0 && receipt.packetsLinuxToMac > 0,
			),
		).toBe(true);
		expect(
			R1_DIRECT_CABLE_RECEIPTS.every(
				(receipt) => receipt.protocol === "tcp" || receipt.protocol === "udp",
			),
		).toBe(true);
		expect(
			R1_DIRECT_CABLE_RECEIPTS.every(
				(receipt) => receipt.serverPgid > 0 && receipt.captureDropCount === 0,
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_QDISC_RECEIPTS.every(
				(receipt) =>
					receipt.status === "RESTORED" &&
					receipt.afterKind === "fq" &&
					receipt.restored,
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_QDISC_RECEIPTS.every(
				(receipt) =>
					receipt.schema === "supervisor-qdisc-receipt/v1" &&
					receipt.linuxHostId === "linux-bench-01" &&
					receipt.interface === "eno1" &&
					receipt.beforeKind === "fq" &&
					receipt.completedAt === "2026-08-24T12:30:01.000Z" &&
					/^[a-f0-9]{64}$/.test(receipt.expectedProfileHash) &&
					/^[a-f0-9]{64}$/.test(receipt.beforeCommandReceiptSha256) &&
					/^[a-f0-9]{64}$/.test(receipt.activeCommandReceiptSha256) &&
					/^[a-f0-9]{64}$/.test(receipt.afterCommandReceiptSha256) &&
					(receipt.activeKind === "fq"
						? receipt.applyCommandReceiptSha256 === null &&
							receipt.restoreCommandReceiptSha256 === null
						: receipt.activeKind === "netem" &&
							receipt.applyCommandReceiptSha256 !== null &&
							receipt.restoreCommandReceiptSha256 !== null),
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_CLEANUP_RECEIPTS.every(
				(receipt) =>
					receipt.status === "CLEAN" &&
					receipt.macPgid > 0 &&
					receipt.linuxPgid > 0 &&
					receipt.qdiscRestored,
			),
		).toBe(true);
		expect(
			R1_SUPERVISOR_CLEANUP_RECEIPTS.every(
				(receipt) =>
					receipt.schema === "supervisor-cleanup-receipt/v1" &&
					receipt.macSupervisorSha256.length === 64 &&
					receipt.linuxSupervisorSha256.length === 64 &&
					receipt.allOwnedChildrenReaped &&
					receipt.noOwnedSocketsRemain &&
					receipt.tcp4433ListenerAbsent &&
					receipt.udp4433ListenerAbsent &&
					receipt.qdiscRestored &&
					receipt.completedAt === "2026-08-24T12:30:02.000Z",
			),
		).toBe(true);
		expect(sha256Hex(byteFlip(R1_DIRECT_CABLE_RECEIPT_BYTES))).not.toBe(
			R1_DIRECT_CABLE_RECEIPT_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_SUPERVISOR_COMMAND_RECEIPT_BYTES))).not.toBe(
			R1_SUPERVISOR_COMMAND_RECEIPT_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_SUPERVISOR_PATH_RECEIPT_BYTES))).not.toBe(
			R1_SUPERVISOR_PATH_RECEIPT_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_SUPERVISOR_QDISC_RECEIPT_BYTES))).not.toBe(
			R1_SUPERVISOR_QDISC_RECEIPT_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_SUPERVISOR_CLEANUP_RECEIPT_BYTES))).not.toBe(
			R1_SUPERVISOR_CLEANUP_RECEIPT_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_SSH_HOST_RECEIPT_BYTES))).not.toBe(
			R1_SSH_HOST_RECEIPT_SHA256,
		);
	});

	test("scenario children cannot mint physical authority or replace supervisor receipts", async () => {
		const mod = await importExpectedModule("./supervisor-protocol.ts");
		expect(
			requiredExport(
				mod,
				"validateChildObservationBoundary",
			)({
				childObservation: R1_CHILD_OBSERVATION_FORBIDDEN,
				allowedKinds: [
					"artifact-payload",
					"client-telemetry",
					"server-telemetry",
				],
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateSupervisorReceiptOrigin",
			)({
				receipt: R1_DIRECT_CABLE_RECEIPTS[0],
				origin: "campaign-child",
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			}),
		);
	});
});
