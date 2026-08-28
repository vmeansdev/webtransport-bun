import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const runbook = readFileSync(
	join(import.meta.dir, "../../docs/research/DO_DROPLET_RUNBOOK.md"),
	"utf8",
);

describe("DigitalOcean G6 runbook execution contexts", () => {
	test("persists every value needed for local evidence recovery", () => {
		for (const name of [
			"BUN_BIN",
			"CANDIDATE_SHA",
			"RUNG_LIST",
			"SSH_ADMIN_USER",
			"SERVER_PUBLIC_IPV4",
			"SERVER_PRIVATE_IPV4",
			"GENERATOR_PUBLIC_IPV4",
			"GENERATOR_PRIVATE_IPV4",
			"SERVER_HOST_EVIDENCE_DIR",
			"GENERATOR_HOST_EVIDENCE_DIR",
		]) {
			expect(runbook).toContain(`printf 'export ${name}=%q\\n'`);
		}
	});

	test("names the operator, server, and generator control contexts", () => {
		expect(runbook).toContain("The local operator is the sole orchestrator.");
		expect(runbook).toContain("persistent server conductor shell");
		expect(runbook).toContain("generator qualification shell");
		expect(runbook).toContain("Return to the local operator shell");
	});

	test("does not truncate the server lock file", () => {
		expect(runbook).toContain("exec 9>>/tmp/bench.lock");
		expect(runbook).not.toContain("exec 9>/tmp/bench.lock");
	});

	test("copies raw evidence, grades locally, and only then seals", () => {
		const copy = runbook.indexOf("capture_local_cmd copy-server-evidence");
		const grade = runbook.indexOf("capture_local_cmd g6-sharded-grade");
		const seal = runbook.indexOf("xargs -0 sha256sum >SHA256SUMS");
		expect(copy).toBeGreaterThan(0);
		expect(grade).toBeGreaterThan(copy);
		expect(seal).toBeGreaterThan(grade);
		expect(runbook).not.toContain(
			'test -s "$EVIDENCE_DIR/hosts/server/g6-sharded-grade-licensed.json"',
		);
		expect(runbook).toContain(
			'--out "$EVIDENCE_DIR/g6-sharded-grade-licensed.json"',
		);
	});
});
