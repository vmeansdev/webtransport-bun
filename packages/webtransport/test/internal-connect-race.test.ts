import { describe, expect, it } from "bun:test";
import {
	__TESTING__,
	E_HANDSHAKE_TIMEOUT,
	WebTransportError,
} from "../src/index.js";

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
			await __TESTING__.connectWithNativeForTests(
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

		const session = await __TESTING__.connectWithNativeForTests(
			fakeNative,
			"https://127.0.0.1:1",
			"{}",
			25,
			false,
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
				__TESTING__.connectWithNativeForTests(
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
});
