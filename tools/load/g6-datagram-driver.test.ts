import { describe, expect, test } from "bun:test";
import {
	assertGeneratorDatagramDriver,
	clientReportsForDriverCheck,
} from "./g6-datagram-driver.ts";

const report = (driver: unknown) => ({
	schema: "mmo-client/2",
	datagramDriver: driver,
});

describe("generator datagram driver echo", () => {
	test("accepts the configured mode with consistent pump counts", () => {
		assertGeneratorDatagramDriver(
			report({ mode: "pump", pumpsSpawned: 40000, pumpsLive: 0 }),
			"pump",
		);
		assertGeneratorDatagramDriver(
			report({ mode: "legacy", pumpsSpawned: 0, pumpsLive: 0 }),
			"legacy",
		);
	});

	test("refuses a missing, mislabeled or contradictory driver report", () => {
		expect(() =>
			assertGeneratorDatagramDriver(report(undefined), "pump"),
		).toThrow("lacks datagramDriver");
		expect(() =>
			assertGeneratorDatagramDriver({ schema: "mmo-client/2" }, "legacy"),
		).toThrow("lacks datagramDriver");
		expect(() =>
			assertGeneratorDatagramDriver(
				report({ mode: "legacy", pumpsSpawned: 0 }),
				"pump",
			),
		).toThrow("!= pump");
		expect(() =>
			assertGeneratorDatagramDriver(
				report({ mode: "pump", pumpsSpawned: 0 }),
				"pump",
			),
		).toThrow("contradicts pump");
		expect(() =>
			assertGeneratorDatagramDriver(
				report({ mode: "legacy", pumpsSpawned: 3 }),
				"legacy",
			),
		).toThrow("contradicts legacy");
		expect(() =>
			assertGeneratorDatagramDriver(
				report({ mode: "pump", pumpsSpawned: "9" }),
				"pump",
			),
		).toThrow("!= pump");
		expect(() =>
			assertGeneratorDatagramDriver(
				report({ mode: "pump", pumpsSpawned: 1.5 }),
				"pump",
			),
		).toThrow("!= pump");
	});

	test("checks every per-process report, not only the merged line", () => {
		const one = JSON.stringify(report({ mode: "pump", pumpsSpawned: 2 }));
		const two = JSON.stringify(report({ mode: "legacy", pumpsSpawned: 0 }));
		const merged = JSON.stringify({ schema: "mmo-client/2" });
		const reports = clientReportsForDriverCheck([
			`mmo-client: json ${merged}`,
			`mmo-client[0]: json ${one}`,
			"noise",
			`mmo-client[1]: json ${two}`,
		]);
		expect(reports).toHaveLength(2);
		expect(() => {
			for (const r of reports) assertGeneratorDatagramDriver(r, "pump");
		}).toThrow("!= pump");
		expect(
			clientReportsForDriverCheck(["x", `mmo-client: json ${one}`]),
		).toHaveLength(1);
	});
});
