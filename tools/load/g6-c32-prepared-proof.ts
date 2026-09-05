/** Re-derive native Linux proof from the exact prepared-server gate operations. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { verifyBoundFreeze } from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	validateOperationReceipt,
} from "./g6-c32-freeze-model.ts";
import {
	G6_C32_GATE_CATALOG,
	gateDefinitionSha256,
	validateGateReceipt,
} from "./g6-c32-gates.ts";
import { preparedGateSshArgs } from "./g6-c32-prepared-command.ts";
import { writeWorkJson } from "./g6-c32-work-execution.ts";
import {
	assertNativeProofOutput,
	type CapacityExecutionReceipt,
	capacityLocalProofArgv,
	G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
} from "./g6-capacity-proof-catalog.ts";

export const PREPARED_NATIVE_GATE_IDS = [
	"prepared-server-native-unit-tests",
	"prepared-server-native-platform",
	"prepared-server-native-source",
] as const;
const PROOF = "proofs/prepared-native.json";
const ORIGIN = "proofs/prepared-native-origin.json";
export const PREPARED_NATIVE_ORIGIN_SCHEMA = "g6-capacity-prepared-origin/1";
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
	throw Error(`g6-c32-prepared-proof: ${message}`);
}
export type PreparedProofContext = {
	runId: string;
	sourceSha: string;
	bootId: string;
	serverPublicIpv4: string;
	knownHostsPath: string;
	remoteCheckoutPath: string;
};
export type PreparedProofPacket = {
	gate: unknown;
	operation: unknown;
	stdoutPath: string;
	stderrPath: string;
	stdout: string;
	stderr: string;
};

export function derivePreparedNativeProof(
	context: PreparedProofContext,
	packets: readonly PreparedProofPacket[],
): CapacityExecutionReceipt {
	if (
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(context.runId) ||
		!/^[a-f0-9]{40}$/.test(context.sourceSha) ||
		!/^[a-f0-9-]{36}$/.test(context.bootId) ||
		context.remoteCheckoutPath !== "/root/webtransport-bun" ||
		!context.knownHostsPath.startsWith("/")
	)
		fail("invalid prepared proof authority");
	if (packets.length !== PREPARED_NATIVE_GATE_IDS.length)
		fail("missing prepared native gates");
	let previousSequence = 0,
		previousFinishedAt = 0;
	const commands = packets.map((packet, index) => {
		const id = PREPARED_NATIVE_GATE_IDS[index],
			argv = capacityLocalProofArgv("candidate-local-linux")[index];
		const definition = G6_C32_GATE_CATALOG.gates.find((gate) => gate.id === id);
		if (!definition || !argv?.[0]) fail("missing source-owned gate definition");
		const gate = validateGateReceipt(packet.gate),
			operation = validateOperationReceipt(packet.operation);
		if (
			gate.gate.id !== id ||
			gate.gate.phase !== "PREPARED_HOST" ||
			gate.gate.definitionSha256 !== gateDefinitionSha256(definition) ||
			gate.gateCatalogAuthoritySha256 !==
				canonicalAuthoritySha256(G6_C32_GATE_CATALOG) ||
			gate.result.verdict !== "PASS" ||
			gate.result.operationReceiptArtifactSha256 !==
				canonicalArtifactSha256(operation)
		)
			fail("gate or operation binding mismatch");
		for (const envelope of [gate.envelope, operation.envelope])
			if (
				envelope.runId !== context.runId ||
				envelope.phase !== "PREPARED_HOST" ||
				envelope.operationId !== `gate-${id}` ||
				envelope.clockSource !== "offrunner"
			)
				fail("wrong prepared gate envelope");
		if (
			gate.envelope.sequence !== operation.envelope.sequence ||
			Date.parse(gate.envelope.recordedAt) < Date.parse(operation.finishedAt) ||
			operation.envelope.sequence <= previousSequence ||
			Date.parse(operation.startedAt) < previousFinishedAt
		)
			fail("prepared gates are not sequential");
		previousSequence = operation.envelope.sequence;
		previousFinishedAt = Date.parse(operation.finishedAt);
		if (
			operation.status.outcome !== "SUCCEEDED" ||
			operation.status.exitCode !== 0 ||
			operation.status.signal !== null
		)
			fail("prepared operation did not exit successfully");
		const sshArgs = preparedGateSshArgs({
			command: argv[0],
			args: argv.slice(1),
			remoteCwd: context.remoteCheckoutPath,
			publicIpv4: context.serverPublicIpv4,
			knownHostsPath: context.knownHostsPath,
		});
		const expectedArgs = operation.action.environmentKeys.includes(
			"G6_C32_SSH_IDENTITY_PATH",
		)
			? [
					"-i",
					"<redacted-ssh-identity>",
					"-o",
					"IdentitiesOnly=yes",
					...sshArgs,
				]
			: sshArgs;
		if (
			operation.action.command !== "ssh" ||
			operation.action.cwd !== "." ||
			canonicalJson(operation.action.args) !== canonicalJson(expectedArgs)
		)
			fail("prepared command differs from exact server and catalog");
		const markers = [
			...packet.stderr.matchAll(/^g6-prepared-boot-id=([^\r\n]*)$/gm),
		];
		if (
			markers.length !== 1 ||
			markers[0]?.[1] !== context.bootId ||
			packet.stdout.includes("g6-prepared-boot-id=")
		)
			fail("prepared command lacks the frozen boot witness");
		if (index === 0)
			assertNativeProofOutput(`${packet.stdout}\n${packet.stderr}`, true);
		if (index === 1 && packet.stdout.trim() !== "Linux")
			fail("prepared test platform is not Linux");
		if (index === 2 && packet.stdout.trim() !== context.sourceSha)
			fail("prepared tests ran another source");
		if (
			index > 0 &&
			packet.stderr.trim() !== `g6-prepared-boot-id=${context.bootId}`
		)
			fail("unexpected prepared identity output");
		for (const path of [packet.stdoutPath, packet.stderrPath])
			if (
				!path ||
				path.startsWith("/") ||
				path.includes("\\") ||
				path.split("/").some((part) => !part || part === "." || part === "..")
			)
				fail("unsafe proof output path");
		return {
			argv,
			exitCode: 0,
			signal: null,
			durationMs: Number(BigInt(operation.durationMonotonicNs) / 1_000_000n),
			stdoutPath: packet.stdoutPath,
			stderrPath: packet.stderrPath,
			stdoutSha256: sha(packet.stdout),
			stderrSha256: sha(packet.stderr),
		};
	});
	return {
		schema: G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA,
		kind: "candidate-local-linux",
		sourceSha: context.sourceSha,
		phase: "PREPARED_HOST",
		platform: "Linux",
		commands,
		liveEvidence: false,
		note: "Derived from retained exact-server prepared gate operations and raw output; native unit proof only, not capacity evidence.",
	};
}

function relativePath(root: string, path: string): string {
	const result = relative(root, path).split(sep).join("/");
	if (
		!result ||
		result.startsWith("/") ||
		result.split("/").some((piece) => !piece || piece === "." || piece === "..")
	)
		fail("proof artifact is outside its owned root");
	return result;
}
function read(root: string, path: string): Buffer {
	const rel = relativePath(root, resolve(root, path));
	let current = root;
	for (const part of rel.split("/")) {
		current = join(current, part);
		if (lstatSync(current).isSymbolicLink()) fail("symlink proof artifact");
	}
	const stat = lstatSync(current);
	if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
		fail("invalid proof artifact size or type");
	return readFileSync(current);
}
type CollectionInput = {
	repositoryPath: string;
	boundRoot: string;
	knownHostsPath: string;
};
export type PreparedProofOrigin = {
	schema: typeof PREPARED_NATIVE_ORIGIN_SCHEMA;
	boundRoot: string;
	hostBindingSha256: string;
	proofPath: string;
	proofSha256: string;
	sourceSha: string;
	serverId: number;
	bootId: string;
	knownHostsPath: string;
};
function deriveFromBound(input: CollectionInput) {
	const repositoryPath = realpathSync(input.repositoryPath),
		boundRoot = realpathSync(input.boundRoot),
		runRoot = dirname(boundRoot),
		provisioningRoot = dirname(runRoot);
	relativePath(repositoryPath, boundRoot);
	const verified = verifyBoundFreeze(boundRoot, { repositoryPath });
	const server = verified.hostBinding.authority.hosts.server;
	const knownHostsPath = resolve(input.knownHostsPath);
	relativePath(runRoot, knownHostsPath);
	if (
		sha(read(repositoryPath, relativePath(repositoryPath, knownHostsPath))) !==
		verified.hostBinding.authority.knownHosts.file.sha256
	)
		fail("prepared known_hosts bytes differ from frozen identity");
	const packets = PREPARED_NATIVE_GATE_IDS.map((id) => {
		const refs = verified.hostBinding.authority.gates.receipts.filter(
			(reference) => reference.id === id,
		);
		if (refs.length !== 1 || !refs[0])
			fail("missing or duplicate prepared gate reference");
		const reference = refs[0];
		const gate = JSON.parse(
			read(boundRoot, reference.receipt.path).toString("utf8"),
		);
		const operation = validateOperationReceipt(
			JSON.parse(
				read(boundRoot, reference.operationReceipt.path).toString("utf8"),
			),
		);
		for (const path of [operation.stdoutPath, operation.stderrPath])
			if (!path.startsWith(`${verified.runId}/operations/`))
				fail("operation output is not owned by this run");
		const stdoutPath = relativePath(
				repositoryPath,
				resolve(provisioningRoot, operation.stdoutPath),
			),
			stderrPath = relativePath(
				repositoryPath,
				resolve(provisioningRoot, operation.stderrPath),
			);
		return {
			gate,
			operation,
			stdoutPath,
			stderrPath,
			stdout: read(repositoryPath, stdoutPath).toString("utf8"),
			stderr: read(repositoryPath, stderrPath).toString("utf8"),
		};
	});
	const proof = derivePreparedNativeProof(
		{
			runId: verified.runId,
			sourceSha: server.source.commit,
			bootId: server.bootId,
			serverPublicIpv4: server.provider.publicIpv4,
			knownHostsPath,
			remoteCheckoutPath: "/root/webtransport-bun",
		},
		packets,
	);
	const origin: PreparedProofOrigin = {
		schema: PREPARED_NATIVE_ORIGIN_SCHEMA,
		boundRoot: relativePath(repositoryPath, boundRoot),
		hostBindingSha256: canonicalArtifactSha256(verified.hostBinding),
		proofPath: relativePath(repositoryPath, join(runRoot, PROOF)),
		proofSha256: sha(`${JSON.stringify(proof)}\n`),
		sourceSha: proof.sourceSha,
		serverId: server.provider.id,
		bootId: server.bootId,
		knownHostsPath: relativePath(repositoryPath, knownHostsPath),
	};
	return { proof, origin, repositoryPath, runRoot };
}

/** No remote commands: this is a source-replayable view of already executed gates. */
export function collectPreparedNativeProof(
	input: CollectionInput,
): PreparedProofOrigin {
	const { proof, origin, runRoot } = deriveFromBound(input);
	for (const [path, value] of [
		[PROOF, proof],
		[ORIGIN, origin],
	] as const) {
		if (existsSync(join(runRoot, path))) {
			if (read(runRoot, path).toString("utf8") !== `${JSON.stringify(value)}\n`)
				fail("existing prepared proof differs from retained operations");
		} else writeWorkJson(runRoot, path, value);
	}
	return origin;
}

export function verifyPreparedNativeProof(
	repositoryPath: string,
	originPath: string,
): PreparedProofOrigin {
	const repo = realpathSync(repositoryPath),
		value = JSON.parse(
			read(repo, originPath).toString("utf8"),
		) as PreparedProofOrigin;
	if (
		value?.schema !== PREPARED_NATIVE_ORIGIN_SCHEMA ||
		typeof value.boundRoot !== "string" ||
		typeof value.knownHostsPath !== "string"
	)
		fail("invalid prepared origin");
	read(repo, `${value.boundRoot}/host-binding.json`);
	const { proof, origin } = deriveFromBound({
		repositoryPath: repo,
		boundRoot: resolve(repo, value.boundRoot),
		knownHostsPath: resolve(repo, value.knownHostsPath),
	});
	if (
		canonicalJson(value) !== canonicalJson(origin) ||
		read(repo, origin.proofPath).toString("utf8") !==
			`${JSON.stringify(proof)}\n`
	)
		fail("prepared proof origin does not replay");
	return origin;
}
