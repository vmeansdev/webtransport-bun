/**
 * The directory verifier's signing-leaf flags: the same pair
 * `verify-campaign-index` takes, read through the one
 * `readSigningLeafPairFlags`, split off the argv before the staged-trust
 * parse that would otherwise refuse them as unknown.
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSigningLeafPairFlags } from "../output-policy.ts";
import { splitSigningLeafFlags } from "./verify-artifact.ts";

function leafFile(name: string, bytes: Uint8Array): string {
	const dir = mkdtempSync(join(tmpdir(), "verify-artifact-leaves-"));
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
}

describe("verify-artifact signing-leaf flags", () => {
	it("splits the pair off the argv and forwards everything else untouched", () => {
		const split = splitSigningLeafFlags([
			"--candidate",
			"cand",
			"--mac-public-key=/tmp/mac.pub",
			"--campaign-id",
			"camp",
			"--rig-public-key=/tmp/rig.pub",
			"/evidence/dir",
		]);
		expect(split.forwarded).toEqual([
			"--candidate",
			"cand",
			"--campaign-id",
			"camp",
			"/evidence/dir",
		]);
		expect(split.macPublicKeyPath).toBe("/tmp/mac.pub");
		expect(split.rigPublicKeyPath).toBe("/tmp/rig.pub");
		expect(splitSigningLeafFlags(["--fixture-only"])).toEqual({
			forwarded: ["--fixture-only"],
		});
	});

	it("reads both leaves as raw 32-byte keys, and none when neither is given", () => {
		const mac = new Uint8Array(32).fill(7);
		const rig = new Uint8Array(32).fill(9);
		const read = readSigningLeafPairFlags({
			macPublicKeyPath: leafFile("mac-supervisor-ed25519.pub", mac),
			rigPublicKeyPath: leafFile("rig-supervisor-ed25519.pub", rig),
		});
		if (!read.ok) throw new Error(read.message);
		expect(read.value?.stagedMacPublicRaw32).toEqual(mac);
		expect(read.value?.stagedRigPublicRaw32).toEqual(rig);
		expect(readSigningLeafPairFlags({})).toEqual({ ok: true, value: null });
	});

	it("refuses half a pair, a missing file, a directory and a short key by name", () => {
		const mac = leafFile("mac.pub", new Uint8Array(32).fill(7));
		const half = readSigningLeafPairFlags({ macPublicKeyPath: mac });
		expect(half).toMatchObject({ ok: false, code: "TRUST_PROTOCOL" });
		if (!half.ok) expect(half.message).toContain("must be supplied together");

		const missing = readSigningLeafPairFlags({
			macPublicKeyPath: mac,
			rigPublicKeyPath: join(tmpdir(), "no-such-leaf.pub"),
		});
		if (missing.ok) throw new Error("a missing leaf read");
		expect(missing.message).toContain(
			"--rig-public-key does not name a readable regular file",
		);

		const dir = mkdtempSync(join(tmpdir(), "verify-artifact-dir-"));
		mkdirSync(join(dir, "leaf"));
		const directory = readSigningLeafPairFlags({
			macPublicKeyPath: join(dir, "leaf"),
			rigPublicKeyPath: mac,
		});
		if (directory.ok) throw new Error("a directory read as a leaf");
		expect(directory.message).toContain(
			"--mac-public-key does not name a readable regular file",
		);

		const short = readSigningLeafPairFlags({
			macPublicKeyPath: mac,
			rigPublicKeyPath: leafFile("rig.pub", new Uint8Array(31).fill(9)),
		});
		if (short.ok) throw new Error("a 31-byte leaf read");
		expect(short.message).toBe(
			"--rig-public-key must be a raw 32-byte Ed25519 public key, got 31 bytes",
		);
	});
});
