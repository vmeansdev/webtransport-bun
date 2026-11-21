import { describe, expect, it } from "bun:test";
import { createSocket } from "node:dgram";
import { normalizeBindHost } from "../src/bind-host.js";
import {
	connect,
	createServer,
	E_INVALID_ARGUMENT,
	WebTransportError,
} from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const CONNECT_OPTS = {
	tls: { insecureSkipVerify: true, serverName: "bind-host.test" },
	limits: { handshakeTimeoutMs: 3000 },
};

async function hasIpv6Loopback(): Promise<boolean> {
	const socket = createSocket("udp6");
	try {
		return await new Promise<boolean>((resolve) => {
			socket.once("error", () => resolve(false));
			socket.bind(0, "::1", () => resolve(true));
		});
	} finally {
		socket.close();
	}
}

const ipv6 = await hasIpv6Loopback();

async function reaches(url: string): Promise<boolean> {
	try {
		const session = await connect(url, CONNECT_OPTS);
		session.close();
		await session.closed;
		return true;
	} catch {
		return false;
	}
}

describe("normalizeBindHost", () => {
	it("accepts IP literals and strips IPv6 brackets", () => {
		expect(normalizeBindHost("0.0.0.0")).toEqual({ host: "0.0.0.0" });
		expect(normalizeBindHost("127.0.0.1")).toEqual({ host: "127.0.0.1" });
		expect(normalizeBindHost("::")).toEqual({ host: "::" });
		expect(normalizeBindHost("[::1]")).toEqual({ host: "::1" });
	});

	it("rejects hostnames, malformed literals and non-strings", () => {
		for (const bad of ["localhost", "example.com", "", "[::1", "1.2.3.4:5"]) {
			expect("error" in normalizeBindHost(bad)).toBe(true);
		}
		expect("error" in normalizeBindHost(4433)).toBe(true);
	});
});

describe("createServer host", () => {
	it("throws E_INVALID_ARGUMENT for a hostname instead of binding every interface", () => {
		let caught: unknown;
		try {
			createServer({
				host: "localhost",
				port: nextPort(25820, 1000),
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(WebTransportError);
		expect((caught as WebTransportError).code).toBe(E_INVALID_ARGUMENT);
		expect((caught as Error).message).toContain('"localhost"');
	});

	it("binds a loopback literal only to that address", async () => {
		const port = nextPort(25820, 1000);
		const server = createServer({
			host: "127.0.0.1",
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(server.address).toEqual({ host: "127.0.0.1", port });
			expect(await reaches(`https://127.0.0.1:${port}`)).toBe(true);
		} finally {
			await server.close();
		}
	});

	it.skipIf(!ipv6)(
		'"::" accepts IPv4 and IPv6 clients, so localhost works whichever family resolves first',
		async () => {
			const port = nextPort(25820, 1000);
			const server = createServer({
				host: "[::]",
				port,
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			});
			try {
				expect(server.address).toEqual({ host: "::", port });
				expect(await reaches(`https://127.0.0.1:${port}`)).toBe(true);
				expect(await reaches(`https://[::1]:${port}`)).toBe(true);
				expect(await reaches(`https://localhost:${port}`)).toBe(true);
			} finally {
				await server.close();
			}
		},
	);
});
