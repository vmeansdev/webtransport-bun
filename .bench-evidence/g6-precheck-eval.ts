import { evaluatePreflight } from "/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/wf_f84f5a44-ca6-1/tools/offbox/preflight-lib.ts";
import {
	preflightRequirements,
	gateRung,
} from "/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/.claude/worktrees/wf_2c91d5a7-09c-1/tools/load/g6-plan.ts";

const dir =
	"/private/tmp/claude-501/-Users-vmeansdev-Developer-Codex-Apps-webtransport-bun/f7e8ee1a-04f7-4e2f-b074-2fe3aca95eee/scratchpad";
const runDateIso = new Date().toISOString();
const reqs = preflightRequirements();
console.log("gateRung =", gateRung(), "| runDateIso =", runDateIso);
console.log("requirements =", JSON.stringify(reqs, null, 1));

const artifacts: Record<string, string> = {
	"R-down": `${dir}/preflight-1150.json`,
	"R-up": `${dir}/preflight-64.json`,
};

let allValid = true;
for (const spec of reqs) {
	const artifact = await Bun.file(artifacts[spec.name]!).json();
	const verdict = evaluatePreflight(artifact, { ...spec, runDateIso });
	allValid &&= verdict.valid;
	console.log(`\n=== ${spec.name} (${artifacts[spec.name]}) ===`);
	console.log(
		"offeredPps required:",
		spec.offeredPps,
		"@",
		spec.payloadBytes,
		"B, loss<=",
		spec.maxLossPct,
		"%, mtu>=",
		spec.minMtuBytes,
		", rttP99<=",
		spec.maxIdleRttP99Ms,
		"ms",
	);
	console.log("VALID:", verdict.valid);
	console.log("reasons:", verdict.reasons.length ? verdict.reasons : "(none)");
	console.log("observed:", verdict.observed);
}
console.log("\n=== V-C CABLE STOP:", allValid ? "PASS" : "FAIL", "===");
