// Minimal repro for the 24h-soak JS-heap retention: mimic the Rust
// load-client's bidi behavior (write, FIN, never read) against the
// soak-addon server handler, then count live WritableStreams.
import { heapStats } from "bun:jsc";
import {
	connect,
	createServer,
	WT_STOP_SENDING,
} from "/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun/packages/webtransport/src/index.ts";

const ROUNDS = Number(process.env.ROUNDS ?? 2000);
const PORT = 44653;

function collectReadable(
	readable: ReadableStream<Uint8Array>,
): Promise<Buffer> {
	return (async () => {
		const reader = readable.getReader();
		const chunks: Buffer[] = [];
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(Buffer.from(value));
			}
		} finally {
			reader.releaseLock();
		}
		return Buffer.concat(chunks);
	})();
}

let serverHandled = 0;
let serverCloseOk = 0;
let serverCloseErr = 0;

const server = createServer({
	port: PORT,
	tls: { certPem: "", keyPem: "" },
	onSession: async (session) => {
		void (async () => {
			try {
				for await (const datagram of session.incomingDatagrams()) {
					void datagram; // soak server consumes; load datagrams aren't echoed
				}
			} catch {}
		})();
		void (async () => {
			const reader = session.incomingBidirectionalStreams.getReader();
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) return;
					const duplex = next.value;
					void (async () => {
						try {
							const body = await collectReadable(duplex.readable);
							void body;
							serverHandled++;
							// soak-addon LOAD_BIDI path: close our send half.
							const writer = duplex.writable.getWriter();
							try {
								await writer.close();
								serverCloseOk++;
							} catch {
								serverCloseErr++;
							} finally {
								writer.releaseLock();
							}
						} catch {
							// expected teardown noise
						}
					})();
				}
			} catch {
				// session ended
			} finally {
				try {
					reader.releaseLock();
				} catch {}
			}
		})();
	},
});

const client = await connect(`https://127.0.0.1:${PORT}`, {
	tls: { insecureSkipVerify: true },
});

const payload = Buffer.from(`LOAD:bidi:${"x".repeat(64)}`);

function snapshot(label: string) {
	Bun.gc(true);
	const s = heapStats();
	const t = s.objectTypeCounts as Record<string, number>;
	console.log(
		`${label}: heapUsed=${(s.heapSize / 1048576).toFixed(1)}MB objects=${s.objectCount}`,
		`WritableStream=${t.WritableStream ?? 0}`,
		`WSController=${t.WritableStreamDefaultController ?? 0}`,
		`Promise=${t.Promise ?? 0}`,
		`PromiseReaction=${t.PromiseReaction ?? 0}`,
		`Error=${t.Error ?? 0}`,
	);
}

snapshot("baseline");

// Saturation mode: overlapping streams + continuous datagram flood, no
// per-stream await barrier — approximates the droplet's pinned event loop.
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 32);

let floodStop = false;
const flood = (async () => {
	const dg = Buffer.from(`load:datagram:${"y".repeat(48)}`);
	while (!floodStop) {
		try {
			await client.sendDatagram(dg);
		} catch {
			await Bun.sleep(5);
		}
	}
})();

async function oneStream() {
	const stream = await client.createBidirectionalStream();
	// Rust load-client drops `_recv` at open → immediate STOP_SENDING for the
	// server's send half.
	(stream as any)[WT_STOP_SENDING]?.(0);
	await new Promise<void>((res, rej) =>
		stream.write(payload, (e: Error | null | undefined) =>
			e ? rej(e) : res(),
		),
	);
	await new Promise<void>((res, rej) =>
		stream.end((e?: Error | null) => (e ? rej(e) : res())),
	);
	// Never read the receive half.
}

let launched = 0;
const workers = Array.from({ length: CONCURRENCY }, async () => {
	while (launched < ROUNDS) {
		launched++;
		try {
			await oneStream();
		} catch {
			// stream open under pressure may fail; keep pushing
		}
		if (launched % 500 === 0) {
			snapshot(
				`after ~${launched} streams (handled=${serverHandled} closeOk=${serverCloseOk} closeErr=${serverCloseErr})`,
			);
		}
	}
});
await Promise.all(workers);
floodStop = true;
await flood;

await Bun.sleep(1000);
snapshot(
	`final (handled=${serverHandled} closeOk=${serverCloseOk} closeErr=${serverCloseErr})`,
);

client.close();
await server.close();
await Bun.sleep(300);
snapshot("after close");
process.exit(0);
