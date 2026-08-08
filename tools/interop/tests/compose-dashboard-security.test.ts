import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const server = readFileSync(
	resolve(root, "examples/compose-collab/server.ts"),
	"utf8",
);
const compose = readFileSync(
	resolve(root, "examples/compose-collab/docker-compose.yml"),
	"utf8",
);

describe("compose dashboard exposure", () => {
	it("binds direct-run HTTP to loopback and publishes Docker HTTP on loopback", () => {
		expect(server).toContain('process.env.HTTP_HOST ?? "127.0.0.1"');
		expect(compose).toContain('"127.0.0.1:8080:8080/tcp"');
		expect(compose).not.toContain('"8080:8080/tcp"');
	});
});
