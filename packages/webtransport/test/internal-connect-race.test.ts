import { describe, expect, it } from "bun:test";
import {
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_LIMIT_EXCEEDED,
	E_SESSION_CLOSED,
	WebTransportError,
} from "../src/index.js";
import { __TESTING__ as INTERNAL_TESTING } from "../src/internal.js";

describe("internal connect race handling", () => {
	it("times out and closes late session handle from native callback", async () => {
		let closeCalls = 0;
		const fakeNative = {
			connect: (
				_url: string,
				_optsJson: string,
				_onClosed: (events: any[]) => void,
				cb: (err: any, handleId?: string) => void,
			) => {
				setTimeout(() => cb(null, "h1"), 20);
			},
			takeClientSession: (_id: string) => ({
				id: "h1",
				close: () => {
					closeCalls++;
				},
			}),
		};

		let err: unknown;
		try {
			await INTERNAL_TESTING.connectWithNativeForTests(
				fakeNative,
				"https://127.0.0.1:1",
				"{}",
				5,
			);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe(E_HANDSHAKE_TIMEOUT);

		await Bun.sleep(40);
		expect(closeCalls).toBe(1);
	});

	it("clears timeout timer on successful connect", async () => {
		let cleared = false;
		let timerFired = false;
		const fakeNative = {
			connect: (
				_url: string,
				_optsJson: string,
				_onClosed: (events: any[]) => void,
				cb: (err: any, handleId?: string) => void,
			) => {
				cb(null, "ok");
			},
			takeClientSession: (_id: string) => ({
				id: "ok",
				peerIp: "127.0.0.1",
				peerPort: 4433,
				close: () => {},
			}),
		};

		const setTimer = (cb: () => void, ms: number) => {
			const h = { cancelled: false };
			setTimeout(() => {
				if (!h.cancelled) {
					timerFired = true;
					cb();
				}
			}, ms);
			return h;
		};
		const clearTimer = (h: { cancelled: boolean }) => {
			h.cancelled = true;
			cleared = true;
		};

		const session = await INTERNAL_TESTING.connectWithNativeForTests(
			fakeNative,
			"https://127.0.0.1:1",
			"{}",
			25,
			false,
			5000,
			setTimer,
			clearTimer,
		);
		expect(session).toBeDefined();
		expect(cleared).toBe(true);

		await Bun.sleep(40);
		expect(timerFired).toBe(false);
	});

	it("logs warning when late-timeout orphan cleanup close throws", async () => {
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			const fakeNative = {
				connect: (
					_url: string,
					_optsJson: string,
					_onClosed: (events: any[]) => void,
					cb: (err: any, handleId?: string) => void,
				) => {
					setTimeout(() => cb(null, "late"), 20);
				},
				takeClientSession: (_id: string) => ({
					id: "late",
					close: () => {
						throw new Error("close-fail");
					},
				}),
			};

			await expect(
				INTERNAL_TESTING.connectWithNativeForTests(
					fakeNative,
					"https://127.0.0.1:1",
					"{}",
					5,
				),
			).rejects.toMatchObject({ code: E_HANDSHAKE_TIMEOUT });
			await Bun.sleep(40);
		} finally {
			console.warn = warn;
		}

		expect(
			seen.some((s) =>
				s.includes("late connect orphan cleanup failed: close-fail"),
			),
		).toBe(true);
	});

	// The session can close (a server at maxSessions closes it with 3992 /
	// E_LIMIT_EXCEEDED) after native connect succeeds but before JavaScript
	// takes the handle. connect() must still reject with a stable code.
	const vanishedHandleNative = (closeEvent?: {
		code: number;
		reason: string;
	}) => ({
		connect: (
			_url: string,
			_optsJson: string,
			onClosed: (events: any[]) => void,
			cb: (err: any, handleId?: string) => void,
		) => {
			if (closeEvent)
				onClosed([{ name: "session_closed", id: "gone", ...closeEvent }]);
			cb(null, "gone");
		},
		takeClientSession: (_id: string) => null,
	});

	async function connectError(fakeNative: unknown): Promise<WebTransportError> {
		try {
			await INTERNAL_TESTING.connectWithNativeForTests(
				fakeNative as any,
				"https://127.0.0.1:1",
				"{}",
				1000,
			);
		} catch (e) {
			expect(e).toBeInstanceOf(WebTransportError);
			return e as WebTransportError;
		}
		throw new Error("connect unexpectedly resolved");
	}

	it("reports a maxSessions close that beat the handle hand-off as E_LIMIT_EXCEEDED", async () => {
		const err = await connectError(
			vanishedHandleNative({ code: 3992, reason: "E_LIMIT_EXCEEDED" }),
		);
		expect(err.code).toBe(E_LIMIT_EXCEEDED);
		expect(err.message).toContain("3992");
	});

	it("reports a vanished handle with no close event as E_SESSION_CLOSED", async () => {
		const err = await connectError(vanishedHandleNative());
		expect(err.code).toBe(E_SESSION_CLOSED);
	});

	it("reports a connect callback without a handle id as E_INTERNAL", async () => {
		const err = await connectError({
			connect: (
				_url: string,
				_optsJson: string,
				_onClosed: unknown,
				cb: (err: any, handleId?: string) => void,
			) => cb(null, undefined),
			takeClientSession: () => null,
		});
		expect(err.code).toBe(E_INTERNAL);
	});
});
