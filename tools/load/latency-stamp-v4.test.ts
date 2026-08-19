import { describe, expect, test } from "bun:test";
import {
	ARM_A1,
	ARM_A3,
	ARM_NONE,
	CLASS_BROADCAST,
	CLASS_PROBE_ECHO,
	CLASS_SNAPSHOT,
	decodeStamp,
	encodeStamp,
	STAMP_BYTES_V3,
	STAMP_BYTES_V4,
	writeReflection,
} from "./latency-stamp";

/**
 * G10 §6.1: version 4 adds the emitter arm and takes it out of version 3's
 * reserved field, so the stamp stays 48 bytes and the gate's 200 B payload
 * arithmetic does not move. These tests hold both halves of that sentence.
 */

describe("stamp v4 — the arm byte, additively", () => {
	test("a v4 stamp is still 48 bytes, so §1.2's payload arithmetic stands", () => {
		expect(STAMP_BYTES_V4).toBe(48);
		expect(STAMP_BYTES_V4).toBe(STAMP_BYTES_V3);
	});

	test("it round-trips the arm alongside every v3 field", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V4);
		encodeStamp(bytes, {
			intendedNs: 1_000,
			actualNs: 1_400,
			sequence: 4_242,
			echoActualNs: 9_000,
			holdNs: 250,
			klass: CLASS_BROADCAST,
			arm: ARM_A3,
			version: 4,
		});
		const s = decodeStamp(bytes);
		expect(s).not.toBeNull();
		expect(s?.version).toBe(4);
		expect(s?.sequence).toBe(4_242);
		expect(s?.holdNs).toBe(250);
		expect(s?.klass).toBe(CLASS_BROADCAST);
		expect(s?.arm).toBe(ARM_A3);
	});

	test("a v3 stamp decodes as unattributed, not as A1", () => {
		// Zero is ARM_NONE precisely so a v3 payload — whose byte 45 is reserved
		// and zero — cannot read as the first arm and quietly join its samples.
		const bytes = new Uint8Array(STAMP_BYTES_V3);
		encodeStamp(bytes, {
			intendedNs: 1,
			actualNs: 2,
			sequence: 3,
			klass: CLASS_SNAPSHOT,
			version: 3,
		});
		const s = decodeStamp(bytes);
		expect(s?.version).toBe(3);
		expect(s?.klass).toBe(CLASS_SNAPSHOT);
		expect(s?.arm).toBe(ARM_NONE);
		expect(s?.arm).not.toBe(ARM_A1);
	});

	test("v1 and v2 stamps still decode exactly as before", () => {
		const v2 = new Uint8Array(48);
		encodeStamp(v2, { intendedNs: 7, actualNs: 8, sequence: 9 });
		const s = decodeStamp(v2);
		expect(s?.version).toBe(2);
		expect(s?.holdNs).toBe(0);
		expect(s?.arm).toBe(ARM_NONE);
	});

	test("a version we do not speak is still rejected rather than guessed at", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V4);
		encodeStamp(bytes, {
			intendedNs: 1,
			actualNs: 2,
			sequence: 3,
			klass: CLASS_BROADCAST,
			arm: ARM_A1,
			version: 4,
		});
		new DataView(bytes.buffer).setUint16(2, 5, true);
		expect(decodeStamp(bytes)).toBeNull();
	});

	test("the arm byte is written zero when the writer asked for v3", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V4).fill(0xff);
		encodeStamp(bytes, {
			intendedNs: 1,
			actualNs: 2,
			sequence: 3,
			klass: CLASS_BROADCAST,
			arm: ARM_A3,
			version: 3,
		});
		expect(bytes[45]).toBe(0);
		expect(decodeStamp(bytes)?.arm).toBe(ARM_NONE);
	});

	test("reserved bytes stay zero so a future field starts from a known state", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V4).fill(0xff);
		encodeStamp(bytes, {
			intendedNs: 1,
			actualNs: 2,
			sequence: 3,
			klass: CLASS_BROADCAST,
			arm: ARM_A1,
			version: 4,
		});
		expect(bytes[46]).toBe(0);
		expect(bytes[47]).toBe(0);
	});
});

describe("the probe echo the RTT clause rides", () => {
	test("a reflection carrying an arm is a v4 stamp", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V4);
		encodeStamp(bytes, {
			intendedNs: 100,
			actualNs: 120,
			sequence: 11,
			klass: CLASS_PROBE_ECHO,
			version: 4,
		});
		expect(
			writeReflection(bytes, {
				echoActualNs: 120,
				serverSendNs: 500,
				holdNs: 380,
				klass: CLASS_PROBE_ECHO,
				sequence: 11,
				arm: ARM_A3,
			}),
		).toBe(true);
		const s = decodeStamp(bytes);
		expect(s?.version).toBe(4);
		expect(s?.echoActualNs).toBe(120);
		expect(s?.holdNs).toBe(380);
		expect(s?.arm).toBe(ARM_A3);
	});

	test("a reflection without an arm stays a v3 stamp, as G6 writes it", () => {
		const bytes = new Uint8Array(STAMP_BYTES_V3);
		encodeStamp(bytes, {
			intendedNs: 1,
			actualNs: 2,
			sequence: 3,
			klass: CLASS_SNAPSHOT,
			version: 3,
		});
		expect(
			writeReflection(bytes, {
				echoActualNs: 2,
				serverSendNs: 40,
				holdNs: 38,
				klass: CLASS_SNAPSHOT,
				sequence: 3,
			}),
		).toBe(true);
		expect(decodeStamp(bytes)?.version).toBe(3);
	});

	test("a payload too short to carry the stamp is reported, not stamped from zero", () => {
		expect(
			writeReflection(new Uint8Array(36), {
				echoActualNs: 1,
				serverSendNs: 2,
				holdNs: 1,
				klass: CLASS_PROBE_ECHO,
				sequence: 1,
				arm: ARM_A1,
			}),
		).toBe(false);
	});
});
