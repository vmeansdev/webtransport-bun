/**
 * A native accepted-session event can sit in the TSFN batcher while
 * `server.close()` runs and be delivered after the close sweep. Such a late
 * accept must never reach `onSession`, and must not leave a `closed` promise
 * nobody will settle. The handler is driven directly through the internal seam
 * so the accept lands at a chosen point of the close sequence, deterministically.
 */

import { describe, expect, it } from "bun:test";
import {
	__TESTING__,
	createServer,
	E_SERVER_CLOSING,
	type ServerSession,
} from "../src/index.js";
import { SERVER_CLOSING_CLOSE_CODE } from "../src/server-close.js";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 27_600;
const PORT_SPREAD = 60;

function accept(id: string) {
	return { name: "session", id, peerIp: "127.0.0.1", peerPort: 40_000 };
}

function serverWithSpy() {
	const seen: ServerSession[] = [];
	const server = createServer({
		port: nextPort(BASE_PORT, PORT_SPREAD),
		tls: { certPem: "", keyPem: "" },
		onSession: (session) => {
			seen.push(session);
		},
	});
	return { server, seen, internals: __TESTING__.serverInternals(server) };
}

describe("late accepted-session events after close()", () => {
	it("an accept registered before close() is owned, and close settles its closed", async () => {
		const { server, seen, internals } = serverWithSpy();
		internals.deliverSessionEventsForTests([accept("early-1")]);
		expect(seen.length).toBe(1);
		expect(internals.ownedSessionCountForTests()).toBe(1);
		await server.close();
		expect(internals.ownedSessionCountForTests()).toBe(0);
		const info = await Promise.race([
			(seen[0] as ServerSession).closed,
			Bun.sleep(2_000).then(() => null),
		]);
		expect(info).toEqual({
			code: SERVER_CLOSING_CLOSE_CODE,
			reason: E_SERVER_CLOSING,
		});
	});

	it("an accept delivered while close() is in flight never reaches onSession", async () => {
		const { server, seen, internals } = serverWithSpy();
		const closing = server.close();
		internals.deliverSessionEventsForTests([accept("during-1")]);
		await closing;
		expect(seen).toEqual([]);
		expect(internals.ownedSessionCountForTests()).toBe(0);
	});

	it("an accept delivered after close() resolved never reaches onSession", async () => {
		const { server, seen, internals } = serverWithSpy();
		await server.close();
		internals.deliverSessionEventsForTests([
			accept("late-1"),
			accept("late-2"),
			// A close event for it, as the native side would also send, is a
			// no-op rather than a resolver lookup on a session nobody owns.
			{ name: "session_closed", id: "late-1", code: 0, reason: "" },
		]);
		expect(seen).toEqual([]);
		expect(internals.ownedSessionCountForTests()).toBe(0);
	});
});
