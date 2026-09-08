/**
 * The Phase B fanout cohort path, driven end to end against real processes.
 *
 * Every other cohort suite in this tree injects something: a stub runtime, an
 * in-process rig binding, a scripted Mac. This file supplies nothing on the
 * measured path. It drives:
 *
 *   - `dispatchArmRepetition` with the *production* provider
 *     (`createCohortArmRuntimeProvider` over the *production* lease factory
 *     `createProductionCohortArmLeaseFactory`, built exactly as `realRunBody`
 *     builds it -- `bin/compare-controller.ts`, the `cohortRuntimeProvider`
 *     block) and the *production* executors (no `executors` override),
 *   - the real release `comparison-supervisor` twice: once as the Mac cohort
 *     signer, booted through the production `spawnMacSupervisor` under the
 *     tier-B uid seam with the two campaign descriptors on fd 7/8, and once as
 *     the rig on this host, booted the way the rig wrapper boots it
 *     (`--cohort-signing-key-fd 7 --cohort-role-root-fd 10`),
 *   - a real `bun tools/compare/server.ts --mode=fanout-cohort` child,
 *     fork/exec'd by that rig from the staged argv with the staged TLS
 *     identity on its registered environment,
 *   - eighteen real `bin/fanout-role.ts` children per execution, spawned by
 *     `createMacFanoutRoleChildHost` with sealed FD 5 token bundles,
 *   - a locally staged pair: keys, launch records, TLS leaves and stage
 *     receipt laid out the way `stage-live-campaign.ts` lays them out, read
 *     back through the same `verifyStagedTrustBootstrap` and
 *     `readStagedCohortMaterial` calls `realRun` makes.
 *
 * ## Topology
 *
 * `chat-fanout/subscribers-1000`, the frozen "chat 1k" cell: 10 publishers, 8
 * subscriber workers, 1,000 subscribers (1,010 sessions), 300 measured
 * ingress frames, 300,000 expanded deliveries, 30 s measured. Pilot purpose
 * schedules one unsealed warmup and one measured repetition per arm, so the
 * run is four executions -- `ws/warmup-0`, `ws/measured-1`, `wt/warmup-0`,
 * `wt/measured-1` -- and two seals. Local loopback evidence is local
 * evidence: the ticker-250 pilot on the physical rig is the plan's number.
 *
 * ## The host
 *
 * Design §3.1: "One machine, all real processes, loopback instead of
 * `10.99.0.2`". The pair is staged under the `local-acceptance` profile,
 * whose one host is `127.0.0.1` (`cohortServerHostForProfile`): the receipt
 * binds it, every launch record binds it on both endpoint fields and inside
 * its argv (`--stage-profile=local-acceptance --bind=127.0.0.1`), the server
 * child binds it, every role child connects to it, and the staged TLS leaf
 * carries it in its SAN beside the cable address. A physical profile's record
 * naming loopback is refused, and so is a local record naming the cable
 * address; nothing here aliases an address, escalates, or bypasses a
 * verification. The probe below binds the host once and refuses the run by
 * name if this machine does not own it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import {
	closeSync,
	copyFileSync,
	createReadStream,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type BinaryMessageClient,
	connectBinaryMessageClient,
} from "./adapters/ws.ts";
import {
	type ArmRepetitionDispatch,
	COHORT_RECEIPT_VALIDITY_MS,
	type CohortArmLease,
	type CohortArmRuntimeProvider,
	createCohortArmRuntimeProvider,
	createProductionCohortArmLeaseFactory,
	dispatchArmRepetition,
	EXECUTABLE_ROLE_ENTRYPOINT_PATH,
	MAC_SUPERVISOR_UID_SEAM_ENV,
	observeMacClockIdentity,
	readStagedCohortMaterial,
	resolveStagedAuthorityDigest,
	sealArmsForCell,
	signedExecutionRunId,
	type StagedCohortMaterialV1,
	stagedServerLaunchRecordFor,
} from "./bin/compare-controller.ts";
import {
	hashAddonManifest,
	mintStagedServerTlsIdentity,
} from "./bin/stage-live-campaign.ts";
import {
	buildStagedServerLaunchRecord,
	stagedServerLaunchArgv,
	stagedServerLaunchModesForProfile,
	stagedServerLaunchRecordLeaf,
} from "./server.ts";
import {
	CAMPAIGN_INDEX_V2_SCHEMA,
	type CampaignIndexEntryV2,
	type CampaignIndexV2,
	verifyCampaignIndex,
} from "./bin/verify-campaign-index.ts";
import {
	buildServerBindExecution,
	buildServerMeasureStart,
	buildServerPresentStartBarrier,
	buildServerStopAndCapture,
	buildServerTeardown,
	buildServerWarmupDrainAndReset,
	buildServerWarmupStart,
	decodeChildPipeFrame,
	encodeServerChildFrame,
	parseServerCaptureAck,
	parseServerMeasureStartAck,
	parseServerReady,
	parseServerStartBarrierAccepted,
	parseServerStopped,
	parseServerWarmupDrained,
	parseServerWarmupReady,
} from "./child-pipe-protocol.ts";
import {
	COHORT_DRAIN_DEADLINE_MS,
	COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
	COHORT_SERVER_HOST,
	COHORT_TLS_SERVER_NAME,
	COHORT_WORKER_COUNT,
	type CohortGrantV1,
	type CohortObservationEvidenceV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	cohortCellCardinality,
	parseStagedServerLaunchRecord,
	READINESS_DEADLINE_MS_TICKER,
	STAGED_SERVER_TLS_CERTIFICATE_LEAF,
	STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
	type SubscriberShardV1,
	WARMUP_MESSAGES_PER_PUBLISHER,
} from "./cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	cohortExportAckSigningBytes,
	decodeRegisteredRemotePayload,
	ed25519Sign,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	type NsString,
	type ProtocolResult,
	type Sha256Hex,
	signMacReceipt,
} from "./cross-supervisor-protocol.ts";
import {
	type CohortEvidenceExportReceipt,
	cohortCellForArm,
	type RunArtifact,
	sealRunArtifact,
	sha256HexOfBytes,
	type ToolchainSet,
} from "./evidence.ts";
import {
	R1_AUTHORITY_APPROVAL,
	R1_CAMPAIGN_ID,
	R1_CANDIDATE_ID,
	R1_SOURCE_ARCHIVE_RECEIPT,
} from "./r1-fixtures.ts";
import {
	buildRigSupervisorWrapperScript,
	CohortRigChannel,
	createCloexecPipe,
	processGroupIdOf,
	type StagedTrustBootstrapPaths,
	SUPERVISOR_ARTIFACT_PAYLOAD_MAX_BYTES,
	type SupervisorHandle,
	spawnMacSupervisor,
	stopSupervisor,
	TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	TRUST_BOOTSTRAP_AUTHORITY_LEAF,
	TRUST_BOOTSTRAP_CAMPAIGN_ROOT,
	TRUST_BOOTSTRAP_STAGING_ROOT,
	verifyStagedTrustBootstrap,
} from "./remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { canonicalRecordBytes } from "./secure-fs.ts";
import {
	observeLocalToolchain,
	toolchainIdentity,
} from "./toolchain-observation.ts";
import {
	reconstructCohortEvidenceOffline,
	trustContextForArtifact,
	verifyRunArtifact,
} from "./verify-artifact.ts";
import {
	buildFanoutCohortFixture,
	type FanoutCohortFixture,
	fanoutFrameCodecFor,
	fanoutPayload,
	fanoutRoleId,
} from "./scenarios/fanout-relay.ts";
import {
	contextTagOfDeliveryContextSha256,
	decodeFanoutDelivery,
	type FanoutDeliveryC1,
	type FanoutWireV1,
	fanoutDeliveryUnitKind,
} from "./scenarios/fanout-wire.ts";
import {
	decodeSupervisorFrame,
	encodeSupervisorFrame,
} from "./supervisor-client.ts";

/** The cohort cell this suite drives. */
const CELL_ID = "ticker-fanout/rate-250";
const COHORT_CELL = "ticker 250";

/** Repo root: this file lives at `<root>/tools/compare/`. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A long timeout: these tests build Rust binaries and boot real processes. */
const PROCESS_TEST_TIMEOUT_MS = 900_000;

/** A throwaway certificate for a loopback listener. */
function selfSignedTls(dir: string): { cert: string; key: string } {
	const certPath = join(dir, "server.crt");
	const keyPath = join(dir, "server.key");
	const made = Bun.spawnSync({
		cmd: [
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"1",
			"-nodes",
			"-subj",
			"/CN=wt-compare.local",
			"-addext",
			"subjectAltName=DNS:wt-compare.local,IP:127.0.0.1",
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (made.exitCode !== 0) {
		throw new Error(`openssl failed: ${made.stderr.toString().slice(-500)}`);
	}
	return {
		cert: readFileSync(certPath, "utf8"),
		key: readFileSync(keyPath, "utf8"),
	};
}

function cellOf(cellId: string) {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === cellId,
	);
	if (cell === undefined) throw new Error(`no registry cell ${cellId}`);
	return cell;
}

// ---------------------------------------------------------------------------
// 1. The production dispatch: chat 1k over a locally staged pair
// ---------------------------------------------------------------------------

const CHAT_CELL_ID = "chat-fanout/subscribers-1000";
const CHAT_COHORT_CELL = "chat 1k";
const REPO_TOOLS = join(REPO_ROOT, "tools", "compare");
const RELEASE_SUPERVISOR = join(
	REPO_ROOT,
	"target",
	"release",
	"comparison-supervisor",
);

/**
 * Whether this host owns the frozen advertised server host. A bind is the
 * probe: `EADDRNOTAVAIL` means the role children would be connecting to
 * another machine.
 */
function hostOwnsAdvertisedServerHost(host: string): ProtocolResult<true> {
	try {
		const listener = Bun.listen({
			hostname: host,
			port: 0,
			socket: { data() {} },
		});
		listener.stop(true);
		return { ok: true, value: true };
	} catch (error) {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: `this host does not own ${host} (${(error as Error).message}); the staged launch record sends every role child there`,
		};
	}
}

/** The local-acceptance profile's host; the run refuses by name without it. */
const OWNS_LOCAL_HOST = hostOwnsAdvertisedServerHost(
	COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
);

/**
 * The lowest port this host hands out for an unbound (`:0`) socket.
 *
 * Read from the kernel rather than assumed: it is the boundary the loopback
 * listener has to stay below, and a host configured with a wider range moves
 * it. Darwin exposes it as `net.inet.ip.portrange.first`, Linux as the first
 * field of `/proc/sys/net/ipv4/ip_local_port_range`. Anything else has no
 * answer here and says so instead of guessing one.
 */
function osEphemeralPortFloor(): number {
	if (process.platform === "darwin") {
		const probe = Bun.spawnSync([
			"/usr/sbin/sysctl",
			"-n",
			"net.inet.ip.portrange.first",
		]);
		if (probe.exitCode !== 0) {
			throw new Error(
				`sysctl net.inet.ip.portrange.first failed: ${probe.stderr.toString()}`,
			);
		}
		const floor = Number.parseInt(probe.stdout.toString().trim(), 10);
		if (!Number.isSafeInteger(floor) || floor <= 0) {
			throw new Error(
				`net.inet.ip.portrange.first is not a port: ${probe.stdout.toString()}`,
			);
		}
		return floor;
	}
	if (process.platform === "linux") {
		const range = readFileSync(
			"/proc/sys/net/ipv4/ip_local_port_range",
			"utf8",
		).trim();
		const floor = Number.parseInt(range.split(/\s+/)[0] ?? "", 10);
		if (!Number.isSafeInteger(floor) || floor <= 0) {
			throw new Error(`ip_local_port_range is not a range: ${range}`);
		}
		return floor;
	}
	throw new Error(
		`no ephemeral port range is known for ${process.platform}; this acceptance runs on darwin or linux`,
	);
}

/**
 * The port the local-acceptance listener binds.
 *
 * Deliberately below {@link osEphemeralPortFloor}: a listener inside the
 * ephemeral range is one more socket that every client endpoint's `:0` draw
 * can be handed, and a client that draws the listener's own port sends its
 * Initial from the address the listener answers to, so the answer goes back to
 * the listener and that session's handshake can only end at the handshake
 * bound. Randomised inside its own block so two acceptance runs on this host
 * do not collide with each other.
 */
function chooseLocalAcceptanceServerPort(
	pick: () => number = Math.random,
): number {
	return 44_000 + Math.floor(pick() * 1_000);
}

interface LocalStagedPair {
	readonly root: string;
	readonly stagedDir: string;
	readonly scratchRoot: string;
	readonly bootstrap: StagedTrustBootstrapPaths;
	readonly staged: StagedCohortMaterialV1;
	readonly macKeyPath: string;
	readonly rigKeyPath: string;
	readonly mac: ReturnType<typeof generateEd25519KeyPair>;
	readonly rig: ReturnType<typeof generateEd25519KeyPair>;
	readonly serverPort: number;
}

/**
 * Lay out one staged pair on this host the way `stage-live-campaign.ts` lays
 * it out for two hosts, then read it back exactly as `realRun` does.
 *
 * Both supervisors read one staging root here: the Mac needs the certificate
 * (its CA) and the rig needs certificate and key (its identity), and on one
 * machine one root carries both. Every leaf exists before the trust bootstrap
 * is minted, because the authority pins each root's hard-link count.
 */
function stageLocalPair(): LocalStagedPair {
	buildSupervisorBinaries();
	const root = mkdtempSync(join(tmpdir(), "fanout-e2e-pair-"));
	const stagedDir = join(root, "staged");
	const stagingRoot = join(stagedDir, TRUST_BOOTSTRAP_STAGING_ROOT);
	const campaignRoot = join(stagedDir, TRUST_BOOTSTRAP_CAMPAIGN_ROOT);
	const rolesDir = join(stagedDir, "roles");
	const scratchRoot = join(root, "scratch");
	for (const dir of [
		stagedDir,
		stagingRoot,
		campaignRoot,
		rolesDir,
		scratchRoot,
	]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	// Keys: the Mac signing key inside the campaign scratch root the tier-B
	// seam admits, the rig key beside it; both public halves staged.
	const mac = generateEd25519KeyPair();
	const rig = generateEd25519KeyPair();
	const macKeyPath = join(scratchRoot, "mac-supervisor.pk8");
	const rigKeyPath = join(scratchRoot, "rig-supervisor.pk8");
	writeFileSync(macKeyPath, mac.privatePkcs8Der, { mode: 0o400 });
	writeFileSync(rigKeyPath, rig.privatePkcs8Der, { mode: 0o400 });
	writeFileSync(
		join(stagingRoot, "mac-supervisor-ed25519.pub"),
		mac.publicRaw32,
		{
			mode: 0o644,
		},
	);
	writeFileSync(
		join(stagingRoot, "rig-supervisor-ed25519.pub"),
		rig.publicRaw32,
		{
			mode: 0o644,
		},
	);

	// The TLS identity, minted by the production stage function for the local
	// profile (loopback joins the SAN), both leaves into the one staging root.
	const tls = mintStagedServerTlsIdentity({
		outDir: join(root, "tls"),
		validDays: 1,
		profile: "local-acceptance",
	});
	const certificate = readFileSync(tls.certPath);
	const privateKey = readFileSync(tls.keyPath);
	writeFileSync(
		join(stagingRoot, STAGED_SERVER_TLS_CERTIFICATE_LEAF),
		certificate,
		{
			mode: 0o644,
		},
	);
	writeFileSync(
		join(stagingRoot, STAGED_SERVER_TLS_PRIVATE_KEY_LEAF),
		privateKey,
		{
			mode: 0o600,
		},
	);
	const tlsCertificateSha256 = sha256HexOfBytes(certificate);
	const tlsPrivateKeySha256 = sha256HexOfBytes(privateKey);

	// The digests the receipt binds are this tree's: its server, its role
	// entrypoint (the staged leaf is a byte copy of the file a child runs),
	// this Bun and this addon set.
	const serverEntrypointSha256 = sha256HexOfBytes(
		readFileSync(join(REPO_TOOLS, "server.ts")),
	);
	const roleSource = readFileSync(EXECUTABLE_ROLE_ENTRYPOINT_PATH);
	const fanoutRoleEntrypointSha256 = sha256HexOfBytes(roleSource);
	writeFileSync(join(rolesDir, "fanout-role.ts"), roleSource, { mode: 0o644 });
	const bunSha256 = sha256HexOfBytes(readFileSync(process.execPath));
	const addonSha256 = hashAddonManifest(
		join(REPO_ROOT, "packages", "webtransport", "prebuilds"),
	);
	// One launch record per wire and per mode the local profile spawns, built
	// by the production record builder: loopback on both endpoint fields and
	// inside the argv the rig compares byte for byte.
	const serverPort = chooseLocalAcceptanceServerPort();
	const launchSha256 = {} as Record<"ws" | "wt", Record<string, Sha256Hex>>;
	for (const transport of ["ws", "wt"] as const) {
		launchSha256[transport] = {};
		for (const mode of stagedServerLaunchModesForProfile("local-acceptance")) {
			const bytes = canonicalRecordBytes(
				buildStagedServerLaunchRecord({
					profile: "local-acceptance",
					transport,
					mode,
					serverEntrypointSha256,
					bunSha256,
					addonSha256,
					bindPort: serverPort,
					tlsCertificateSha256,
					tlsPrivateKeySha256,
				}),
			);
			writeFileSync(
				join(stagingRoot, stagedServerLaunchRecordLeaf(transport, mode)),
				bytes,
				{ mode: 0o644 },
			);
			launchSha256[transport][mode] = sha256HexOfBytes(bytes);
		}
	}

	// The trust bootstrap, minted over the complete roots.
	mintTrustBootstrap(stagedDir);
	const bootstrapReceipt = JSON.parse(
		readFileSync(join(stagedDir, "live-bootstrap-receipt.json"), "utf8"),
	) as { readonly authoritySha256: string; readonly capabilitySha256: string };
	const receipt = {
		schema: "live-stage-receipt/v1",
		stageProfile: "local-acceptance",
		cohortServerHost: COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
		// The rig role root on this host: the tree whose `server.ts` is the
		// staged entrypoint and whose relative imports resolve, exactly what
		// `observe-linux --role-root` binds on the rig.
		rigRoleRootPath: REPO_TOOLS,
		// The identity the fixture authority carries; the binary checks the
		// draft's candidate, campaign and approval digests against it.
		candidate: R1_CANDIDATE_ID,
		campaignId: R1_CAMPAIGN_ID,
		authoritySha256: bootstrapReceipt.authoritySha256,
		approvedPlanSha256: R1_AUTHORITY_APPROVAL.approvedPlanSha256,
		approvalRecordSha256: R1_AUTHORITY_APPROVAL.approvalRecordSha256,
		archiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		capabilitySha256: bootstrapReceipt.capabilitySha256,
		macSigningPublicKeySha256: mac.publicKeySha256,
		rigSigningPublicKeySha256: rig.publicKeySha256,
		macBunSha256: bunSha256,
		linuxBunSha256: bunSha256,
		linuxAddonManifestSha256: addonSha256,
		serverEntrypointSha256,
		fanoutRoleEntrypointSha256,
		stagedServerLaunchRecordSha256ByLaunch: launchSha256,
		tlsCertificateSha256,
		notAfterMs: Date.now() + 71 * 60 * 60 * 1_000,
	};
	writeFileSync(
		join(stagedDir, "stage-receipt.json"),
		canonicalRecordBytes(receipt),
		{
			mode: 0o444,
		},
	);

	// Exactly what `realRun` does with `--staged-dir` (bin/compare-controller.ts
	// `realRun`: resolveStagedAuthorityDigest -> verifyStagedTrustBootstrap ->
	// readStagedCohortMaterial).
	const verified = verifyStagedTrustBootstrap(
		stagedDir,
		resolveStagedAuthorityDigest(stagedDir),
	);
	if (!verified.ok) {
		throw new Error(
			`staged-dir verify failed (${verified.code}): ${verified.message}`,
		);
	}
	const material = readStagedCohortMaterial(verified.paths);
	if (!material.ok) throw new Error(`stage material: ${material.message}`);
	return {
		root,
		stagedDir,
		scratchRoot,
		bootstrap: verified.paths,
		staged: material.value,
		macKeyPath,
		rigKeyPath,
		mac,
		rig,
		serverPort,
	};
}

/** The Mac cohort signer, spawned the way `realRun` spawns it (tier B here). */
async function spawnLocalMac(pair: LocalStagedPair): Promise<SupervisorHandle> {
	// The two-condition seam: the variable and a key inside the scratch root.
	process.env[MAC_SUPERVISOR_UID_SEAM_ENV] = "1";
	const spawned = await spawnMacSupervisor({
		binaryPath: RELEASE_SUPERVISOR,
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		localPaths: {
			authorityFile: pair.bootstrap.authorityFile,
			authorityDigestFile: pair.bootstrap.authorityDigestFile,
			campaignRootDir: pair.bootstrap.campaignRootDir,
			stagingRootDir: pair.bootstrap.stagingRootDir,
		},
		cohort: {
			macSigningKey: { fd: 7, label: "mac-signing-key", path: pair.macKeyPath },
			stagedRigPublicKey: {
				fd: 8,
				label: "staged-rig-public-key",
				path: join(pair.bootstrap.stagingRootDir, "rig-supervisor-ed25519.pub"),
			},
			receiptValidityMs: COHORT_RECEIPT_VALIDITY_MS,
		},
		controllerUidSeam: { campaignScratchRoot: pair.scratchRoot },
	});
	if (!spawned.ok) {
		throw new Error(
			`spawnMacSupervisor refused (${spawned.code}): ${spawned.message}`,
		);
	}
	return spawned.handle;
}

/**
 * The rig, on this host: the same release binary, booted by the PRODUCTION
 * wrapper (`buildRigSupervisorWrapperScript`, the script `spawnRigSupervisor`
 * runs over ssh) -- bootstrap on 3..6, the rig signing key on 7, the role root
 * on 10, control on stdin/stdout -- and handed back as the `SupervisorHandle`
 * the controller's acquisition consumes. The role root is the receipt's
 * (`rigRoleRootPath`), the tree whose `server.ts` is the staged entrypoint.
 * Only the transport differs from production: the wrapper exec's here instead
 * of on the far side of an ssh session, because one machine has no sshd to
 * itself on the measured path.
 */
function spawnLocalRig(pair: LocalStagedPair): SupervisorHandle {
	const wrapper = buildRigSupervisorWrapperScript({
		binaryPath: RELEASE_SUPERVISOR,
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		rigBinaryPath: RELEASE_SUPERVISOR,
		rigPaths: {
			authorityFile: pair.bootstrap.authorityFile,
			authorityDigestFile: pair.bootstrap.authorityDigestFile,
			campaignRootDir: pair.bootstrap.campaignRootDir,
			stagingRootDir: pair.bootstrap.stagingRootDir,
		},
		rigCohort: {
			signingKey: { fd: 7, label: "cohort-signing-key", path: pair.rigKeyPath },
			roleRoot: {
				fd: 10,
				label: "cohort-role-root",
				path: pair.staged.receipt.rigRoleRootPath,
			},
		},
	});
	if (!wrapper.ok) {
		throw new Error(
			`rig wrapper refused (${wrapper.code}): ${wrapper.message}`,
		);
	}
	const script = wrapper.script;
	// No `env:` override: the wrapper exports COMPARISON_SUPERVISOR_BUN_PATH.
	const child = nodeSpawn("/bin/bash", ["-c", script], {
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		process.stderr.write(`[rig] ${chunk.toString("utf8")}`);
	});
	const pid = child.pid as number;
	const exited = new Promise<number>((done) => {
		child.on("exit", (code, signal) => done(code ?? (signal ? 128 : -1)));
	});
	return {
		pid,
		pgid: processGroupIdOf(pid),
		host: "rig",
		subprocess: {
			pid,
			get exitCode() {
				return child.exitCode;
			},
			kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
			exited,
		},
		bootstrapFds: [],
		controlParentFds: [],
		controllerToSupervisor: child.stdin as NonNullable<typeof child.stdin>,
		supervisorToController: child.stdout as NonNullable<typeof child.stdout>,
	};
}

/** `observeCampaignToolchains` without the ssh half: one Bun, both roles. */
async function localToolchains(): Promise<ToolchainSet> {
	const mac = await observeLocalToolchain();
	const identity = toolchainIdentity(mac);
	return {
		js: { identity, sha256: mac.bunExecutableSha256 },
		darwin: { identity, sha256: mac.bunExecutableSha256 },
		linux: { identity, sha256: mac.bunExecutableSha256 },
	};
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** One execution as the run observed it; the lease is production's, unmodified. */
interface ObservedExecution {
	readonly wire: "ws" | "wt";
	readonly repetitionKind: "warmup" | "measured";
	readonly lease: CohortArmLease;
	readonly result: ArmRepetitionDispatch;
	readonly perRepPath: string;
	readonly sealedPath: string;
	readonly root: string;
}

interface FourExecutionOutcome {
	readonly pair: LocalStagedPair;
	readonly executions: readonly ObservedExecution[];
	readonly macSupervisor: SupervisorHandle;
	readonly rigSupervisor: SupervisorHandle;
	readonly runtimeRoot: string;
	readonly provider: CohortArmRuntimeProvider;
	/** Every role-child pid a lease spawned, for the reap proof. */
	readonly roleChildPids: readonly number[];
	/** Every server child pid the rig reported, for the reap proof. */
	readonly serverChildPids: readonly number[];
}

/** Written by the four-execution run; read by the tests that verify its seals. */
let outcome: FourExecutionOutcome | undefined;

function requireOutcome(): FourExecutionOutcome {
	if (outcome === undefined) {
		throw new Error(
			"the four-execution run did not complete, so there are no seals to verify",
		);
	}
	return outcome;
}

function readSealed(path: string): {
	readonly bytes: Uint8Array;
	readonly artifact: RunArtifact;
} {
	const bytes = new Uint8Array(readFileSync(path));
	return {
		bytes,
		artifact: JSON.parse(Buffer.from(bytes).toString("utf8")) as RunArtifact,
	};
}

function retainedRecord(member: {
	readonly bytesBase64: string;
}): Record<string, unknown> {
	return JSON.parse(
		Buffer.from(member.bytesBase64, "base64").toString("utf8"),
	) as Record<string, unknown>;
}

function verifyWithStagedKeys(
	bytes: Uint8Array,
	artifact: RunArtifact,
	pair: LocalStagedPair,
) {
	return verifyRunArtifact(bytes, {
		...trustContextForArtifact(artifact),
		stagedMacPublicRaw32: pair.mac.publicRaw32,
		stagedRigPublicRaw32: pair.rig.publicRaw32,
	});
}

function reconstruct(artifact: RunArtifact, pair: LocalStagedPair) {
	return reconstructCohortEvidenceOffline({
		cellId: CHAT_CELL_ID,
		armKind: "primary",
		transport: artifact.transport === "wt" ? "wt" : "ws",
		executionSha256: artifact.attestationEvidence.executionSha256 as string,
		cohortObservationEvidence:
			artifact.attestationEvidence.cohortObservationEvidence,
		cohortEvidenceExport: artifact.cohortEvidenceExport,
		stagedMacPublicRaw32: pair.mac.publicRaw32,
		stagedRigPublicRaw32: pair.rig.publicRaw32,
	});
}

describe("B3.5 e2e: the production cohort dispatch for chat 1k over the staged pair", () => {
	it("the_frozen_topology_is_the_one_this_suite_claims_to_drive", () => {
		// The doc comment above states a topology; this pins it to the frozen
		// table so the two cannot drift into a comment that describes a cohort
		// nobody runs.
		expect(cohortCellCardinality(CHAT_COHORT_CELL)).toEqual({
			cell: CHAT_COHORT_CELL,
			publisherCount: 10,
			workerCount: 8,
			subscriberCount: 1_000,
			sessionCount: 1_010,
			measuredIngress: 300,
			expandedDeliveries: 300_000,
		});
		expect(cohortCellForArm({ cellId: CHAT_CELL_ID, armKind: "primary" })).toBe(
			CHAT_COHORT_CELL,
		);
		// Section 3 still drives the ticker-250 frames the Rust dispatch pins.
		expect(cohortCellForArm({ cellId: CELL_ID, armKind: "primary" })).toBe(
			COHORT_CELL,
		);
	});

	it("the_local_acceptance_listener_never_binds_inside_the_hosts_ephemeral_port_range", async () => {
		// Every WT connect takes a fresh client endpoint, and each endpoint draws a
		// fresh ephemeral UDP port. On macOS a dual-stack `[::]:0` draw is made
		// against the IPv6 table alone, so it can be handed a port an IPv4 socket
		// already owns; the listener's answers to `127.0.0.1:<that port>` then go to
		// the more specific socket and that one handshake can only end at the 10 s
		// bound. A listener that binds inside the ephemeral range is therefore one
		// more socket every client draw can collide with, and it is the one such
		// socket this file chooses. Measured 2026-09-06 in an eighteen-process
		// connect harness: 14 stalls in 42 runs with the listener on an ephemeral
		// port against 4 in 68 with it below the range, everything else equal.
		const floor = osEphemeralPortFloor();
		expect(floor).toBeGreaterThan(1_024);
		// The floor has to be the kernel's, not a number this file likes: eight
		// real unbound draws must all land at or above it, so a floor read that
		// drifted from the running host fails here rather than passing quietly.
		const drawn: number[] = [];
		for (let i = 0; i < 8; i += 1) {
			const socket = await Bun.udpSocket({});
			drawn.push(socket.port);
			socket.close();
		}
		for (const port of drawn) expect(port).toBeGreaterThanOrEqual(floor);
		for (const draw of [0, 0.5, 0.9999999]) {
			const port = chooseLocalAcceptanceServerPort(() => draw);
			expect(port).toBeGreaterThan(1_024);
			expect(port).toBeLessThan(floor);
		}
		expect(chooseLocalAcceptanceServerPort()).toBeLessThan(floor);
	});

	it("the_host_is_the_profiles_a_physical_record_refuses_loopback_and_the_local_record_refuses_the_cable_address", () => {
		// Design §3.1's loopback is a staged profile, not a redirect: the
		// record names its profile and is refused when its host is not that
		// profile's, in either direction. The probe names what is missing when
		// a host is not owned; this machine owns loopback.
		const recordFor = (profile: "phase-b" | "local-acceptance") =>
			buildStagedServerLaunchRecord({
				profile,
				transport: "ws",
				mode: "fanout-cohort",
				serverEntrypointSha256: "2".repeat(64) as Sha256Hex,
				bunSha256: "3".repeat(64) as Sha256Hex,
				addonSha256: "4".repeat(64) as Sha256Hex,
				bindPort: 4433,
				tlsCertificateSha256: "5".repeat(64) as Sha256Hex,
				tlsPrivateKeySha256: "6".repeat(64) as Sha256Hex,
			});
		expect(parseStagedServerLaunchRecord(recordFor("phase-b")).ok).toBe(true);
		expect(
			parseStagedServerLaunchRecord(recordFor("local-acceptance")).ok,
		).toBe(true);
		const physicalOverLoopback = parseStagedServerLaunchRecord({
			...recordFor("phase-b"),
			bindAddress: COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
			advertisedHost: COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
		});
		expect(physicalOverLoopback.ok).toBe(false);
		const localOverCable = parseStagedServerLaunchRecord({
			...recordFor("local-acceptance"),
			bindAddress: COHORT_SERVER_HOST,
			advertisedHost: COHORT_SERVER_HOST,
		});
		expect(localOverCable.ok).toBe(false);
		const absent = hostOwnsAdvertisedServerHost("192.0.2.1");
		expect(absent.ok).toBe(false);
		if (absent.ok) throw new Error("unreachable");
		expect(absent.code).toBe("COHORT_NOT_READY");
		expect(absent.message).toContain("192.0.2.1");
		expect(COHORT_SERVER_HOST).toBe("10.99.0.2");
		expect(COHORT_LOCAL_ACCEPTANCE_SERVER_HOST).toBe("127.0.0.1");
		expect(OWNS_LOCAL_HOST.ok).toBe(true);
	});

	it(
		"local_chat_1k_runs_warmup_and_measured_for_ws_and_wt_and_seals_two_non_promotable_arms",
		async () => {
			if (!OWNS_LOCAL_HOST.ok) throw new Error(OWNS_LOCAL_HOST.message);
			const pair = stageLocalPair();
			expect(pair.staged.receipt.stageProfile).toBe("local-acceptance");
			expect(
				stagedServerLaunchRecordFor(pair.staged, "ws", "fanout-cohort").record
					.advertisedHost,
			).toBe(COHORT_LOCAL_ACCEPTANCE_SERVER_HOST);
			const macSupervisor = await spawnLocalMac(pair);
			const rigSupervisor = spawnLocalRig(pair);
			const runtimeRoot = mkdtempSync(join(tmpdir(), "fanout-e2e-runtime-"));
			const toolchains = await localToolchains();
			const macClockId = observeMacClockIdentity();
			if (!macClockId.ok) throw new Error(macClockId.message);

			// The production lease factory, with the inputs `realRunBody` gives
			// it, observed (never replaced): every lease it returns is recorded
			// so the process cardinalities can be asserted after the fact.
			const observedLeases: CohortArmLease[] = [];
			const productionLease = createProductionCohortArmLeaseFactory({
				staged: pair.staged,
				bootstrap: pair.bootstrap,
				macSupervisor,
				rigSupervisor,
				executionPurpose: "pilot",
				repetitionTotal: 1,
				toolchains,
				bunExecutablePath: process.execPath,
				serverPort: pair.serverPort,
				tlsCaPem: pair.staged.tlsCaPem,
				macClockId: macClockId.value,
				runtimeRoot,
			});
			const provider = createCohortArmRuntimeProvider({
				sourceIdentity: {
					sourceSha: pair.staged.receipt.candidate,
					archiveSha256: pair.staged.receipt.archiveSha256,
					executableSha256: pair.staged.receipt.capabilitySha256,
				},
				supervisorToolchainDigests: {
					darwin: toolchains.darwin.sha256,
					linux: toolchains.linux.sha256,
				},
				executionPurpose: "pilot",
				repetitionTotal: 1,
				lease: async (context) => {
					const acquired = await productionLease(context);
					if (acquired.ok) observedLeases.push(acquired.value);
					return acquired;
				},
			});

			const cell = cellOf(CHAT_CELL_ID);
			const executions: ObservedExecution[] = [];
			const roleChildPids: number[] = [];
			const serverChildPids: number[] = [];
			try {
				// §5: one unsealed warmup then the measured repetition, per arm.
				for (const wire of ["ws", "wt"] as const) {
					const arm = sealArmsForCell(cell, [wire], ["primary"])[0];
					if (arm === undefined) throw new Error(`no ${wire} primary`);
					for (const repetitionKind of ["warmup", "measured"] as const) {
						const repIndex = repetitionKind === "warmup" ? 0 : 1;
						const root = mkdtempSync(
							join(tmpdir(), `fanout-e2e-${wire}-${repIndex}-`),
						);
						const perRepPath = join(root, `rep-${repIndex}.json`);
						const sealedPath = join(root, `rep-${repIndex}.sealed.json`);
						const leasesBefore = observedLeases.length;
						const result = await dispatchArmRepetition({
							arm: {
								cell,
								arm,
								runId: signedExecutionRunId({
									campaignId: pair.staged.receipt.campaignId,
									cellId: CHAT_CELL_ID,
									transport: wire,
									repetitionKind,
									repetitionIndex: repIndex,
								}),
								repIndex,
								repetitionKind,
								repetitionTotal: 1,
								executionPurpose: "pilot",
								perRepPath,
								sealedPath,
							} as unknown as Parameters<
								typeof dispatchArmRepetition
							>[0]["arm"],
							cohortRuntime: provider,
							// No `executors` override: `driveCohortArm` and the
							// provider's `seal` are the production functions.
						});
						const lease = observedLeases[leasesBefore];
						if (lease === undefined) {
							throw new Error(
								`${wire}/${repetitionKind}: no lease was acquired: ${JSON.stringify(result.result)}`,
							);
						}
						for (const child of lease.supervisor.spawnedChildren) {
							roleChildPids.push(child.pid);
						}
						const observationBytes =
							lease.retention.capture?.linuxRelayObservationBytes ?? null;
						if (observationBytes !== null) {
							const observation = JSON.parse(
								Buffer.from(observationBytes).toString("utf8"),
							) as { readonly serverChildPid: number };
							serverChildPids.push(observation.serverChildPid);
						}
						executions.push({
							wire,
							repetitionKind,
							lease,
							result,
							perRepPath,
							sealedPath,
							root,
						});
						if (!result.result.ok) {
							throw new Error(
								`${wire}/${repetitionKind} did not seal: ${result.result.failureCode ?? "TRUST_PROTOCOL"}: ${result.result.reason}`,
							);
						}
					}
				}
			} finally {
				outcome = {
					pair,
					executions,
					macSupervisor,
					rigSupervisor,
					runtimeRoot,
					provider,
					roleChildPids,
					serverChildPids,
				};
			}

			// Four executions, every one routed to the cohort executor and sealed.
			expect(
				executions.map(
					(execution) => `${execution.wire}/${execution.repetitionKind}`,
				),
			).toEqual(["ws/warmup", "ws/measured", "wt/warmup", "wt/measured"]);
			for (const execution of executions) {
				expect(execution.result.route).toBe("cohort");
				expect(execution.result.result.ok).toBe(true);
			}
			// The binary allocated one execution ordinal per opened execution.
			expect(
				executions.map((execution) => execution.lease.executionIndex),
			).toEqual([1, 2, 3, 4]);
			// Identities: warmup 0 / measured 1 per wire, from the binary's own
			// signed execution (the lease's runId is the opened execution's).
			for (const execution of executions) {
				const opened = execution.lease.supervisor;
				expect(opened.topology.expectedProcessCount).toBe(18);
				expect(opened.topology.expectedSessionCount).toBe(1_010);
				expect(execution.lease.publisherCount).toBe(10);
				expect(execution.lease.subscriberCount).toBe(1_000);
				expect(execution.lease.comparisonId).toBe(
					pair.staged.receipt.campaignId,
				);
			}
			// A warmup assembles, verifies and writes nothing; a measured
			// repetition writes exactly the seal and the export ack.
			for (const execution of executions) {
				if (execution.repetitionKind === "warmup") {
					expect(readdirSync(execution.root)).toEqual([]);
					continue;
				}
				expect(readdirSync(execution.root).sort()).toEqual([
					`rep-1.json`,
					`rep-1.sealed.json`,
				]);
				const { artifact } = readSealed(execution.sealedPath);
				expect(artifact.runId).toBe(
					`${pair.staged.receipt.campaignId}/${CHAT_CELL_ID}/${execution.wire}/measured-1`,
				);
				expect(artifact.transport).toBe(execution.wire);
				expect(artifact.executionPurpose).toBe("pilot");
				expect(artifact.promotable).toBe(false);
				const ack = JSON.parse(readFileSync(execution.perRepPath, "utf8")) as {
					readonly schema: string;
					readonly terminalExport: boolean;
				};
				expect(ack.schema).toBe("mac-cohort-evidence-exported-ack/v1");
				expect(ack.terminalExport).toBe(true);
			}
			// Process cardinality per execution: eighteen role children and one
			// server child, all of them gone once the lease's cleanup ran.
			expect(roleChildPids).toHaveLength(4 * 18);
			expect(serverChildPids).toHaveLength(4);
			expect(new Set(serverChildPids).size).toBe(4);
			for (const pid of [...roleChildPids, ...serverChildPids]) {
				expect(isAlive(pid)).toBe(false);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it("the_two_seals_verify_offline_with_both_issuer_graphs_and_the_registered_cardinalities", () => {
		const { pair, executions } = requireOutcome();
		const measured = executions.filter(
			(execution) => execution.repetitionKind === "measured",
		);
		expect(measured).toHaveLength(2);
		for (const execution of measured) {
			const { bytes, artifact } = readSealed(execution.sealedPath);
			// The offline verifier, with the staged keys: PASS, and not
			// promotable (pilot).
			const verification = verifyWithStagedKeys(bytes, artifact, pair);
			expect(verification.rejections).toEqual([]);
			expect(verification.evidenceStatus).toBe("PASS");
			expect(artifact.promotable).toBe(false);
			// Both issuer graphs close under the staged keys, and each names
			// the key of the process that signed it: the Mac graph the
			// spawned binary's descriptor key, the rig graph the rig's.
			const reconstructed = reconstruct(artifact, pair);
			expect(reconstructed.ok).toBe(true);
			if (!reconstructed.ok)
				throw new Error(`${reconstructed.code}: ${reconstructed.reason}`);
			expect(reconstructed.receiptGraphComplete).toBe(true);
			const evidence = artifact.attestationEvidence
				.cohortObservationEvidence as CohortObservationEvidenceV1;
			expect(retainedRecord(evidence.cohortGrant).signingPublicKeySha256).toBe(
				pair.mac.publicKeySha256,
			);
			expect(
				retainedRecord(evidence.cohortAdmissionReceipt).signingPublicKeySha256,
			).toBe(pair.mac.publicKeySha256);
			expect(
				retainedRecord(evidence.rigCohortAcceptance).signingPublicKeySha256,
			).toBe(pair.rig.publicKeySha256);
			expect(
				retainedRecord(evidence.rigRelayObservationReceipt)
					.signingPublicKeySha256,
			).toBe(pair.rig.publicKeySha256);
			// Session and delivery cardinalities equal the registered cell.
			expect(reconstructed.capacity.expectedSessions).toBe(1_010);
			expect(reconstructed.capacity.sessionsAccepted).toBe(1_010);
			expect(reconstructed.capacity.registeredPublishers).toBe(10);
			expect(reconstructed.capacity.registeredSubscribers).toBe(1_000);
			expect(reconstructed.linuxObservation.sessionsAccepted).toBe(1_010);
			expect(reconstructed.ledger.offeredExpandedDeliveries).toBe(300_000);
			expect(reconstructed.ledger.serverAcceptedExpandedDeliveries).toBe(
				300_000,
			);
			expect(reconstructed.ledger.delivered).toBe(300_000);
			expect(reconstructed.processProof.expectedProcessCount).toBe(18);
			expect(reconstructed.processProof.observedProcessCount).toBe(18);
			expect(reconstructed.processProof.observedPublisherCount).toBe(10);
			expect(reconstructed.processProof.observedSubscriberCount).toBe(1_000);
		}
	});

	it("a_forged_export_ack_signature_and_a_substituted_observation_each_fail_the_seal_by_closed_code", () => {
		const { pair, executions } = requireOutcome();
		const [ws, wt] = executions.filter(
			(execution) => execution.repetitionKind === "measured",
		);
		if (ws === undefined || wt === undefined)
			throw new Error("two seals expected");
		const honest = readSealed(wt.sealedPath);
		expect(
			verifyWithStagedKeys(honest.bytes, honest.artifact, pair).evidenceStatus,
		).toBe("PASS");

		// (1) The terminal export ack re-signed by a key that is not the
		// staged one: the seven-field transcript no longer verifies under
		// the staged Mac key.
		const foreign = generateEd25519KeyPair();
		const export_ = honest.artifact
			.cohortEvidenceExport as CohortEvidenceExportReceipt;
		const forgedSignature = ed25519Sign(
			foreign.privatePkcs8Der,
			cohortExportAckSigningBytes(export_),
		);
		const forged = sealRunArtifact({
			...honest.artifact,
			cohortEvidenceExport: {
				...export_,
				cohortObservationEvidenceSignatureBase64:
					Buffer.from(forgedSignature).toString("base64"),
			},
		});
		const forgedVerdict = verifyWithStagedKeys(
			forged,
			JSON.parse(Buffer.from(forged).toString("utf8")) as RunArtifact,
			pair,
		);
		expect(forgedVerdict.evidenceStatus).not.toBe("PASS");
		expect(
			forgedVerdict.rejections.some((rejection) =>
				rejection.reason.startsWith("COHORT_EXPORT_RECEIPT_INVALID"),
			),
		).toBe(true);

		// (2) The wt seal carrying the ws arm's honestly signed Linux
		// observation: every byte is genuine, the graph is not this
		// execution's, and the verifier says so by its closed code. The
		// export receipt binds size before digest (plan 2097: "decoded size
		// must ... equal the declared size; then digest"), so which of the two
		// codes a cross-arm swap earns depends on whether the swapped record
		// still canonicalizes to the length the receipt declares -- a property
		// of two runs' numbers, not of the rule. The rule is what is asserted:
		// the expected code is derived from the length the verifier itself
		// compares (`verify-artifact.ts:3634`), and both branches are exact.
		const wsEvidence = readSealed(ws.sealedPath).artifact.attestationEvidence
			.cohortObservationEvidence as CohortObservationEvidenceV1;
		const wtEvidence = honest.artifact.attestationEvidence
			.cohortObservationEvidence as CohortObservationEvidenceV1;
		const codesOf = (verdict: ReturnType<typeof verifyWithStagedKeys>) =>
			verdict.rejections
				.map((rejection) => rejection.reason.split(":")[0] ?? "")
				.filter((code) => code.startsWith("COHORT_"));
		const substituted = sealRunArtifact({
			...honest.artifact,
			attestationEvidence: {
				...honest.artifact.attestationEvidence,
				cohortObservationEvidence: {
					...wtEvidence,
					linuxRelayObservation: wsEvidence.linuxRelayObservation,
				},
			},
		});
		const substitutedVerdict = verifyWithStagedKeys(
			substituted,
			JSON.parse(Buffer.from(substituted).toString("utf8")) as RunArtifact,
			pair,
		);
		expect(substitutedVerdict.evidenceStatus).not.toBe("PASS");
		const substitutedSize = canonicalRecordBytes({
			...wtEvidence,
			linuxRelayObservation: wsEvidence.linuxRelayObservation,
		}).byteLength;
		// One code, and the other one absent: size and digest are ordered, not
		// alternatives.
		expect(codesOf(substitutedVerdict)).toEqual([
			substitutedSize === export_.cohortObservationEvidenceSize
				? "COHORT_EXPORT_DIGEST_MISMATCH"
				: "COHORT_EXPORT_SIZE_MISMATCH",
		]);

		// (3) The same evidence with one hex digit of the observation's
		// retained digest flipped: the size the receipt declares still holds,
		// so the digest is what refuses.
		const retained = wtEvidence.linuxRelayObservation;
		const flippedDigest = `${retained.sha256.slice(0, -1)}${
			retained.sha256.endsWith("0") ? "1" : "0"
		}`;
		const flipped = sealRunArtifact({
			...honest.artifact,
			attestationEvidence: {
				...honest.artifact.attestationEvidence,
				cohortObservationEvidence: {
					...wtEvidence,
					linuxRelayObservation: { ...retained, sha256: flippedDigest },
				},
			},
		});
		const flippedVerdict = verifyWithStagedKeys(
			flipped,
			JSON.parse(Buffer.from(flipped).toString("utf8")) as RunArtifact,
			pair,
		);
		expect(flippedVerdict.evidenceStatus).not.toBe("PASS");
		expect(codesOf(flippedVerdict)).toEqual(["COHORT_EXPORT_DIGEST_MISMATCH"]);
	});

	it(
		"a_role_child_that_never_reaches_readiness_fails_the_arm_by_its_closed_code_and_leaves_no_file",
		async () => {
			// The same campaign, one more execution (ticker 250: a 30 s readiness
			// deadline), with the first role child the supervisor spawns stopped
			// before it can answer. The production driver times it out, the
			// dispatch files the arm FAIL under the closed set, the lease's
			// cleanup reaps the stopped group, and the root stays empty.
			const { provider, pair } = requireOutcome();
			const cell = cellOf(CELL_ID);
			const arm = sealArmsForCell(cell, ["ws"], ["primary"])[0];
			if (arm === undefined) throw new Error("no ws primary");
			const root = mkdtempSync(join(tmpdir(), "fanout-e2e-timeout-"));
			let stoppedPid: number | null = null;
			const stopFirstChild = (lease: CohortArmLease): (() => void) => {
				const timer = setInterval(() => {
					const first = lease.supervisor.spawnedChildren[0];
					if (first !== undefined && stoppedPid === null) {
						stoppedPid = first.pid;
						process.kill(first.pid, "SIGSTOP");
					}
				}, 20);
				return () => clearInterval(timer);
			};
			const stops: Array<() => void> = [];
			const observingProvider: CohortArmRuntimeProvider = async (context) => {
				const runtime = await provider(context);
				if (runtime.ok) {
					stops.push(
						stopFirstChild(runtime.value as unknown as CohortArmLease),
					);
				}
				return runtime;
			};
			let dispatched: ArmRepetitionDispatch;
			try {
				dispatched = await dispatchArmRepetition({
					arm: {
						cell,
						arm,
						runId: signedExecutionRunId({
							campaignId: pair.staged.receipt.campaignId,
							cellId: CELL_ID,
							transport: "ws",
							repetitionKind: "measured",
							repetitionIndex: 1,
						}),
						repIndex: 1,
						repetitionKind: "measured",
						repetitionTotal: 1,
						executionPurpose: "pilot",
						perRepPath: join(root, "rep-1.json"),
						sealedPath: join(root, "rep-1.sealed.json"),
					} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"],
					cohortRuntime: observingProvider,
				});
			} finally {
				for (const stop of stops) stop();
			}
			if (stoppedPid === null) {
				// The dispatch ended before any role child existed: say where.
				throw new Error(
					`no role child was spawned to stop; the dispatch ended with ${JSON.stringify(dispatched.result)}`,
				);
			}
			expect(dispatched.route).toBe("cohort");
			expect(dispatched.result.ok).toBe(false);
			if (dispatched.result.ok) throw new Error("unreachable");
			expect(dispatched.result.failureCode).toBe("COHORT_PROTOCOL");
			expect(dispatched.result.reason).toContain("READY_DEADLINE_EXCEEDED");
			expect(readdirSync(root)).toEqual([]);
			expect(isAlive(stoppedPid as unknown as number)).toBe(false);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"teardown_reaps_both_supervisors_and_no_child_survives_it",
		async () => {
			const {
				macSupervisor,
				rigSupervisor,
				roleChildPids,
				serverChildPids,
				pair,
				runtimeRoot,
			} = requireOutcome();
			const rigStopped = await stopSupervisor(rigSupervisor, 10_000);
			expect(rigStopped.ok).toBe(true);
			const macStopped = await stopSupervisor(macSupervisor, 10_000);
			expect(macStopped.ok).toBe(true);
			expect(isAlive(rigSupervisor.pid)).toBe(false);
			expect(isAlive(macSupervisor.pid)).toBe(false);
			for (const pid of [...roleChildPids, ...serverChildPids]) {
				expect(isAlive(pid)).toBe(false);
			}
			// The scratch roots -- the Mac key never left its own -- are
			// unlinked once the last describe that reads the staged keys and
			// the seals has run (`afterAll` at the end of this file).
			void pair;
			void runtimeRoot;
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it("a_refused_cohort_arm_is_never_demoted_to_a_single_session_leg", async () => {
		// The demotion this guards against measures one publisher and presents
		// it as a 101-session cohort. `measureSealAndWriteRep` is the
		// production leg executor; if the dispatch ever reached it for a
		// fanout primary, the injected spy below would fire.
		const cell = cellOf(CELL_ID);
		const arm = sealArmsForCell(cell, ["ws"], ["primary"])[0];
		let legRuns = 0;
		const dispatched = await dispatchArmRepetition({
			arm: {
				cell,
				arm,
				runId: "e2e-no-demotion",
				repIndex: 1,
				repetitionKind: "measured",
				repetitionTotal: 1,
				executionPurpose: "pilot",
				perRepPath: "/dev/null",
				sealedPath: "/dev/null",
			} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"],
			// No lease: the production provider refuses by name and the seam
			// still routes to the cohort executor, never to the leg.
			cohortRuntime: createCohortArmRuntimeProvider({
				sourceIdentity: {
					sourceSha: "candidate-b35",
					archiveSha256: "a".repeat(64),
					executableSha256: "b".repeat(64),
				},
				executionPurpose: "pilot",
				repetitionTotal: 1,
			}),
			executors: {
				measureSealAndWriteRep: async () => {
					legRuns += 1;
					return { ok: false, reason: "must not run" };
				},
			},
		});
		expect(legRuns).toBe(0);
		expect(dispatched.route).toBe("cohort");
		expect(dispatched.result.ok).toBe(false);
		if (dispatched.result.ok) throw new Error("unreachable");
		expect(dispatched.result.failureCode).toBe("COHORT_NOT_READY");
		expect(dispatched.result.reason).toContain("acquireCohortArmMaterial");
	});
});

// ---------------------------------------------------------------------------
// 2. The real fanout-cohort server child process
// ---------------------------------------------------------------------------

describe("B3.5 e2e: the real fanout-cohort server process", () => {
	function runServer(env: Record<string, string>): {
		readonly exitCode: number;
		readonly output: string;
	} {
		const argv = stagedServerLaunchArgv(
			"wt",
			"fanout-cohort",
			"local-acceptance",
		);
		expect(argv[0]).toBe("server.ts");
		const proc = Bun.spawnSync({
			cmd: [
				"bun",
				join(REPO_ROOT, "tools", "compare", argv[0] as string),
				...argv.slice(1),
			],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		return {
			exitCode: proc.exitCode,
			output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
		};
	}

	/** Stage-time constants a phase-b launch record would carry. */
	const WELL_FORMED_ENV = {
		WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
			new Uint8Array(32),
		).toString("base64"),
		WS_WT_COHORT_LINUX_CLOCK_ID: "c".repeat(64),
		WS_WT_COHORT_RECEIPT_VALIDITY_MS: "60000",
		WS_WT_TLS_CERT_CONTENT:
			"-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
		WS_WT_TLS_KEY_CONTENT:
			"-----BEGIN PRIVATE KEY-----\nZml4dHVyZQ==\n-----END PRIVATE KEY-----\n",
		WS_WT_TLS_SERVER_NAME: "wt-compare.local",
	};

	it(
		"refuses_at_the_absent_control_pipe_rather_than_binding_a_listener",
		() => {
			const run = runServer(WELL_FORMED_ENV);
			// This used to be "no signed cohort grant channel": the frame had no
			// signature field, so no grant could ever be authenticated here.
			// `server-bind-execution/v1` now carries one and this entrypoint
			// reads it off FD 3, so the deepest refusal a process spawned
			// *without* a rig supervisor can reach is the missing pipe itself.
			// It is still before any listener.
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toContain("UNEXPECTED_FD");
			expect(run.output).toContain("rig-supervisor server child");
			// Past the stage-time env gate: the refusal is the deep one, not
			// the shallow one. Without this the test would pass on a server
			// that simply could not read its own environment.
			expect(run.output).not.toContain("fanout cohort mode requires");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"refuses_earlier_when_the_stage_time_environment_is_absent",
		() => {
			const run = runServer({
				WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: "",
				WS_WT_COHORT_LINUX_CLOCK_ID: "",
				WS_WT_COHORT_RECEIPT_VALIDITY_MS: "",
			});
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toContain("fanout cohort mode requires");
			// A server that could not name its Mac key must not have reached
			// the control-pipe branch at all.
			expect(run.output).not.toContain("UNEXPECTED_FD");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	/**
	 * The same real process, this time with the §3.4 control pipes attached and
	 * this test standing in for the rig on the other end of them.
	 *
	 * Only the rig is stood in for. The child is the real entrypoint, the frames
	 * are the real codec, the grant is really signed and really verified against
	 * the key the process reads out of its own environment, the socket it opens
	 * is a real socket, and the role peers on it are real WSS clients holding
	 * real tokens against the Merkle root the grant commits to.
	 *
	 * ## Why this test is a positive
	 *
	 * It replaces
	 * `the_child_binds_a_socket_and_then_exits_because_no_relay_serves_the_cohort`,
	 * whose comment already read "WILL BECOME: the child stays up". S6 (design
	 * §2.1) made it stay up, so the negative is gone and what it pinned is
	 * asserted here in the shape it became. The old test also supplied a
	 * three-field stub grant (`{schema, executionSha256, transport}`), which
	 * `decideCohortBind` accepts but `acceptCohortGrant` -- the full §4.1 codec
	 * the relay is built from -- correctly refuses. A cohort cannot be served
	 * from a stub, so this test mints a **full Mac-signed grant**, exactly as
	 * `server-fanout-cohort.test.ts` does.
	 *
	 * The deep per-frame assertions belong to S6's own suite
	 * (`server-fanout-cohort.test.ts`, tree). What this file asserts is the one
	 * thing it exists to assert: the boundary it used to pin is *unreachable*.
	 *
	 * NOTE (mandate): this file's asserted list is still not §3.3's. Wave 6's
	 * S10 rewrites the whole file to that list and owns it; this test is an
	 * interim replacement for the single negative S6 turned positive, and every
	 * other test in the file is untouched.
	 */
	it(
		"the_child_serves_the_cohort_relay_and_stays_alive_until_it_is_told_to_stop",
		async () => {
			// Topology: the smallest cohort that is still a cohort. The rung is
			// reduced (this is a unit-scale relay, not ticker 250); the *shape* --
			// many publishers expanded to a full worker fan-out -- is not.
			const HEX = (character: string): Sha256Hex =>
				character.repeat(64) as Sha256Hex;
			const COHORT_ID = "cohort-b35-e2e-server-child";
			const PUBLISHER_COUNT = 2;
			const SUBSCRIBER_COUNT = COHORT_WORKER_COUNT;
			const MESSAGE_BYTES = 100 as const;
			const SAMPLE_WINDOW_MS = 1_000;
			const MEASURED_DURATION_MS = 10_000;
			const WINDOW_COUNT = MEASURED_DURATION_MS / SAMPLE_WINDOW_MS;
			const MEASURED_FRAMES_PER_PUBLISHER = 4;
			const LINUX_CLOCK_ID = "c".repeat(64);
			const MANIFEST_SHA = HEX("3");
			const PUBLISHER_IDS = Array.from(
				{ length: PUBLISHER_COUNT },
				(_unused, index) => fanoutRoleId("publisher", index),
			);
			const SUBSCRIBER_IDS = Array.from(
				{ length: SUBSCRIBER_COUNT },
				(_unused, index) => fanoutRoleId("subscriber", index),
			);

			const mac = generateEd25519KeyPair();
			const dir = mkdtempSync(join(tmpdir(), "fanout-e2e-child-"));
			const openPeers: BinaryMessageClient[] = [];
			let spawned: ReturnType<typeof nodeSpawn> | null = null;
			try {
				const tls = selfSignedTls(dir);

				// The Mac's half, minted the way the Mac mints it: a real
				// `cross-supervisor-execution/v1` and a grant that carries the real
				// token commitment root the role peers will prove against.
				const tokens: FanoutCohortFixture = buildFanoutCohortFixture({
					cohortId: COHORT_ID,
					publisherCount: PUBLISHER_COUNT,
					subscriberCount: SUBSCRIBER_COUNT,
				});
				const issuedAtMs = Date.now();
				const notAfterMs = issuedAtMs + 600_000;
				const stagedLaunchRecord = {
					schema: "staged-server-launch-record/v1",
					stageReceiptSha256: HEX("1"),
					serverEntrypointSha256: HEX("2"),
					bunSha256: HEX("3"),
					addonSha256: HEX("4"),
					bindAddress: "127.0.0.1",
					bindPort: 4433,
					advertisedHost: "127.0.0.1",
					tlsServerName: "wt-compare.local",
					transport: "ws",
					argv: [
						...stagedServerLaunchArgv(
							"ws",
							"fanout-cohort",
							"local-acceptance",
						),
					],
					allowedEnvironment: [],
				};
				const workloadBytes = bytesOfCanonical({
					plan: "b35-e2e",
					cohortId: COHORT_ID,
				});
				const built = macConstructFinalExecution({
					draft: {
						schema: "cross-supervisor-execution-draft/v1",
						authoritySha256: HEX("a"),
						campaignLockSha256: HEX("b"),
						stagedCapabilitySha256: HEX("c"),
						sourceArchiveSha256: HEX("d"),
						approvedPlanSha256: HEX("e"),
						approvalRecordSha256: HEX("f"),
						candidate: "cand",
						campaignId: "camp",
						runId: `camp/${CELL_ID}/ws/measured-1`,
						executionPurpose: "focused",
						cellId: CELL_ID,
						scenarioHash: HEX("5"),
						rolePlanHash: HEX("6"),
						workloadRolePlanInputSha256: sha256HexOfBytes(workloadBytes),
						stagedServerLaunchRecordSha256: sha256HexOfBytes(
							bytesOfCanonical(stagedLaunchRecord),
						),
						armKind: "primary",
						transport: "ws",
						repetitionKind: "measured",
						repetitionIndex: 1,
						repetitionTotal: 1,
						grantDeclaration: "fanout-expanded-deliveries",
						declaredMessageCount: 250_000,
						declaredMessageBytes: MESSAGE_BYTES,
						requestedNotAfterMs: notAfterMs,
					},
					executionIndex: 0,
					macSupervisorInstanceNonce: HEX("7"),
					issuedAtMs,
					notAfterMs,
					grantNonceSha256: HEX("8"),
				});
				if (!built.ok) throw new Error(`execution: ${built.code}`);
				const { execution, executionSha256 } = built.value;
				const offeredIngress = PUBLISHER_COUNT * MEASURED_FRAMES_PER_PUBLISHER;
				const grant = {
					schema: "cohort-grant/v1",
					execution,
					executionSha256,
					macExecutionGrantReceiptSha256: HEX("9"),
					approvedPlanSha256: execution.approvedPlanSha256,
					approvalRecordSha256: execution.approvalRecordSha256,
					cohortId: COHORT_ID,
					cohortAttempt: 1,
					scenarioHash: execution.scenarioHash,
					rolePlanHash: execution.rolePlanHash,
					workloadRolePlanInputSha256: execution.workloadRolePlanInputSha256,
					transport: "ws",
					publisherCount: PUBLISHER_COUNT,
					subscriberCount: SUBSCRIBER_COUNT,
					workerCount: COHORT_WORKER_COUNT,
					expectedProcessCount: PUBLISHER_COUNT + COHORT_WORKER_COUNT,
					expectedSessionCount: PUBLISHER_COUNT + SUBSCRIBER_COUNT,
					publishers: [...tokens.publishers],
					subscriberShards: [...tokens.subscriberShards] as SubscriberShardV1[],
					tokenCommitmentLeafManifestSha256: HEX("0"),
					roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
					roleTokenCommitmentCount: tokens.roleTokenCommitmentCount,
					connectionRatePerSecond: 500,
					maxConnectionsInFlight: 200,
					readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
					inRepetitionWarmupMs: 5_000,
					sampleWindowMs: SAMPLE_WINDOW_MS,
					measuredDurationMs: MEASURED_DURATION_MS,
					drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS,
					messageBytes: MESSAGE_BYTES,
					expectedOfferedIngress: offeredIngress,
					expectedExpandedDeliveries: offeredIngress * SUBSCRIBER_COUNT,
					macSupervisorInstanceNonce: HEX("7"),
					signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
					receiptSequence: 1,
					issuedAtMs,
					notAfterMs,
				} as unknown as CohortGrantV1;
				const grantBytes = bytesOfCanonical(grant);
				const grantSha256 = sha256HexOfBytes(grantBytes);
				const macSign = (
					signedSchema: Parameters<typeof signMacReceipt>[0]["signedSchema"],
					signedBytes: Uint8Array,
				): unknown =>
					signMacReceipt({
						privatePkcs8Der: mac.privatePkcs8Der,
						publicRaw32: mac.publicRaw32,
						signedSchema,
						signedBytes,
					});
				const base64Of = (record: unknown): string =>
					Buffer.from(bytesOfCanonical(record)).toString("base64");
				const frameBytes = (
					record: Record<string, unknown> & { schema: string },
				): Uint8Array => {
					const encoded = encodeServerChildFrame(record);
					if (!encoded.ok) {
						throw new Error(`encode ${record.schema}: ${encoded.code}`);
					}
					return encoded.value;
				};

				const bind = buildServerBindExecution({
					sequence: 0,
					executionSha256,
					rigExecutionAcceptanceSha256: HEX("e"),
					cohortGrantBase64: Buffer.from(grantBytes).toString("base64"),
					cohortGrantSignatureBase64: base64Of(
						macSign("cohort-grant/v1", grantBytes),
					),
					macExecutionGrantReceiptBase64: null,
					macExecutionGrantSignatureBase64: null,
				});
				if (!bind.ok) throw new Error(`bind frame: ${bind.code}`);
				const epochRecord: CohortWarmupEpochV1 = {
					schema: "cohort-warmup-epoch/v1",
					executionSha256,
					cohortGrantSha256: grantSha256,
					cohortId: COHORT_ID,
					warmupNonce: HEX("8"),
					durationMs: 5_000,
					warmupMessagesPerPublisher: WARMUP_MESSAGES_PER_PUBLISHER,
					warmupIntervalMs: 500,
					expectedWarmupIngress:
						PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER,
					expectedWarmupDeliveries:
						PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER * SUBSCRIBER_COUNT,
					macSupervisorInstanceNonce: HEX("7"),
					signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
					receiptSequence: 2,
					issuedAtMs,
					notAfterMs,
				};
				const epoch = bytesOfCanonical(epochRecord);
				const epochSha256 = sha256HexOfBytes(epoch);
				const warmupStart = buildServerWarmupStart({
					sequence: 1,
					executionSha256,
					cohortWarmupEpochBase64: Buffer.from(epoch).toString("base64"),
					cohortWarmupEpochSignatureBase64: base64Of(
						macSign("cohort-warmup-epoch/v1", epoch),
					),
				});
				if (!warmupStart.ok) throw new Error(`warmup: ${warmupStart.code}`);

				const inbound = createCloexecPipe({ parentKeeps: "write" });
				const outbound = createCloexecPipe({ parentKeeps: "read" });
				if (!inbound.ok || !outbound.ok) throw new Error("pipe(2) failed");
				const argv = stagedServerLaunchArgv(
					"ws",
					"fanout-cohort",
					"local-acceptance",
				);
				const port = 20_000 + Math.floor(Math.random() * 20_000);
				const child = nodeSpawn(
					"bun",
					[
						join(REPO_ROOT, "tools", "compare", argv[0] as string),
						...argv.slice(1),
						// The staged argv names transport, mode, profile and the
						// local profile's bind (loopback); the port is the rig's.
						`--port=${port}`,
					],
					{
						cwd: REPO_ROOT,
						stdio: [
							"ignore",
							"pipe",
							"pipe",
							inbound.pipe.childFd,
							outbound.pipe.childFd,
						],
						env: {
							...process.env,
							WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
								mac.publicRaw32,
							).toString("base64"),
							WS_WT_COHORT_LINUX_CLOCK_ID: LINUX_CLOCK_ID,
							WS_WT_COHORT_RECEIPT_VALIDITY_MS: "600000",
							WS_WT_TLS_CERT_CONTENT: tls.cert,
							WS_WT_TLS_KEY_CONTENT: tls.key,
							WS_WT_TLS_SERVER_NAME: "wt-compare.local",
						},
					},
				);
				spawned = child;
				let childExited = false;
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
				child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
				const exited = new Promise<number>((done) => {
					child.once("exit", (code) => {
						childExited = true;
						done(code ?? -1);
					});
				});

				const answers: Record<string, unknown>[] = [];
				let buffered = Buffer.alloc(0);
				const reader = createReadStream("", {
					fd: outbound.pipe.parentFd,
					autoClose: true,
				});
				reader.on("data", (chunk: Buffer | string) => {
					buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
					for (;;) {
						if (buffered.byteLength < 4) break;
						const length = buffered.readUInt32BE(0);
						if (buffered.byteLength < 4 + length) break;
						const frame = buffered.subarray(0, 4 + length);
						buffered = buffered.subarray(4 + length);
						const decoded = decodeChildPipeFrame(new Uint8Array(frame));
						if (!decoded.ok) throw new Error(`child frame: ${decoded.code}`);
						answers.push(decoded.value);
					}
				});
				const outputSoFar = (): string =>
					`${Buffer.concat(stdout).toString()}${Buffer.concat(stderr).toString()}`;

				// `writeSync` rather than a stream: the frames are small and their
				// ordering against the child's reads has to be exact.
				let parentWriteClosed = false;
				const closeParentWrite = (): void => {
					if (parentWriteClosed) return;
					parentWriteClosed = true;
					closeSync(inbound.pipe.parentFd);
				};
				const send = (
					record: Record<string, unknown> & { schema: string },
				): void => {
					const frame = frameBytes(record);
					let written = 0;
					while (written < frame.byteLength) {
						written += writeSync(
							inbound.pipe.parentFd,
							frame,
							written,
							frame.byteLength - written,
						);
					}
				};
				const awaitAnswers = async (
					count: number,
					whatFor: string,
				): Promise<void> => {
					const deadline = Date.now() + 60_000;
					while (answers.length < count) {
						if (Date.now() > deadline) {
							throw new Error(
								`timed out waiting for ${whatFor}: ${answers.length} of ${count}; output=${outputSoFar().slice(-2000)}`,
							);
						}
						await Bun.sleep(20);
					}
				};
				const waitUntil = async (
					predicate: () => boolean,
					whatFor: string,
				): Promise<void> => {
					const deadline = Date.now() + 60_000;
					while (!predicate()) {
						if (Date.now() > deadline) {
							throw new Error(
								`timed out waiting for ${whatFor}; output=${outputSoFar().slice(-2000)}`,
							);
						}
						await Bun.sleep(20);
					}
				};

				// A real role peer: a real WSS session carrying the real token and
				// Merkle proof the grant's commitment root covers.
				const codec = fanoutFrameCodecFor("ws");
				// A compact delivery as this peer saw it, resolved to its epoch
				// by the delivery context the relay wrote ahead of it (D2).
				interface ReceivedDelivery extends FanoutDeliveryC1 {
					readonly kind: "delivery";
					readonly epoch: "warmup" | "measured";
				}
				type ReceivedUnit = FanoutWireV1 | ReceivedDelivery;
				interface RolePeer {
					readonly roleId: string;
					send(frame: FanoutWireV1): void;
					received(): readonly ReceivedUnit[];
				}
				const deliveriesOf = (
					peer: RolePeer,
					epoch: "warmup" | "measured",
				): ReceivedDelivery[] =>
					peer
						.received()
						.filter(
							(unit): unit is ReceivedDelivery =>
								unit.kind === "delivery" && unit.epoch === epoch,
						);
				const connectRole = async (
					role: "publisher" | "subscriber",
					roleId: string,
				): Promise<RolePeer> => {
					const received: ReceivedUnit[] = [];
					const tags: { warmup: number | null; measured: number | null } = {
						warmup: null,
						measured: null,
					};
					const client = await connectBinaryMessageClient({
						url: `wss://127.0.0.1:${port}/fanout`,
						tls: {
							rejectUnauthorized: true,
							serverName: "wt-compare.local",
							ca: tls.cert,
						},
						onMessage: (bytes) => {
							if (fanoutDeliveryUnitKind(bytes, "ws") === "compact") {
								const delivery = decodeFanoutDelivery(bytes, MESSAGE_BYTES);
								if (!delivery.ok) {
									throw new Error(`peer delivery: ${delivery.code}`);
								}
								const epoch =
									delivery.value.contextTag === tags.measured
										? "measured"
										: delivery.value.contextTag === tags.warmup
											? "warmup"
											: null;
								if (epoch === null) {
									throw new Error(
										`${roleId} saw a compact frame before its context`,
									);
								}
								received.push({ ...delivery.value, kind: "delivery", epoch });
								return;
							}
							const decoded = codec.decode(bytes);
							if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
							if (decoded.value.kind === "delivery-context") {
								tags[decoded.value.epoch] = contextTagOfDeliveryContextSha256(
									decoded.value.deliveryContextSha256,
								);
							}
							received.push(decoded.value);
						},
					});
					openPeers.push(client);
					const sendWire = (frame: FanoutWireV1): void => {
						const encoded = codec.encode(frame);
						if (!encoded.ok) {
							throw new Error(`encode ${frame.kind}: ${encoded.code}`);
						}
						client.send(encoded.value);
					};
					sendWire({
						schema: "fanout-wire/v1",
						kind: "register",
						cohortGrantSha256: grantSha256,
						transport: "ws",
						role,
						childId: tokens.childIdByRoleId.get(roleId) as string,
						roleId,
						workerIndex: tokens.workerIndexByRoleId.get(roleId) ?? null,
						tokenBase64: tokens.tokenBase64ByRoleId.get(roleId) as Base64,
						tokenSha256: tokens.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
						tokenCommitmentIndex: tokens.commitmentIndexByRoleId.get(
							roleId,
						) as number,
						tokenMerkleProofSha256: [
							...(tokens.proofByRoleId.get(roleId) ?? []),
						],
					} as FanoutWireV1);
					return { roleId, send: sendWire, received: () => received };
				};

				// R->C 0: bind. The grant is verified against the staged Mac key
				// before any listener exists.
				send(
					bind.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(1, "server-ready/v1");
				const ready = parseServerReady(answers[0] as Record<string, unknown>);
				expect(ready.ok).toBe(true);
				if (!ready.ok) throw new Error("unreachable");
				expect(ready.value.cohortGrantSha256).toBe(grantSha256);
				expect(ready.value.executionSha256).toBe(executionSha256);
				expect(ready.value.listeningAddress).toContain(`:${port}`);

				// RAMP_AND_READY: the cohort comes up on the socket the child bound.
				// This is the half the deleted negative said was impossible -- "no
				// role peer can register and no ingress can be accepted".
				const subscribers: RolePeer[] = [];
				for (const roleId of SUBSCRIBER_IDS) {
					subscribers.push(await connectRole("subscriber", roleId));
				}
				const publishers: RolePeer[] = [];
				for (const roleId of PUBLISHER_IDS) {
					publishers.push(await connectRole("publisher", roleId));
				}
				for (const peer of [...subscribers, ...publishers]) {
					await waitUntil(
						() => peer.received().some((frame) => frame.kind === "accept"),
						`accept for ${peer.roleId}`,
					);
				}

				// R->C 1: warmup start.
				send(
					warmupStart.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(2, "server-warmup-ready/v1");
				const warmupReady = parseServerWarmupReady(
					answers[1] as Record<string, unknown>,
				);
				expect(warmupReady.ok).toBe(true);
				if (!warmupReady.ok) throw new Error("unreachable");
				expect(warmupReady.value.cohortWarmupEpochSha256).toBe(epochSha256);
				expect(warmupReady.value.warmupCountersZero).toBe(true);

				// THE REPLACED ASSERTION. The old test's whole finding was that the
				// process exited here. It is still running, and it is running as a
				// relay: the peers above are registered on it.
				expect(childExited).toBe(false);
				expect(spawned?.exitCode).toBeNull();

				// The warmup wire, expanded to every subscriber by the real relay.
				const expectedWarmupIngress =
					PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER;
				for (const publisher of publishers) {
					for (
						let sequence = 0;
						sequence < WARMUP_MESSAGES_PER_PUBLISHER;
						sequence += 1
					) {
						publisher.send({
							schema: "fanout-wire/v1",
							kind: "warmup-data",
							direction: "publisher-to-relay",
							cohortGrantSha256: grantSha256,
							cohortWarmupEpochSha256: epochSha256,
							warmupNonce: epochRecord.warmupNonce,
							publisherId: publisher.roleId,
							publisherSequence: sequence,
							subscriberId: null,
							linuxAcceptedOrdinal: null,
							...fanoutPayload(
								MESSAGE_BYTES,
								`${publisher.roleId}:warmup:${sequence}`,
							),
							payloadBytes: MESSAGE_BYTES,
						} as FanoutWireV1);
					}
					publisher.send({
						schema: "fanout-wire/v1",
						kind: "warmup-end",
						cohortGrantSha256: grantSha256,
						cohortWarmupEpochSha256: epochSha256,
						warmupNonce: epochRecord.warmupNonce,
						role: "publisher",
						roleId: publisher.roleId,
						finalPublisherSequence: WARMUP_MESSAGES_PER_PUBLISHER - 1,
						reason: "publisher-warmup-complete",
					} as FanoutWireV1);
				}
				for (const subscriber of subscribers) {
					await waitUntil(
						() =>
							deliveriesOf(subscriber, "warmup").length >=
							expectedWarmupIngress,
						`warmup deliveries to ${subscriber.roleId}`,
					);
				}

				// R->C 2: drain and reset.
				const drainAndReset = buildServerWarmupDrainAndReset({
					sequence: 2,
					executionSha256,
					cohortWarmupEpochSha256: epochSha256,
					roleWarmupCompletionManifestSha256: MANIFEST_SHA,
				});
				if (!drainAndReset.ok) throw new Error(`drain: ${drainAndReset.code}`);
				send(
					drainAndReset.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(3, "server-warmup-drained/v1");
				const drained = parseServerWarmupDrained(
					answers[2] as Record<string, unknown>,
				);
				expect(drained.ok).toBe(true);
				if (!drained.ok) throw new Error("unreachable");
				// Counters that exist. The deleted negative said "every §5 transition
				// after warmup reports counters that do not exist"; these are the
				// relay's own, over frames that really crossed a socket.
				expect(drained.value.warmupIngress).toBe(expectedWarmupIngress);
				expect(drained.value.warmupDeliveries).toBe(
					expectedWarmupIngress * SUBSCRIBER_COUNT,
				);
				expect(drained.value.linuxClockId).toBe(LINUX_CLOCK_ID);

				// R->C 3: the Linux baseline.
				const measureStart = buildServerMeasureStart({
					sequence: 3,
					executionSha256,
					warmupCompleteSha256: MANIFEST_SHA,
				});
				if (!measureStart.ok) throw new Error(`measure: ${measureStart.code}`);
				send(
					measureStart.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(4, "server-measure-start-ack/v1");
				const baseline = parseServerMeasureStartAck(
					answers[3] as Record<string, unknown>,
				);
				expect(baseline.ok).toBe(true);
				if (!baseline.ok) throw new Error("unreachable");
				expect(baseline.value.baselineBusyMs).toBeGreaterThanOrEqual(0);

				// R->C 4: the start barrier.
				// One clock read: `parseCohortStartBarrier` requires the measured
				// span to equal `measuredDurationMs` exactly, so start and stop must
				// derive from the same millisecond.
				const barrierNowMs = Date.now();
				const macNs = `${BigInt(barrierNowMs) * 1_000_000n}` as NsString;
				const barrierRecord: CohortStartBarrierV1 = {
					schema: "cohort-start-barrier/v1",
					executionSha256,
					cohortGrantSha256: grantSha256,
					rigCohortAcceptanceSha256: HEX("1"),
					rigMeasureStartAckSha256: HEX("2"),
					roleWarmupCompletionManifestSha256: MANIFEST_SHA,
					roleWarmupCompletionManifestSignatureSha256: HEX("4"),
					rigWarmupDrainedReceiptSha256: HEX("5"),
					cohortId: COHORT_ID,
					barrierNonce: HEX("6"),
					macClockId: "m".repeat(64),
					mintedAtMacNs: macNs,
					warmupStartedAtMacNs: macNs,
					warmupCompletedAtMacNs: macNs,
					measureStartAtMacNs: macNs,
					measureStopAtMacNs:
						`${BigInt(barrierNowMs + MEASURED_DURATION_MS) * 1_000_000n}` as NsString,
					sampleWindowMs: SAMPLE_WINDOW_MS,
					windowCount: WINDOW_COUNT as 10 | 30,
					measuredDurationMs: MEASURED_DURATION_MS as 10000 | 30000,
					drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS as 10000,
					macSupervisorInstanceNonce: HEX("7"),
					signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
					receiptSequence: 3,
					issuedAtMs,
					notAfterMs,
				};
				const barrierBytes = bytesOfCanonical(barrierRecord);
				const barrierSha256 = sha256HexOfBytes(barrierBytes);
				const present = buildServerPresentStartBarrier({
					sequence: 4,
					executionSha256,
					cohortStartBarrierBase64:
						Buffer.from(barrierBytes).toString("base64"),
					cohortStartBarrierSignatureBase64: base64Of(
						macSign("cohort-start-barrier/v1", barrierBytes),
					),
				});
				if (!present.ok) throw new Error(`barrier: ${present.code}`);
				send(
					present.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(5, "server-start-barrier-accepted/v1");
				const accepted = parseServerStartBarrierAccepted(
					answers[4] as Record<string, unknown>,
				);
				expect(accepted.ok).toBe(true);
				if (!accepted.ok) throw new Error("unreachable");
				expect(accepted.value.cohortStartBarrierSha256).toBe(barrierSha256);
				expect(accepted.value.measuredTrafficAllowed).toBe(true);

				// MEASURING: real measured ingress through the real relay.
				const expectedMeasured =
					PUBLISHER_COUNT * MEASURED_FRAMES_PER_PUBLISHER;
				for (const publisher of publishers) {
					for (
						let sequence = 0;
						sequence < MEASURED_FRAMES_PER_PUBLISHER;
						sequence += 1
					) {
						publisher.send({
							schema: "fanout-wire/v1",
							kind: "data",
							direction: "publisher-to-relay",
							cohortGrantSha256: grantSha256,
							cohortStartBarrierSha256: barrierSha256,
							windowIndex: 0,
							publisherId: publisher.roleId,
							publisherSequence: sequence,
							subscriberId: null,
							linuxAcceptedOrdinal: null,
							...fanoutPayload(
								MESSAGE_BYTES,
								`${publisher.roleId}:measured:${sequence}`,
							),
							payloadBytes: MESSAGE_BYTES,
						} as FanoutWireV1);
					}
				}
				for (const subscriber of subscribers) {
					await waitUntil(
						() =>
							deliveriesOf(subscriber, "measured").length >= expectedMeasured,
						`measured deliveries to ${subscriber.roleId}`,
					);
				}

				// R->C 5: stop and capture.
				const stop = buildServerStopAndCapture({
					sequence: 5,
					executionSha256,
					cohortStartBarrierSha256: barrierSha256,
					drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS,
				});
				if (!stop.ok) throw new Error(`stop: ${stop.code}`);
				send(
					stop.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(6, "server-capture-ack/v1");
				const capture = parseServerCaptureAck(
					answers[5] as Record<string, unknown>,
				);
				expect(capture.ok).toBe(true);
				if (!capture.ok) throw new Error("unreachable");
				const observation = JSON.parse(
					Buffer.from(
						capture.value.linuxRelayObservationBase64 as string,
						"base64",
					).toString("utf8"),
				) as Record<string, unknown>;
				expect(observation.schema).toBe("linux-relay-observation/v1");
				expect(observation.registeredPublisherCount).toBe(PUBLISHER_COUNT);
				expect(observation.registeredSubscriberCount).toBe(SUBSCRIBER_COUNT);
				expect(
					(observation.relayWritesCompletedByOriginWindow as number[]).reduce(
						(sum, value) => sum + value,
						0,
					),
				).toBe(expectedMeasured * SUBSCRIBER_COUNT);

				// R->C 6: teardown. It exits when it is *told* to, not because it
				// ran out of things it knew how to answer.
				const teardown = buildServerTeardown({
					sequence: 6,
					executionSha256,
				});
				if (!teardown.ok) throw new Error(`teardown: ${teardown.code}`);
				send(
					teardown.value as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				await awaitAnswers(7, "server-stopped/v1");
				const stopped = parseServerStopped(
					answers[6] as Record<string, unknown>,
				);
				expect(stopped.ok).toBe(true);
				if (!stopped.ok) throw new Error("unreachable");
				expect(stopped.value.exitCode).toBe(0);
				expect(stopped.value.allSessionsClosed).toBe(true);

				// The old assertion was `answers.length === 2`. Seven frames, in the
				// frozen order, over one process that lived through all of them.
				expect(answers.map((frame) => frame.schema)).toEqual([
					"server-ready/v1",
					"server-warmup-ready/v1",
					"server-warmup-drained/v1",
					"server-measure-start-ack/v1",
					"server-start-barrier-accepted/v1",
					"server-capture-ack/v1",
					"server-stopped/v1",
				]);
				closeParentWrite();
				const exitCode = await Promise.race([
					exited,
					new Promise<number>((done) => setTimeout(() => done(-999), 30_000)),
				]);
				expect(exitCode).toBe(0);
				reader.destroy();
			} finally {
				for (const peer of openPeers) {
					try {
						peer.close();
					} catch {
						// Already closed by the child's teardown.
					}
				}
				spawned?.kill("SIGKILL");
				rmSync(dir, { recursive: true, force: true });
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// 3. The real supervisor binary over the real remote codec
// ---------------------------------------------------------------------------

/**
 * Build the two release binaries the live path resolves by default. Cheap
 * when warm; the per-test timeout covers a cold build.
 */
function buildSupervisorBinaries(): void {
	const built = Bun.spawnSync({
		cmd: [
			"cargo",
			"build",
			"-p",
			"native",
			"--release",
			"--bin",
			"comparison-supervisor",
			"--bin",
			"observe-directory-identity",
		],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (built.exitCode !== 0) {
		throw new Error(
			`cargo build failed (${built.exitCode}): ${built.stderr.toString().slice(-2000)}`,
		);
	}
}

/** Mint a fixture trust bootstrap the real binary will accept, over `out`. */
function mintTrustBootstrap(
	out: string = mkdtempSync(join(tmpdir(), "fanout-e2e-boot-")),
): string {
	const minted = Bun.spawnSync({
		cmd: [
			"bun",
			join(
				REPO_ROOT,
				"tools",
				"compare",
				"bin",
				"mint-live-trust-bootstrap.ts",
			),
			"--fixture-only",
			`--out=${out}`,
		],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			OBSERVE_DIRECTORY_IDENTITY_BINARY: join(
				REPO_ROOT,
				"target",
				"release",
				"observe-directory-identity",
			),
		},
	});
	if (minted.exitCode !== 0) {
		throw new Error(
			`mint-live-trust-bootstrap failed (${minted.exitCode}): ${minted.stderr.toString()}`,
		);
	}
	return out;
}

/** Boot the real supervisor through the production local spawn path. */
async function bootSupervisor(stagedDir: string) {
	const spawned = await spawnMacSupervisor({
		binaryPath: join(REPO_ROOT, "target", "release", "comparison-supervisor"),
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		control: {
			controlIn: { fd: 0, label: "control-in" },
			controlOut: { fd: 1, label: "control-out" },
		},
		localPaths: {
			authorityFile: join(stagedDir, TRUST_BOOTSTRAP_AUTHORITY_LEAF),
			authorityDigestFile: join(
				stagedDir,
				TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
			),
			campaignRootDir: join(stagedDir, TRUST_BOOTSTRAP_CAMPAIGN_ROOT),
			stagingRootDir: join(stagedDir, TRUST_BOOTSTRAP_STAGING_ROOT),
		},
	});
	if (!spawned.ok) {
		throw new Error(
			`spawnMacSupervisor refused (${spawned.code}): ${spawned.message}`,
		);
	}
	return spawned.handle;
}

/**
 * The one cohort request this suite puts on the wire.
 *
 * Six keys, not four: §2.13 widened the accept frame to carry this execution's
 * Phase-A `rig-execution-acceptance/v1` and the rig signature over it, so one
 * campaign-scoped rig process can bind a second execution without a second
 * startup. The rig's `RIG_ACCEPT_COHORT_FIELDS` is an exact key set, so the
 * four-key form no longer reaches the transition at all.
 */
const ACCEPT_COHORT_REQUEST = {
	schema: "rig-accept-cohort-request/v1",
	requestSeq: 1,
	executionSha256: "a".repeat(64),
	cohortGrantBase64: "e30=",
	cohortGrantSignatureBase64: "e30=",
	rigExecutionAcceptanceBase64: "e30=",
	rigExecutionAcceptanceSignatureBase64: "e30=",
} as const;

/**
 * Every controller -> rig cohort request, in the shape the frozen §3.3 field
 * table names, at the shallowest content each one accepts.
 *
 * The point of the sweep is the *frame*, not the record: each of these is
 * encoded by the production encoder and must be recognised by the rig's own
 * dispatch. Their records are deliberately thin, because a rig with no cohort
 * installed refuses all six on the same code and the interesting thing is that
 * it refuses rather than terminating the session.
 */
const COHORT_REQUESTS: readonly (Record<string, unknown> & {
	readonly schema: string;
})[] = [
	ACCEPT_COHORT_REQUEST,
	{
		schema: "rig-spawn-server-request/v1",
		requestSeq: 2,
		executionSha256: "a".repeat(64),
		cohortGrantSha256: "b".repeat(64),
		serverEntrypointSha256: "c".repeat(64),
		bunSha256: "d".repeat(64),
		addonSha256: "e".repeat(64),
		stagedServerLaunchRecordBase64: "e30=",
		stagedServerLaunchRecordSha256: "f".repeat(64),
		stagedServerLaunchRecordSize: 2,
		bindAddress: "10.99.0.2",
		bindPort: 4433,
		advertisedHost: "10.99.0.2",
		tlsServerName: "wt-compare.local",
		transport: "ws",
		serverArgv: ["server.ts"],
	},
	{
		schema: "rig-begin-warmup-request/v1",
		requestSeq: 3,
		executionSha256: "a".repeat(64),
		cohortWarmupEpochBase64: "e30=",
		cohortWarmupEpochSignatureBase64: "e30=",
	},
	{
		schema: "rig-finish-warmup-request/v1",
		requestSeq: 4,
		executionSha256: "a".repeat(64),
		roleWarmupCompletionManifestBase64: "e30=",
		roleWarmupCompletionManifestSignatureBase64: "e30=",
	},
	{
		schema: "rig-measure-start-request/v1",
		requestSeq: 5,
		executionSha256: "a".repeat(64),
		cohortGrantSha256: "b".repeat(64),
		warmupCompleteSha256: "c".repeat(64),
		rigWarmupDrainedReceiptSha256: "d".repeat(64),
	},
	{
		schema: "rig-present-start-barrier-request/v1",
		requestSeq: 6,
		executionSha256: "a".repeat(64),
		cohortStartBarrierBase64: "e30=",
		cohortStartBarrierSignatureBase64: "e30=",
	},
];

/**
 * The exact frames `crates/native/src/bin/comparison-supervisor.rs` decodes in
 * its own `cohort_dispatch_tests` module, pinned here so neither side of the
 * cross-language pair can move alone.
 *
 * A pinned byte string is worth more than an equality between two functions
 * here: the failure this pair exists to catch was two *correct-looking*
 * implementations of "the frame kind", one deriving it from the schema and one
 * matching it as the schema. Only the bytes tell them apart.
 */
const RUST_PINNED_FRAME_HEX: Readonly<Record<string, string>> = {
	"rig-accept-cohort-request/v1":
		"0000004f7b226b696e64223a227269672d6163636570742d636f686f72742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001227b22636f686f72744772616e74426173653634223a226533303d222c22636f686f72744772616e745369676e6174757265426173653634223a226533303d222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a312c22726967457865637574696f6e416363657074616e6365426173653634223a226533303d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a226533303d222c22736368656d61223a227269672d6163636570742d636f686f72742d726571756573742f7631227d0a086cfd430284b746eb187ca91b232fca30fa21a947677f7d228ec9e27e859efa",
	"rig-measure-start-request/v1":
		"0000004f7b226b696e64223a227269672d6d6561737572652d73746172742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001a27b22636f686f72744772616e74536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a352c227269675761726d7570447261696e656452656365697074536861323536223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464222c22736368656d61223a227269672d6d6561737572652d73746172742d726571756573742f7631222c227761726d7570436f6d706c657465536861323536223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363227d0ad8587aab427325779bc31a24fe67c03d90e48bafa9b3d2c36a63776802506729",
};

function encodedFrame(payload: Record<string, unknown> & { schema: string }) {
	const encoded = encodeRegisteredRemotePayload(payload);
	if (!encoded.ok) throw new Error(`encode ${payload.schema}: ${encoded.code}`);
	return encoded.value;
}

/** Read whatever the supervisor writes next, or time out. */
async function readNext(
	handle: Awaited<ReturnType<typeof bootSupervisor>>,
	timeoutMs: number,
): Promise<string> {
	const stream = handle.supervisorToController;
	if (stream === undefined) throw new Error("no control-out stream");
	const chunks: Buffer[] = [];
	await new Promise<void>((done) => {
		const timer = setTimeout(done, timeoutMs);
		stream.on("data", (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk));
			clearTimeout(timer);
			done();
		});
	});
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read until `wanted` complete supervisor frames have arrived, and return each
 * one's header kind with its parsed payload.
 *
 * Decoding rather than substring-matching is the point: "the session was not
 * terminated" is a statement about frame boundaries, and a test that reads the
 * bytes as a string cannot tell six answers from one answer repeated.
 */
async function readAnswers(
	handle: Awaited<ReturnType<typeof bootSupervisor>>,
	wanted: number,
	timeoutMs: number,
): Promise<readonly { kind: string; payload: Record<string, unknown> }[]> {
	const stream = handle.supervisorToController;
	if (stream === undefined) throw new Error("no control-out stream");
	const answers: { kind: string; payload: Record<string, unknown> }[] = [];
	let buffered = Buffer.alloc(0);
	await new Promise<void>((done) => {
		const timer = setTimeout(done, timeoutMs);
		stream.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
			for (;;) {
				const decoded = decodeSupervisorFrame(
					new Uint8Array(buffered),
					SUPERVISOR_ARTIFACT_PAYLOAD_MAX_BYTES,
				);
				if (!decoded.ok) break;
				const header = JSON.parse(
					new TextDecoder().decode(decoded.value.frame.header),
				) as { kind: string };
				const payload = JSON.parse(
					new TextDecoder().decode(decoded.value.frame.payload),
				) as Record<string, unknown>;
				answers.push({ kind: header.kind, payload });
				buffered = buffered.subarray(decoded.value.consumed);
			}
			if (answers.length >= wanted) {
				clearTimeout(timer);
				done();
			}
		});
	});
	return answers;
}

describe("B3.5 e2e: the real comparison-supervisor binary over the real codec", () => {
	it("the_frames_the_rust_dispatch_pins_are_the_ones_this_encoder_produces", () => {
		// The forward half of the cross-language pair, and the cheap half: no
		// process, no build. `comparison-supervisor.rs`'s `cohort_dispatch_tests`
		// holds these same two hex strings and feeds them to the real `serve`
		// dispatch, so a change to either encoder that moves a byte turns one of
		// the two suites red immediately instead of at the next 15-minute e2e.
		for (const [schema, hex] of Object.entries(RUST_PINNED_FRAME_HEX)) {
			const payload = COHORT_REQUESTS.find(
				(candidate) => candidate.schema === schema,
			);
			expect(payload).toBeDefined();
			if (payload === undefined) throw new Error("unreachable");
			expect(Buffer.from(encodedFrame(payload)).toString("hex")).toBe(hex);
		}
	});

	it("every_cohort_frame_kind_is_its_schema_without_the_version_suffix", () => {
		// §3.3, in one line: "`header.kind` is exactly the payload `schema` with
		// the terminal `/v1` removed". This is what the rig was not doing.
		for (const payload of COHORT_REQUESTS) {
			const decoded = decodeRegisteredRemotePayload(encodedFrame(payload));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("unreachable");
			expect(decoded.value.headerKind).toBe(payload.schema.slice(0, -3));
		}
	});

	it(
		"every_production_encoded_cohort_frame_is_matched_by_the_real_rig_dispatch",
		async () => {
			// The property is that each of the six frames the production encoder
			// can produce is *matched* by the rig dispatch: named, carried to
			// its own transition, and answered with that transition's refusal
			// rather than with `TRUST_CHILD_FRAME_INVALID`, which is what an
			// unmatched kind produces. Production installs no cohort runtime,
			// so every transition refuses on `COHORT_NOT_READY`.
			//
			// One session per frame, because §2.7 made a refused cohort
			// transition terminal: `terminate_cohort` writes the refusal, tears
			// the cohort down and ends the arm. An earlier form of this test
			// wrote all six into one session and expected six answers; under
			// §2.7 that session is over after the first, and the six-in-a-row
			// reading was the pre-§2.7 one. Driving each frame in a fresh
			// session tests what the name says and stays true afterwards.
			//
			// WILL BECOME: six acks rather than six refusals, once `serve`
			// installs a runtime from a signing-key fd, the staged Mac key and a
			// Phase-A rig binding (residual 5 of the deviation, another slice).
			buildSupervisorBinaries();
			for (const payload of COHORT_REQUESTS) {
				const handle = await bootSupervisor(mintTrustBootstrap());
				try {
					handle.controllerToSupervisor?.write(
						Buffer.from(encodedFrame(payload)),
					);
					const answers = await readAnswers(handle, 1, 20_000);
					expect(answers.length).toBe(1);
					const answer = answers[0];
					if (answer === undefined) throw new Error("unreachable");
					// §2.7's refusal kind. Plan 531: "The refusal kind is
					// `remote-supervisor-refusal`. No alias kind is accepted."
					expect(answer.kind).toBe("remote-supervisor-refusal");
					// The frame was named, the transition was reached, and the
					// transition said the rig holds no cohort.
					// `TRUST_CHILD_FRAME_INVALID` here would mean the kind fell
					// off the dispatch again -- which is the whole point of the
					// sweep.
					expect(answer.payload.code).toBe("COHORT_NOT_READY");
					expect(answer.payload.terminal).toBe(true);
					expect(answer.payload.ackRequestSeq).toBe(payload.requestSeq);
				} finally {
					await stopSupervisor(handle, 5_000);
				}
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"a_kind_spelled_as_a_schema_is_still_not_a_frame_this_rig_speaks",
		async () => {
			// The other side of the same contract, and the reason the fix is a
			// fix and not a second alias: the suffixed spelling the rig used to
			// match is not admitted now that the header spelling is. One kind
			// per frame, and an unknown kind still ends the stream.
			buildSupervisorBinaries();
			const handle = await bootSupervisor(mintTrustBootstrap());
			try {
				const header = new TextEncoder().encode(
					`${JSON.stringify({
						kind: "rig-accept-cohort-request/v1",
						schema: "comparison-supervisor-frame/v1",
					})}\n`,
				);
				const framed = encodeSupervisorFrame(
					header,
					bytesOfCanonical(ACCEPT_COHORT_REQUEST as unknown as never),
					1_048_576,
				);
				expect(framed.ok).toBe(true);
				if (!framed.ok) throw new Error("unreachable");
				handle.controllerToSupervisor?.write(Buffer.from(framed.value));
				const answer = await readNext(handle, 10_000);
				expect(answer).toContain("TRUST_CHILD_FRAME_INVALID");
				expect(answer).not.toContain("COHORT_NOT_READY");
			} finally {
				await stopSupervisor(handle, 5_000);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"the_controllers_cohort_channel_reports_the_rigs_own_refusal_code",
		async () => {
			// D2, closed. The rig answers a refused transition in the Phase-A
			// `admission-refusal` / `measurement-refusal/v1` shape, which is not
			// a registered remote kind; the channel used to hand that to
			// `decodeRegisteredRemotePayload` and report "unregistered remote
			// kind" over the top of whatever the rig was trying to say. An
			// operator reading the campaign log can now tell "the rig has no
			// cohort runtime" from "the wire is corrupt".
			buildSupervisorBinaries();
			const handle = await bootSupervisor(mintTrustBootstrap());
			try {
				const channel = new CohortRigChannel({
					controllerToRig: handle.controllerToSupervisor as never,
					rigToController: handle.supervisorToController as never,
					// The real process behind the pipes: a refusal here names
					// its exit status and stderr instead of a bare timeout.
					childDiagnostics: handle.diagnostics,
					executionSha256: "a".repeat(64) as never,
					stagedRigPublicRaw32: new Uint8Array(32),
					deadlines: {
						frameMs: 5_000,
						serverReadyMs: 5_000,
						warmupDrainMs: 5_000,
						captureMs: 5_000,
						teardownMs: 5_000,
					},
				});
				const accepted = await channel.acceptExecution({
					measurementGrantBytes: new TextEncoder().encode("{}"),
					receiptBytes: new TextEncoder().encode("{}"),
					receiptSignatureBytes: new TextEncoder().encode("{}"),
				});
				expect(accepted.ok).toBe(false);
				if (accepted.ok) throw new Error("unreachable");
				// The rig's code, as a §7 literal, not a decode failure.
				expect(accepted.code).toBe("COHORT_NOT_READY");
				expect(accepted.message).toContain("COHORT_NOT_READY");
				expect(accepted.message).not.toContain("decode");
			} finally {
				await stopSupervisor(handle, 5_000);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// 4. What the campaign index claims about this run
// ---------------------------------------------------------------------------

describe("B3.5 e2e: the campaign index over the two sealed cohort arms", () => {
	afterAll(() => {
		// The Mac key never left the scratch root and is unlinked with it;
		// the seals and the runtime root go with it.
		const run = outcome;
		if (run === undefined) return;
		rmSync(run.pair.root, { recursive: true, force: true });
		rmSync(run.runtimeRoot, { recursive: true, force: true });
		for (const execution of run.executions) {
			rmSync(execution.root, { recursive: true, force: true });
		}
	});

	/**
	 * The index `realRunBody` writes for two sealed pilot arms (its PASS entry,
	 * verbatim). A campaign's seals live under its own root and the index
	 * names them relative to it -- the verifier refuses a sealed path that
	 * leaves the root -- so each execution's seal is laid under this root
	 * byte for byte, as the campaign lays its own.
	 */
	function sealedIndex(root: string, run: FourExecutionOutcome): string {
		const entries: CampaignIndexEntryV2[] = run.executions
			.filter((execution) => execution.repetitionKind === "measured")
			.map((execution) => {
				const sealed = execution.result.result;
				if (!sealed.ok) throw new Error("a measured execution did not seal");
				const sealedName = `${CHAT_CELL_ID.replace(/[/:]/g, "_")}-${execution.wire}-rep-1.sealed.json`;
				copyFileSync(sealed.sealedPath, join(root, sealedName));
				return {
					schema: "campaign-index-entry/v2",
					cellId: CHAT_CELL_ID,
					armId: `${CHAT_CELL_ID}/${execution.wire}`,
					transport: execution.wire,
					armKind: "primary",
					armTransport: execution.wire,
					impairment: "none",
					executionPurpose: "pilot",
					repetitionKind: "measured",
					repetitionIndex: 1,
					repetitionTotal: 1,
					status: "PASS",
					promotable: false,
					failureCode: null,
					refusalCode: null,
					sealedPath: sealedName,
					artifactSha256: sealed.artifactSha256,
					primaryMetricP50: sealed.primaryMetricP50,
					readPath: null,
				};
			});
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: run.pair.staged.receipt.campaignId,
			stage: "full",
			candidate: run.pair.staged.receipt.candidate,
			campaignId: run.pair.staged.receipt.campaignId,
			approvedPlanSha256: run.pair.staged.receipt.approvedPlanSha256,
			approvalRecordSha256: run.pair.staged.receipt.approvalRecordSha256,
			stagedCapabilitySha256: run.pair.staged.receipt.capabilitySha256,
			sourceArchiveSha256: run.pair.staged.receipt.archiveSha256,
			executionPurpose: "pilot",
			cells: [CHAT_CELL_ID],
			arms: ["ws", "wt"],
			armKinds: ["primary"],
			// The schedule is exactly one warmup then the measured reps (§5).
			// A warmup is never sealed, indexed or counted, so it leaves no
			// entry behind -- but the index still declares that it ran.
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 2,
			entries,
		};
		const indexPath = join(root, "campaign-index.json");
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		return indexPath;
	}

	it("the_wrapper_expected_counts_for_a_sealed_pilot_pair_are_met_and_nothing_is_promotable", () => {
		// The shape the mandate asked this suite to prove: two measured PASS
		// seals, nothing promotable, no flats, both issuer graphs opened with
		// the staged keys. This replaces the negative that pinned it as
		// unsatisfiable while no cohort could be measured.
		const run = requireOutcome();
		const root = mkdtempSync(join(tmpdir(), "fanout-e2e-index-"));
		const indexPath = sealedIndex(root, run);
		const claimed = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			macPublicKeyPath: join(
				run.pair.bootstrap.stagingRootDir,
				"mac-supervisor-ed25519.pub",
			),
			rigPublicKeyPath: join(
				run.pair.bootstrap.stagingRootDir,
				"rig-supervisor-ed25519.pub",
			),
			expectedPassCount: 2,
			expectedFailCount: 0,
			expectedPromotableCount: 0,
			expectedFlatCount: 0,
			expectedSealedCount: 2,
		});
		if (!claimed.ok) throw new Error(JSON.stringify(claimed).slice(0, 1_200));
		expect(claimed.passCount).toBe(2);
		expect(claimed.sealedCount).toBe(2);
		expect(claimed.promotableCount).toBe(0);
		expect(claimed.promotedCells).toEqual([]);
		expect(claimed.canonicalFanoutComplete).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});

	it("an_index_that_claims_seals_it_does_not_have_is_refused", () => {
		// A campaign that measured nothing cannot claim the pilot-shaped counts:
		// the wrapper's expected counts are a check, not a declaration.
		const root = mkdtempSync(join(tmpdir(), "fanout-e2e-index-empty-"));
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "e2e-run",
			stage: "full",
			candidate: "candidate-b35",
			campaignId: "e2e-campaign",
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: "b".repeat(64),
			sourceArchiveSha256: "a".repeat(64),
			executionPurpose: "pilot",
			cells: [CHAT_CELL_ID],
			arms: ["ws", "wt"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 2,
			entries: [],
		};
		const indexPath = join(root, "campaign-index.json");
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		const claimed = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			expectedPassCount: 2,
			expectedPromotableCount: 0,
			expectedFlatCount: 0,
			expectedSealedCount: 2,
		});
		expect(claimed.ok).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});
});
