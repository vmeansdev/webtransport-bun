import { expect, test } from "bun:test";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	requireDefined,
} from "./g6-c32-freeze-model.ts";
import { G6_C32_GATE_CATALOG, gateDefinitionSha256 } from "./g6-c32-gates.ts";
import { preparedGateSshArgs } from "./g6-c32-prepared-command.ts";
import {
	derivePreparedNativeProof,
	PREPARED_NATIVE_GATE_IDS,
} from "./g6-c32-prepared-proof.ts";
import {
	CAPACITY_LINUX_PROOF_TESTS,
	CAPACITY_NATIVE_PROOF_TESTS,
	capacityLocalProofArgv,
} from "./g6-capacity-proof-catalog.ts";

function fixture(
	remoteCheckoutPath = "/opt/g6/run/proof-run-attempt-1/source",
) {
	const sourceSha = "a".repeat(40),
		bootId = "11111111-1111-4111-8111-111111111111";
	const context = {
		runId: "proof-run",
		sourceSha,
		bootId,
		serverPublicIpv4: "203.0.113.10",
		knownHostsPath: "/owned/known_hosts",
		remoteCheckoutPath,
	};
	const outputs = [
		[...CAPACITY_NATIVE_PROOF_TESTS, ...CAPACITY_LINUX_PROOF_TESTS]
			.map((name) => `test ${name} ... ok`)
			.join("\n") +
			"\ntest result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n",
		"Linux\n",
		`${sourceSha}\n`,
	];
	const packets = PREPARED_NATIVE_GATE_IDS.map((id, index) => {
		const definition = requireDefined(
			G6_C32_GATE_CATALOG.gates.find((g) => g.id === id),
		);
		const [command, ...args] = requireDefined(
			capacityLocalProofArgv("candidate-local-linux")[index],
		);
		const startedAt = `2026-09-05T01:00:${String(index * 2).padStart(2, "0")}.000Z`,
			finishedAt = `2026-09-05T01:00:${String(index * 2 + 1).padStart(2, "0")}.000Z`;
		const envelope = {
			recordedAt: finishedAt,
			sequence: index + 1,
			runId: context.runId,
			phase: "PREPARED_HOST",
			operationId: `gate-${id}`,
			clockSource: "offrunner",
		};
		const operation = {
			schema: "g6-c32-operation-receipt/1",
			envelope,
			startedAt,
			finishedAt,
			durationMonotonicNs: "1000000000",
			attempt: 1,
			action: {
				command: "ssh",
				args: [
					"-i",
					"<redacted-ssh-identity>",
					"-o",
					"IdentitiesOnly=yes",
					...preparedGateSshArgs({
						command: requireDefined(command),
						args,
						remoteCwd: context.remoteCheckoutPath,
						publicIpv4: context.serverPublicIpv4,
						knownHostsPath: context.knownHostsPath,
					}),
				],
				cwd: ".",
				environmentKeys: ["G6_C32_SSH_IDENTITY_PATH"],
			},
			status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			stdoutPath: `proof-run/operations/${id}/operation.stdout`,
			stderrPath: `proof-run/operations/${id}/operation.stderr`,
			remoteTiming: null,
		};
		const gate = {
			schema: "g6-c32-gate-receipt/1",
			envelope,
			gateCatalogAuthoritySha256: canonicalAuthoritySha256(G6_C32_GATE_CATALOG),
			gate: {
				id,
				phase: "PREPARED_HOST",
				definitionSha256: gateDefinitionSha256(definition),
			},
			result: {
				verdict: "PASS",
				reason: null,
				operationReceiptPath: `operations/${id}.json`,
				operationReceiptArtifactSha256: canonicalArtifactSha256(operation),
			},
		};
		return {
			gate,
			operation,
			stdoutPath: `.scratch/proof/${id}.stdout`,
			stderrPath: `.scratch/proof/${id}.stderr`,
			stdout: requireDefined(outputs[index]),
			stderr: `g6-prepared-boot-id=${bootId}\n`,
		};
	});
	return { context, packets };
}
test.each([
	"/opt/g6/run/proof-run-attempt-1/source",
	"/root/webtransport-bun",
])("prepared proof derives actual exact-server operation bytes in %s", (checkout) => {
	const f = fixture(checkout),
		proof = derivePreparedNativeProof(f.context, f.packets);
	expect(proof.kind).toBe("candidate-local-linux");
	expect(proof.commands.map((c) => c.argv)).toEqual([
		...capacityLocalProofArgv("candidate-local-linux"),
	]);
	expect(proof.commands[0]?.stdoutSha256).toMatch(/^[a-f0-9]{64}$/);
	expect(proof.liveEvidence).toBe(false);
});
test.each([
	"host",
	"command",
	"cwd",
	"boot",
	"source",
	"platform",
	"order",
	"signal",
	"receipt",
	"catalog",
	"definition",
	"name",
	"filtered",
])("prepared proof rejects self-declared success with %s drift", (change) => {
	const f = fixture(),
		packet = requireDefined(f.packets[0]);
	if (change === "host")
		packet.operation.action.args = packet.operation.action.args.map((a) =>
			a.replace("203.0.113.10", "203.0.113.11"),
		);
	if (change === "command")
		packet.operation.action.args[packet.operation.action.args.length - 1] =
			"echo cargo test passed";
	if (change === "cwd")
		packet.operation.action.args = packet.operation.action.args.map((a) =>
			a.replace(f.context.remoteCheckoutPath, "/root/webtransport-bun"),
		);
	if (change === "boot")
		packet.stderr = packet.stderr.replace("11111111", "22222222");
	if (change === "source") requireDefined(f.packets[2]).stdout = "b".repeat(40);
	if (change === "platform") requireDefined(f.packets[1]).stdout = "Darwin\n";
	if (change === "order") f.packets.reverse();
	if (change === "signal") packet.operation.status.signal = "SIGTERM" as never;
	if (change === "receipt")
		packet.gate.result.operationReceiptArtifactSha256 = "0".repeat(64);
	if (change === "catalog")
		packet.gate.gateCatalogAuthoritySha256 = "0".repeat(64);
	if (change === "definition")
		packet.gate.gate.definitionSha256 = "0".repeat(64);
	if (change === "name") packet.gate.gate.id = "prepared-server-native-source";
	if (change === "filtered")
		packet.stdout = packet.stdout.replace("0 filtered out", "6 filtered out");
	if (change !== "receipt")
		for (const p of f.packets)
			p.gate.result.operationReceiptArtifactSha256 = canonicalArtifactSha256(
				p.operation,
			);
	expect(() => derivePreparedNativeProof(f.context, f.packets)).toThrow();
});
