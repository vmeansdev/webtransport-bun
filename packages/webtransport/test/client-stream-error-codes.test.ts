import { describe, expect, it } from "bun:test";
import {
	connect,
	createServer,
	E_STREAM_RESET,
	WebTransportError,
} from "../src/index.js";
import { generateCertForNames } from "./helpers/certs.js";

// Client Node streams used to fail with plain Errors whose message began with
// the code, so `err.code` read undefined; the server's web streams and the
// open paths already carried it. A client must be able to switch on err.code.
describe("client stream errors carry their stable code", () => {
	it("a peer reset reaches the client reader as WebTransportError E_STREAM_RESET", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		if (!cert) return;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			onSession: async (session) => {
				const reader = session.incomingBidirectionalStreams.getReader();
				const next = await Promise.race([reader.read(), Bun.sleep(5000)]);
				if (!next || next.done) return;
				await next.value.writable.abort(7);
			},
		});
		try {
			const client = await connect(
				`https://127.0.0.1:${server.address.port}/`,
				{ tls: { insecureSkipVerify: true } },
			);
			const stream = await client.createBidirectionalStream();
			const failed = new Promise<unknown>((resolve) => {
				stream.on("error", resolve);
				stream.on("data", () => {});
			});
			stream.write(new Uint8Array([1]));
			const err = await Promise.race([failed, Bun.sleep(5000)]);
			expect(err).toBeInstanceOf(WebTransportError);
			expect((err as WebTransportError).code).toBe(E_STREAM_RESET);
			client.close();
		} finally {
			await server.close();
			cert.cleanup();
		}
	}, 30_000);
});
