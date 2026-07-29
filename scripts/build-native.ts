#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type ReleaseToolchainPolicy = { rust?: unknown };

const root = resolve(import.meta.dir, "..");
const policyPath = resolve(root, ".github", "release-toolchain.json");
const policy = JSON.parse(
	readFileSync(policyPath, "utf8"),
) as ReleaseToolchainPolicy;
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (
	!Array.isArray(policy.rust) ||
	policy.rust.length !== 1 ||
	typeof policy.rust[0] !== "string" ||
	!exactVersion.test(policy.rust[0])
) {
	throw new Error(
		`${policyPath} must declare exactly one exact Rust release toolchain`,
	);
}

const rustToolchain = policy.rust[0];
const rustupProbe = Bun.spawnSync(
	["rustup", "run", rustToolchain, "cargo", "--version"],
	{
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	},
);

if (!rustupProbe.success) {
	const stderr = rustupProbe.stderr.toString().trim();
	throw new Error(
		`Rust ${rustToolchain} is required by ${policyPath}. Install it with rustup.${stderr ? ` ${stderr}` : ""}`,
	);
}

const napiCliDir = resolve(root, "node_modules", "@napi-rs", "cli");
const napiCliPackage = JSON.parse(
	readFileSync(resolve(napiCliDir, "package.json"), "utf8"),
) as { bin?: Record<string, string> };
const napiCliBin = napiCliPackage.bin?.napi;
if (typeof napiCliBin !== "string") {
	throw new Error(
		`${napiCliDir} must provide the pinned @napi-rs/cli napi binary. Run bun install.`,
	);
}

const child = Bun.spawn(
	[
		"rustup",
		"run",
		rustToolchain,
		"bun",
		resolve(napiCliDir, napiCliBin),
		"build",
		"--cwd",
		"crates/native",
		"--platform",
		"--release",
	],
	{
		cwd: root,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	},
);

const exitCode = await child.exited;
if (exitCode !== 0) process.exit(exitCode);
