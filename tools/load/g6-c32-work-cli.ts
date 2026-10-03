import { readFileSync } from "node:fs";
import { readSystemClock } from "./g6-c32-system-clock.ts";

function workClock() {
	const snapshot = readSystemClock();
	return { monotonicNs: snapshot.nanoseconds, clockDomain: snapshot.domain };
}

import { validateBudgetPolicy, validateSpendLedger } from "./g6-c32-budget.ts";
import { verifyBoundFreeze } from "./g6-c32-freeze.ts";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import {
	createWorkFinal,
	finishWorkCell,
	gradePendingWorkCell,
	initializeWorkExecution,
	readWorkExecution,
	sealPendingWorkCell,
	startWorkCell,
	writeWorkJson,
} from "./g6-c32-work-execution.ts";
import type { WorkNode } from "./g6-c32-work-plan.ts";
import type { WorkProfile } from "./g6-c32-work-profile.ts";
import { deriveWorkAuthority } from "./g6-capacity-work-authority.ts";
import { linuxProbeProducerSha256 } from "./g6-linux-probe.ts";
import { nativeSendPathProducerSha256 } from "./g6-native-send-path.ts";

/** Fixed positional adapter to the existing cell implementation, not a schedule. */
export function workCellArguments(node: WorkNode, p: WorkProfile): string[] {
	return [
		node.id,
		node.requestedSessions,
		p.endpoints,
		p.connectConcurrency,
		p.connectRatePerSec,
		p.receiveBufferBytes,
		p.detailedProbe ? 1 : 0,
		p.gradeMode,
		"work",
		node.activeWorkloadSessions,
		node.kind,
		p.ackReflector,
		p.serverWorkers,
		p.serverGro,
		p.serverRecvRuntime,
		p.ackCadence,
		p.pacerPps,
		p.udpSendBatch,
		p.serverUdpSendBufferBytes,
		p.serverUdpSendEagainMode,
		p.reflectRingBypass,
		1,
		p.fixedSourcePortBase,
		p.shards,
		// Never launch a cell whose arm does not name its datagram read path.
		p.datagramPump ??
			(() => {
				throw Error("work profile lacks datagramPump; refusing to launch");
			})(),
		// Position 26: generator processes on the one generator host.
		p.clientProcesses ?? 1,
	].map(String);
}

export async function runWorkCli(args: readonly string[]): Promise<unknown> {
	const [mode, ...rest] = args;
	const allowed = new Set([
		"--root",
		"--policy",
		"--ledger",
		...(mode === "init"
			? [
					"--deadline",
					"--candidate",
					"--registration",
					"--setup-receipt",
					"--bound-root",
					"--repository",
				]
			: []),
		...(["start", "grade", "seal", "finish"].includes(mode ?? "")
			? ["--node"]
			: []),
	]);
	if (
		!["init", "next", "start", "grade", "seal", "finish", "finalize"].includes(
			mode ?? "",
		) ||
		rest.length % 2
	)
		throw Error("invalid work CLI mode/options");
	const pairs: Record<string, string> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const key = requireDefined(rest[i]),
			value = requireDefined(rest[i + 1]);
		if (
			!allowed.has(key) ||
			Object.hasOwn(pairs, key) ||
			value.length === 0 ||
			value.startsWith("--")
		)
			throw Error("unknown/repeated work CLI option");
		pairs[key] = value;
	}
	for (const key of allowed)
		if (pairs[key] === undefined) throw Error(`missing ${key}`);
	const policy = validateBudgetPolicy(
			JSON.parse(readFileSync(requireDefined(pairs["--policy"]), "utf8")),
		),
		ledger = validateSpendLedger(
			JSON.parse(readFileSync(requireDefined(pairs["--ledger"]), "utf8")),
			{ requireSeal: false },
		).entries;
	const context = {
		root: requireDefined(pairs["--root"]),
		policy,
		ledger,
		now: new Date().toISOString(),
	};
	if (mode === "init") {
		const bound = verifyBoundFreeze(requireDefined(pairs["--bound-root"]), {
			repositoryPath: requireDefined(pairs["--repository"]),
		});
		initializeWorkExecution({
			...context,
			authority: deriveWorkAuthority(bound),
			deadline: requireDefined(pairs["--deadline"]),
			candidateSha: requireDefined(pairs["--candidate"]),
			registrationSha256: requireDefined(pairs["--registration"]),
			nativeProducerSha256: nativeSendPathProducerSha256(),
			probeProducerSha256: linuxProbeProducerSha256(),
			setupReceiptPath: requireDefined(pairs["--setup-receipt"]),
		});
	}
	if (mode === "start")
		return startWorkCell({
			...context,
			nodeId: requireDefined(pairs["--node"]),
			...workClock(),
		});
	if (mode === "grade") {
		const result = gradePendingWorkCell({
			...context,
			nodeId: requireDefined(pairs["--node"]),
		});
		writeWorkJson(
			context.root,
			`work/${pairs["--node"]}/work-grade.json`,
			result,
		);
		return result;
	}
	if (mode === "finish")
		finishWorkCell({
			...context,
			nodeId: requireDefined(pairs["--node"]),
			...workClock(),
			finishedClock: () => ({
				now: new Date().toISOString(),
				...workClock(),
			}),
		});
	if (mode === "seal") {
		sealPendingWorkCell({
			...context,
			nodeId: requireDefined(pairs["--node"]),
		});
		return { sealed: requireDefined(pairs["--node"]) };
	}
	const progress = readWorkExecution({
		...context,
		now: new Date().toISOString(),
	});
	if (mode === "finalize") {
		const result = createWorkFinal({
			...context,
			now: new Date().toISOString(),
		});
		writeWorkJson(context.root, "closeout/work-final.json", result);
		return result;
	}
	return {
		schema: "g6-c32-work-next/1",
		node: progress.nextNode,
		argv: progress.nextNode
			? workCellArguments(
					progress.nextNode,
					requireDefined(
						progress.policy.workProfiles[progress.nextNode.profile],
					),
				)
			: [],
		terminal: progress.terminal,
		controlCutoffAt: progress.controlCutoffAt,
	};
}
if (import.meta.main) {
	try {
		console.log(JSON.stringify(await runWorkCli(process.argv.slice(2))));
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
