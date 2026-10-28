/** Immutable terminal evidence. This attests cleanup and bytes, never capacity. */
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA,
	sealWorkSpendLedger,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import {
	destructionReceiptFromFinalJournal,
	loadRigStateFromJournal,
	validateG6DestructionReceipt,
} from "./g6-c32-digitalocean.ts";
import {
	type ArtifactManifestEntry,
	canonicalArtifactSha256,
	canonicalJson,
	makeArtifactManifestRecord,
	requireDefined,
	validateArtifactManifestRecord,
} from "./g6-c32-freeze-model.ts";
import { readRigJournal } from "./g6-c32-rig-journal.ts";

const MANIFEST = "terminal/artifact-manifest.json";
const RECEIPT = "terminal/terminal-receipt.json";
const digest = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
	throw new Error(`g6-c32-terminal-evidence: ${message}`);
}
function safePath(root: string, relativePath: string): string {
	if (
		!relativePath ||
		relativePath.includes("\\") ||
		relativePath.includes("\0") ||
		relativePath
			.split("/")
			.some((part) => !part || part === "." || part === "..")
	)
		fail("invalid relative evidence path");
	const path = resolve(root, relativePath);
	let current = root;
	for (const part of relativePath.split("/")) {
		current = join(current, part);
		if (existsSync(current) && lstatSync(current).isSymbolicLink())
			fail("symlink evidence is forbidden");
	}
	return path;
}
function read(root: string, path: string): Buffer {
	const actual = safePath(root, path);
	if (!lstatSync(actual).isFile()) fail(`not a regular artifact: ${path}`);
	return readFileSync(actual);
}
function json(root: string, path: string): unknown {
	return JSON.parse(read(root, path).toString("utf8"));
}

/** Publish once using a durable staging inode and an exclusive link, or match existing bytes. */
function publish(root: string, relativePath: string, bytes: string): void {
	const target = safePath(root, relativePath);
	if (existsSync(target)) {
		if (!read(root, relativePath).equals(Buffer.from(bytes)))
			fail(`immutable artifact differs: ${relativePath}`);
		return;
	}
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const staging = `${target}.pending-${randomUUID()}`;
	const fd = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(staging, target);
	} catch (error) {
		if (
			!existsSync(target) ||
			!read(root, relativePath).equals(Buffer.from(bytes))
		)
			throw error;
	} finally {
		unlinkSync(staging);
	}
	const parent = openSync(dirname(target), "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}

export type TerminalEvidenceReceipt = {
	schema: "g6-c32-terminal-evidence/1";
	status: "TEARDOWN_VERIFIED";
	runId: string;
	recordedAt: string;
	preSealRoot: string;
	manifestPath: typeof MANIFEST;
	manifestSha256: string;
	preSealManifestSha256: string;
	finalLedgerSha256: string;
	destructionReceiptSha256: string;
	finalJournalSha256: string;
	sealedTotalMicrousd: number;
	deletedIds: number[];
};

type Inputs = {
	root: string;
	runId: string;
	preSealRoot: string;
	expectedDeletedIds?: readonly number[];
};
function terminalInputs(input: Inputs) {
	const root = realpathSync(input.root);
	const journal = readRigJournal(safePath(root, "rig-state.json"));
	if (
		journal.envelope.runId !== input.runId ||
		journal.events.at(-1)?.state !== "DESTROYED"
	)
		fail("final journal is not this destroyed run");
	const destruction = validateG6DestructionReceipt(
		json(root, "destruction-receipt.json"),
	);
	const committed = destructionReceiptFromFinalJournal(journal);
	if (
		destruction.envelope.runId !== input.runId ||
		destruction.desiredRigAuthoritySha256 !==
			journal.desiredRigAuthoritySha256 ||
		destruction.finalJournalArtifactSha256 !== canonicalArtifactSha256(journal)
	)
		fail("destruction receipt differs from final journal");
	if (
		destruction.verifiedAbsentAt !== committed.verifiedAbsentAt ||
		canonicalJson([...destruction.deletedIds].sort()) !==
			canonicalJson([...committed.deletedIds].sort())
	)
		fail("destruction receipt differs from committed journal deletion");
	const expected = input.expectedDeletedIds;
	if (
		expected !== undefined &&
		(!Array.isArray(expected) ||
			expected.length > 2 ||
			new Set(expected).size !== expected.length ||
			expected.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
			canonicalJson([...committed.deletedIds].sort()) !==
				canonicalJson([...expected].sort()))
	)
		fail("destruction did not confirm every exact owned ID");
	const ledger = validateSpendLedger(json(root, "spend-ledger.json"), {
		requireSeal: true,
	});
	if (ledger.entries.some((entry) => entry.runId !== input.runId))
		fail("spend ledger belongs to another run");
	const seal = requireDefined(ledger.entries.at(-1));
	if (Date.parse(seal.recordedAt) < Date.parse(destruction.verifiedAbsentAt))
		fail("spend sealed before verified deletion");
	const state = loadRigStateFromJournal(safePath(root, "rig-state.json"));
	if (
		state.desired.budget.lifecycle === "attribution-only" &&
		seal.schema !== G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA
	)
		fail("attribution authority requires a versioned paid settlement");
	if (seal.schema === G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA) {
		if (seal.budgetPolicySha256 !== state.desired.budget.policySha256)
			fail("work settlement policy differs from journal authority");
		const price = state.preCreateBudgetAuthority?.priceReceipt;
		// Replaying the settlement verifies the independently committed absence and
		// exact provider prices, not only the seal's internally consistent arithmetic.
		sealWorkSpendLedger({
			policy: seal.settlement.policy,
			entries: ledger.entries,
			recordedAt: seal.recordedAt,
			verifiedAbsentAt: committed.verifiedAbsentAt,
			hourlyMicrousdByRole: price
				? {
						server: price.serverHourlyMicrousd,
						generator: price.generatorHourlyMicrousd,
					}
				: null,
		});
	}
	const prePath = `${input.preSealRoot}/artifact-manifest.json`;
	const pre = validateArtifactManifestRecord(json(root, prePath));
	if (pre.envelope.runId !== input.runId)
		fail("pre-seal belongs to another run");
	const sealed = journal.events.findLast(
		(event) =>
			event.kind === "RESULT" &&
			event.envelope.operationId === "offrunner-evidence-sealed",
	);
	const sealDetails = sealed?.details as
		| { result?: { sealRoot?: unknown; manifestArtifactSha256?: unknown } }
		| undefined;
	const committedSeal = sealDetails?.result;
	if (
		typeof committedSeal?.sealRoot !== "string" ||
		!isAbsolute(committedSeal.sealRoot) ||
		realpathSync(committedSeal.sealRoot) !==
			safePath(root, input.preSealRoot) ||
		committedSeal.manifestArtifactSha256 !== canonicalArtifactSha256(pre)
	)
		fail("pre-seal differs from journal seal commit");
	const preReceipt = json(root, `${input.preSealRoot}/seal-receipt.json`) as {
		manifestArtifactSha256?: unknown;
		envelope?: { runId?: unknown };
	};
	if (
		preReceipt.manifestArtifactSha256 !== canonicalArtifactSha256(pre) ||
		preReceipt.envelope?.runId !== input.runId
	)
		fail("pre-seal receipt does not bind manifest");
	const paths = pre.entries.map((entry) => {
		if (!entry.path.startsWith("run/"))
			fail("unsupported pre-seal path namespace");
		const path = entry.path.slice(4);
		if (
			path === "spend-ledger.json" ||
			path === "rig-state.json" ||
			path.startsWith("terminal/")
		)
			fail("pre-seal includes mutable lifecycle bytes");
		const bytes = read(root, path);
		if (bytes.byteLength !== entry.bytes || digest(bytes) !== entry.sha256)
			fail(`pre-sealed bytes changed: ${path}`);
		return path;
	});
	const snapshotPath = `${input.preSealRoot}/pre-destroy-spend-ledger.json`;
	if (!paths.includes(snapshotPath))
		fail("missing immutable pre-destroy spend snapshot");
	const prior = validateSpendLedger(json(root, snapshotPath), {
		requireSeal: false,
	});
	if (
		prior.entries.length >= ledger.entries.length ||
		canonicalJson(ledger.entries.slice(0, prior.entries.length)) !==
			canonicalJson(prior.entries)
	)
		fail(
			"final spend is not an append-only continuation of pre-destroy snapshot",
		);
	return {
		root,
		ledger,
		seal,
		paths,
		prePath,
		deletedIds: committed.deletedIds,
	};
}

export function publishTerminalEvidence(
	input: Inputs & {
		onPublishBoundary?: (
			boundary: "snapshots" | "manifest" | "receipt",
		) => void;
	},
): TerminalEvidenceReceipt {
	const { root, ledger, seal, paths, prePath, deletedIds } =
		terminalInputs(input);
	publish(
		root,
		"terminal/final-spend-ledger.json",
		read(root, "spend-ledger.json").toString("utf8"),
	);
	publish(root, "terminal/spend-seal-receipt.json", canonicalJson(seal));
	input.onPublishBoundary?.("snapshots");
	const boundPaths = [
		...new Set([
			...paths,
			prePath,
			`${input.preSealRoot}/seal-receipt.json`,
			"spend-ledger.json",
			"rig-state.json",
			"destruction-receipt.json",
			"terminal/final-spend-ledger.json",
			"terminal/spend-seal-receipt.json",
		]),
	].sort();
	const entries: ArtifactManifestEntry[] = boundPaths.map((path) => {
		const bytes = read(root, path);
		return {
			path,
			sha256: digest(bytes),
			bytes: bytes.byteLength,
			recordedAt: seal.recordedAt,
		};
	});
	const manifest = makeArtifactManifestRecord(
		{
			recordedAt: seal.recordedAt,
			sequence: seal.sequence,
			runId: input.runId,
			phase: "FINAL",
			operationId: "offrunner-artifact-manifest",
			clockSource: "offrunner",
		},
		entries,
	);
	publish(root, MANIFEST, canonicalJson(manifest));
	input.onPublishBoundary?.("manifest");
	const receipt: TerminalEvidenceReceipt = {
		schema: "g6-c32-terminal-evidence/1",
		status: "TEARDOWN_VERIFIED",
		runId: input.runId,
		recordedAt: seal.recordedAt,
		preSealRoot: input.preSealRoot,
		manifestPath: MANIFEST,
		manifestSha256: digest(read(root, MANIFEST)),
		preSealManifestSha256: digest(read(root, prePath)),
		finalLedgerSha256: digest(read(root, "terminal/final-spend-ledger.json")),
		destructionReceiptSha256: digest(read(root, "destruction-receipt.json")),
		finalJournalSha256: digest(read(root, "rig-state.json")),
		sealedTotalMicrousd: requireDefined(ledger.sealedTotalMicrousd),
		deletedIds: [...deletedIds].sort((a, b) => a - b),
	};
	publish(root, RECEIPT, canonicalJson(receipt));
	input.onPublishBoundary?.("receipt");
	return verifyTerminalEvidence(root);
}

export function verifyTerminalEvidence(
	rootValue: string,
): TerminalEvidenceReceipt {
	const root = realpathSync(rootValue);
	const receipt = json(root, RECEIPT) as TerminalEvidenceReceipt;
	const keys = [
		"schema",
		"status",
		"runId",
		"recordedAt",
		"preSealRoot",
		"manifestPath",
		"manifestSha256",
		"preSealManifestSha256",
		"finalLedgerSha256",
		"destructionReceiptSha256",
		"finalJournalSha256",
		"sealedTotalMicrousd",
		"deletedIds",
	].sort();
	if (
		!receipt ||
		typeof receipt !== "object" ||
		Object.keys(receipt).sort().join() !== keys.join() ||
		receipt.schema !== "g6-c32-terminal-evidence/1" ||
		receipt.status !== "TEARDOWN_VERIFIED" ||
		receipt.manifestPath !== MANIFEST ||
		!Array.isArray(receipt.deletedIds)
	)
		fail("invalid terminal receipt");
	const { ledger, seal, paths, prePath } = terminalInputs({
		root,
		runId: receipt.runId,
		preSealRoot: receipt.preSealRoot,
		expectedDeletedIds: receipt.deletedIds,
	});
	for (const [path, expected] of [
		[MANIFEST, receipt.manifestSha256],
		[prePath, receipt.preSealManifestSha256],
		["terminal/final-spend-ledger.json", receipt.finalLedgerSha256],
		["destruction-receipt.json", receipt.destructionReceiptSha256],
		["rig-state.json", receipt.finalJournalSha256],
	] as const)
		if (digest(read(root, path)) !== expected)
			fail(`terminal digest mismatch: ${path}`);
	if (
		receipt.recordedAt !== seal.recordedAt ||
		receipt.sealedTotalMicrousd !== ledger.sealedTotalMicrousd ||
		!read(root, "terminal/final-spend-ledger.json").equals(
			read(root, "spend-ledger.json"),
		) ||
		canonicalJson(json(root, "terminal/spend-seal-receipt.json")) !==
			canonicalJson(seal)
	)
		fail("terminal spend snapshot disagrees with final ledger");
	const manifest = validateArtifactManifestRecord(json(root, MANIFEST));
	if (manifest.envelope.runId !== receipt.runId)
		fail("terminal manifest belongs to another run");
	const required = [
		...new Set([
			...paths,
			prePath,
			`${receipt.preSealRoot}/seal-receipt.json`,
			"spend-ledger.json",
			"rig-state.json",
			"destruction-receipt.json",
			"terminal/final-spend-ledger.json",
			"terminal/spend-seal-receipt.json",
		]),
	].sort();
	if (
		canonicalJson(manifest.entries.map((entry) => entry.path).sort()) !==
		canonicalJson(required)
	)
		fail("terminal manifest omits required bindings");
	for (const entry of manifest.entries) {
		const bytes = read(root, entry.path);
		if (bytes.byteLength !== entry.bytes || digest(bytes) !== entry.sha256)
			fail(`terminal artifact mutated: ${entry.path}`);
	}
	return receipt;
}

if (import.meta.main) {
	try {
		if (Bun.argv.length !== 4 || Bun.argv[2] !== "--root")
			fail("usage: --root EXACT_RUN_ROOT");
		process.stdout.write(
			`${canonicalJson(verifyTerminalEvidence(requireDefined(Bun.argv[3])))}`,
		);
	} catch (error) {
		process.stderr.write(`${String(error)}\n`);
		process.exitCode = 2;
	}
}
