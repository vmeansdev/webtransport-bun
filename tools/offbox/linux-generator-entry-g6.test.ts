import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENTRYPOINT = join(import.meta.dir, "linux-generator-entry-g6.sh");
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function run(command: string[], cwd: string) {
	const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe" });
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "g6-linux-entry-"));
	roots.push(root);
	const clone = join(root, "clone");
	const fakeBin = join(root, "bin");
	mkdirSync(join(clone, "tools", "offbox"), { recursive: true });
	mkdirSync(join(clone, "target", "release"), { recursive: true });
	mkdirSync(fakeBin);
	writeFileSync(join(clone, "tracked.txt"), "candidate\n");
	writeFileSync(join(clone, ".gitignore"), "target/\n");
	expect(run(["git", "init", "-q"], clone).exitCode).toBe(0);
	expect(run(["git", "add", "tracked.txt", ".gitignore"], clone).exitCode).toBe(0);
	expect(
		run(
			[
				"git",
				"-c",
				"user.name=G6 Test",
				"-c",
				"user.email=g6@example.invalid",
				"commit",
				"-qm",
				"candidate",
			],
			clone,
		).exitCode,
	).toBe(0);
	const candidate = run(["git", "rev-parse", "HEAD"], clone).stdout.trim();

	const cargo = join(fakeBin, "cargo");
	writeFileSync(
		cargo,
		`#!/bin/bash\nset -eu\nprintf '#!/bin/bash\\necho freshly-built\\n' > target/release/mmo-client\nchmod +x target/release/mmo-client\n`,
	);
	chmodSync(cargo, 0o755);
	const rustc = join(fakeBin, "rustc");
	writeFileSync(rustc, "#!/bin/bash\necho 'rustc 1.90.0'\n");
	chmodSync(rustc, 0o755);

	return { root, clone, fakeBin, candidate };
}

function invoke(input: ReturnType<typeof fixture>) {
	return run(
		[
			"env",
			`WT_LINUXGEN_CLONE=${input.clone}`,
			`WT_LINUXGEN_PATH=${input.fakeBin}:/usr/bin:/bin`,
			"bash",
			ENTRYPOINT,
			"--candidate",
			input.candidate,
			"--bin",
			"mmo-client",
			"--deadline",
			"5",
			"--",
		],
		input.root,
	);
}

describe("linux G6 generator entrypoint provenance", () => {
	test("always rebuilds the binary after candidate checkout", () => {
		const input = fixture();
		const binary = join(input.clone, "target", "release", "mmo-client");
		writeFileSync(binary, "#!/bin/bash\necho stale-binary\n");
		chmodSync(binary, 0o755);

		const result = invoke(input);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("freshly-built");
		expect(result.stdout).not.toContain("stale-binary");
	});

	test("rejects untracked inputs before building", () => {
		const input = fixture();
		mkdirSync(join(input.clone, ".cargo"));
		writeFileSync(join(input.clone, ".cargo", "config.toml"), "[build]\nrustflags=[]\n");

		const result = invoke(input);

		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("is dirty");
		expect(result.stdout).not.toContain("freshly-built");
	});
});
