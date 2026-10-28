/** Owned ephemeral-socket measurement proof; no fixed-port killing or remote I/O. */
import {
	__TESTING__,
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { G6_V3_ACK_REFLECTOR_RULE } from "./g6-ack-reflector-rule.ts";
import { readNativeSendPath } from "./g6-native-send-path.ts";

async function bounded<T>(
	work: Promise<T>,
	label: string,
	ms = 3_000,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(Error(`${label} deadline exceeded`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function main(): Promise<void> {
	const enabled = process.env.WEBTRANSPORT_NATIVE_SEND_PATH_DIAGNOSTICS === "1";
	const server = createServer({
		host: "127.0.0.1",
		port: 0,
		tls: { certPem: "", keyPem: "" },
		onSession: () => {},
	});
	let client: Awaited<ReturnType<typeof connect>> | undefined;
	let incoming: AsyncIterator<Uint8Array> | undefined;
	try {
		let invalidPhaseThrew = false;
		try {
			server.__sendPathDiagnostics!("invalid");
		} catch {
			invalidPhaseThrew = true;
		}
		if (!invalidPhaseThrew)
			throw Error(
				"native invalid phase returned an error value instead of throwing",
			);
		__TESTING__
			.serverInternals(server)
			.setDatagramReflector(G6_V3_ACK_REFLECTOR_RULE);
		await readNativeSendPath(server.__sendPathDiagnostics, "connect", enabled);
		client = await bounded(
			connect(`https://127.0.0.1:${server.address.port}`, {
				tls: { insecureSkipVerify: true },
			}),
			"connect",
			6_000,
		);
		incoming = client.incomingDatagrams()[Symbol.asyncIterator]();
		let sequence = 0;
		for (const phase of ["connect", "steady", "drain", "idle"] as const) {
			await readNativeSendPath(server.__sendPathDiagnostics, phase, enabled);
			if (phase === "idle") continue;
			for (let i = 0; i < 3; i++) {
				const bytes = new Uint8Array(64),
					view = new DataView(bytes.buffer);
				view.setUint16(0, 0x4c54, true);
				view.setUint16(2, 3, true);
				view.setBigUint64(12, 123n, true);
				view.setBigUint64(20, BigInt(sequence++), true);
				bytes[44] = 1;
				await bounded(client.sendDatagram(bytes), "send");
				const reply = await bounded(incoming.next(), "reflect reply");
				if (reply.done || reply.value.length !== 48 || reply.value[44] !== 2)
					throw Error("invalid reflector reply");
			}
		}
	} finally {
		if (incoming?.return) await bounded(incoming.return(), "iterator close");
		client?.close();
		await bounded(server.close(), "server close", 5_000);
	}
	const snapshot = await readNativeSendPath(
		server.__sendPathDiagnostics,
		"closed",
		enabled,
	);
	process.stdout.write(
		`${JSON.stringify({ schema: "g6-native-send-path-smoke/1", platform: process.platform, snapshot })}\n`,
		(error) => {
			if (error) process.exit(1);
			else process.exit(0);
		},
	);
}
if (import.meta.main)
	main().catch((error) => {
		console.error(String(error));
		process.exit(1);
	});
