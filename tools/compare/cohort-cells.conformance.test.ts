/**
 * Physical-budget amendment D3, "One source, every mirror".
 *
 * The six fanout cells are stated once, as the D3 table of
 * `docs/superpowers/plans/2026-09-08-physical-budget-amendment.md`, and
 * copied by hand into a dozen places that deliberately do not import each
 * other: the cardinality and grant-parameter tables, the expanded-declaration
 * table, the evidence label map, the scenario registry, the executor
 * defaults, the controller's readiness switch and gate list, the frozen run
 * fragments, the stage timeouts, and the Rust `COHORT_CELLS` table. This
 * suite parses the table out of the amendment's own bytes and walks every
 * mirror against it, so a row cannot move in one copy without this going red.
 *
 * D3's own rule retires a row whose D4 preflight reading exceeds the bound
 * "without a new review of this amendment", so the amendment's bytes stay as
 * approved and each retirement is recorded as a deviation note under
 * `docs/superpowers/plans/deviations/` carrying an `action | cell id | ...`
 * table. This suite applies those rows -- retire, add -- to the parsed D3
 * table before walking the mirrors, so the amendment stays the source and the
 * deviation is the recorded delta.
 *
 * The retired ids are asserted unknown everywhere: refused by every lookup,
 * absent from every mirror's source text, never aliased.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	CONTROLLER_USAGE,
	PHASE4_GATE_CELLS,
	cohortReadinessDeadlineMs,
	rolePlanPreimageFor,
} from "./bin/compare-controller.ts";
import { SCENARIO_EXECUTORS } from "./client.ts";
import {
	COHORT_CELL_CARDINALITIES,
	COHORT_CELL_GRANT_PARAMETERS,
	cohortCellCardinality,
	cohortCellGrantParameters,
	READINESS_DEADLINE_MS_VALUES,
	WARMUP_INTERVAL_MS,
	WARMUP_MESSAGES_PER_PUBLISHER,
} from "./cohort-protocol.ts";
import { FANOUT_EXPANDED_DECLARATION_BY_CELL_ID } from "./cross-supervisor-protocol.ts";
import {
	FANOUT_COHORT_CELL_BY_ID,
	FANOUT_COHORT_CELL_IDS,
} from "./evidence.ts";
import { CANONICAL_MEASURED_REPETITIONS } from "./output-policy.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const AMENDMENT_PATH = join(
	REPO_ROOT,
	"docs/superpowers/plans/2026-09-08-physical-budget-amendment.md",
);
const DEVIATIONS_DIR = join(REPO_ROOT, "docs/superpowers/plans/deviations");

function read(relative: string): string {
	return readFileSync(join(REPO_ROOT, relative), "utf8");
}

/** `NAME=value` as a frozen run fragment states it. */
function assignment(fragment: string, name: string): string {
	const match = new RegExp(`^${name}=(.*)$`, "m").exec(fragment);
	if (match === null) throw new Error(`${name} is not assigned`);
	return match[1]!;
}

interface D3Row {
	readonly cellId: string;
	readonly label: string;
	readonly publisherCount: number;
	readonly workerCount: number;
	readonly subscriberCount: number;
	readonly sessionCount: number;
	readonly windowSeconds: number;
	readonly measuredIngress: number;
	readonly expandedDeliveries: number;
	readonly deliveriesPerSecond: number;
	readonly warmupDeliveriesPerSecond: number;
	readonly messageBytes: number;
	readonly readinessDeadlineMs: number;
}

function integer(text: string): number {
	const value = Number(text.replace(/[,_]/g, "").trim());
	if (!Number.isSafeInteger(value)) throw new Error(`not an integer: ${text}`);
	return value;
}

/** The D3 table, from the amendment's bytes: six rows between D3 and D4. */
function parseD3Table(markdown: string): D3Row[] {
	const start = markdown.indexOf("## D3.");
	const end = markdown.indexOf("## D4.", start);
	if (start < 0 || end < 0) throw new Error("D3 section not found");
	const rows = markdown
		.slice(start, end)
		.split("\n")
		.filter((line) => line.startsWith("| `"))
		.map((line) => {
			const cells = line
				.split("|")
				.slice(1, -1)
				.map((cell) => cell.trim());
			const window = /^(\d+) s$/.exec(cells[6] ?? "");
			const rate = /^([\d,]+) \(warmup ([\d,]+)\)$/.exec(cells[9] ?? "");
			if (window === null || rate === null) {
				throw new Error(`unparseable D3 row: ${line}`);
			}
			return {
				cellId: (cells[0] ?? "").replace(/`/g, ""),
				label: cells[1] ?? "",
				publisherCount: integer(cells[2] ?? ""),
				workerCount: integer(cells[3] ?? ""),
				subscriberCount: integer(cells[4] ?? ""),
				sessionCount: integer(cells[5] ?? ""),
				windowSeconds: integer(window[1] ?? ""),
				measuredIngress: integer(cells[7] ?? ""),
				expandedDeliveries: integer(cells[8] ?? ""),
				deliveriesPerSecond: integer(rate[1] ?? ""),
				warmupDeliveriesPerSecond: integer(rate[2] ?? ""),
				messageBytes: integer(cells[10] ?? ""),
				readinessDeadlineMs: integer(cells[11] ?? ""),
			};
		});
	if (rows.length !== 6)
		throw new Error(`expected 6 D3 rows, got ${rows.length}`);
	return rows;
}

type DeviationRow =
	| {
			readonly action: "retire";
			readonly cellId: string;
			readonly label: string;
	  }
	| { readonly action: "add"; readonly row: D3Row };

const DEVIATION_TABLE_HEADER =
	"| action | cell id | label | pub | workers | subs | sessions | window | ingress | deliveries | bytes | readinessDeadlineMs |";

/**
 * The `action | cell id | ...` rows of one deviation note. A `retire` row
 * names only the id and label; an `add` row carries the same columns as D3
 * minus the model columns, and its deliveries-per-second and warmup rate are
 * derived the way D3's own rows are checked below.
 */
function parseDeviationTable(markdown: string): DeviationRow[] {
	const lines = markdown.split("\n");
	const header = lines.indexOf(DEVIATION_TABLE_HEADER);
	if (header < 0) return [];
	const rows: DeviationRow[] = [];
	for (const line of lines.slice(header + 2)) {
		if (!line.startsWith("|")) break;
		const cells = line
			.split("|")
			.slice(1, -1)
			.map((cell) => cell.trim());
		const action = cells[0] ?? "";
		const cellId = (cells[1] ?? "").replace(/`/g, "");
		const label = cells[2] ?? "";
		if (action === "retire") {
			rows.push({ action, cellId, label });
			continue;
		}
		if (action !== "add") throw new Error(`unknown deviation action: ${line}`);
		const window = /^(\d+) s$/.exec(cells[7] ?? "");
		if (window === null) throw new Error(`unparseable deviation row: ${line}`);
		const publisherCount = integer(cells[3] ?? "");
		const subscriberCount = integer(cells[5] ?? "");
		const windowSeconds = integer(window[1] ?? "");
		const expandedDeliveries = integer(cells[9] ?? "");
		rows.push({
			action,
			row: {
				cellId,
				label,
				publisherCount,
				workerCount: integer(cells[4] ?? ""),
				subscriberCount,
				sessionCount: integer(cells[6] ?? ""),
				windowSeconds,
				measuredIngress: integer(cells[8] ?? ""),
				expandedDeliveries,
				deliveriesPerSecond: expandedDeliveries / windowSeconds,
				warmupDeliveriesPerSecond:
					((WARMUP_MESSAGES_PER_PUBLISHER * publisherCount) /
						((WARMUP_MESSAGES_PER_PUBLISHER * WARMUP_INTERVAL_MS) / 1_000)) *
					subscriberCount,
				messageBytes: integer(cells[10] ?? ""),
				readinessDeadlineMs: integer(cells[11] ?? ""),
			},
		});
	}
	return rows;
}

/** Every recorded deviation, oldest first: the notes are dated by name. */
const DEVIATION_ROWS: readonly DeviationRow[] = readdirSync(DEVIATIONS_DIR)
	.filter((name) => name.endsWith(".md"))
	.sort()
	.flatMap((name) =>
		parseDeviationTable(readFileSync(join(DEVIATIONS_DIR, name), "utf8")),
	);

function family(cellId: string): string {
	return cellId.slice(0, cellId.indexOf("/"));
}

/**
 * D3's rule, applied: a retired row leaves the table and an added row joins
 * its ladder, each ladder sorted by load so "the next row down becomes the
 * top" is a fact of the order and not of where the note put the row. The
 * families keep D3's own order.
 */
function applyDeviations(
	table: readonly D3Row[],
	deviations: readonly DeviationRow[],
): D3Row[] {
	let rows = [...table];
	for (const deviation of deviations) {
		if (deviation.action === "retire") {
			const index = rows.findIndex((row) => row.cellId === deviation.cellId);
			if (index < 0)
				throw new Error(`retire names no row: ${deviation.cellId}`);
			if (rows[index]!.label !== deviation.label)
				throw new Error(`retire mislabels ${deviation.cellId}`);
			rows.splice(index, 1);
		} else {
			if (rows.some((row) => row.cellId === deviation.row.cellId))
				throw new Error(`add duplicates ${deviation.row.cellId}`);
			rows.push(deviation.row);
		}
	}
	const families = [...new Set(table.map((row) => family(row.cellId)))];
	rows = families.flatMap((name) =>
		rows
			.filter((row) => family(row.cellId) === name)
			.sort((a, b) => a.expandedDeliveries - b.expandedDeliveries),
	);
	return rows;
}

const AMENDMENT = readFileSync(AMENDMENT_PATH, "utf8");
const D3_ROWS = parseD3Table(AMENDMENT);
const ROWS = applyDeviations(D3_ROWS, DEVIATION_ROWS);
const TICKER_ROWS = ROWS.filter((row) =>
	row.cellId.startsWith("ticker-fanout/"),
);
const CHAT_ROWS = ROWS.filter((row) => row.cellId.startsWith("chat-fanout/"));
const CELL_IDS = ROWS.map((row) => row.cellId);

/**
 * D3: "Retired ids, refused everywhere and never aliased". The amendment's
 * own retirements are written out in full because it abbreviates them in
 * prose; every `retire` row of a deviation note joins them.
 */
const RETIRED_BY_AMENDMENT = [
	["ticker-fanout/rate-10000", "ticker 10k"],
	["ticker-fanout/rate-50000", "ticker 50k"],
	["ticker-fanout/rate-100000", "ticker 100k"],
	["chat-fanout/subscribers-5000", "chat 5k"],
	["chat-fanout/subscribers-10000", "chat 10k"],
] as const;
const RETIRED_BY_DEVIATION = DEVIATION_ROWS.flatMap((row) =>
	row.action === "retire" ? [[row.cellId, row.label] as const] : [],
);
const RETIRED_CELL_IDS: readonly string[] = [
	...RETIRED_BY_AMENDMENT.map(([cellId]) => cellId),
	...RETIRED_BY_DEVIATION.map(([cellId]) => cellId),
];
const RETIRED_LABELS: readonly string[] = [
	...RETIRED_BY_AMENDMENT.map(([, label]) => label),
	...RETIRED_BY_DEVIATION.map(([, label]) => label),
];

/** Every file D3 names as a mirror, read as text for the retired-id sweep. */
const MIRROR_SOURCES = [
	"tools/compare/cohort-protocol.ts",
	"tools/compare/cross-supervisor-protocol.ts",
	"tools/compare/evidence.ts",
	"tools/compare/scenario-registry.ts",
	"tools/compare/types.ts",
	"tools/compare/client.ts",
	"tools/compare/r1-fixtures.ts",
	"tools/compare/bin/compare-controller.ts",
	"tools/compare/bin/render-phase4-report.ts",
	"tools/compare/bin/stage-live-campaign.ts",
	"tools/compare/bin/frozen-run-section-9.6.fragment.sh",
	"tools/compare/bin/frozen-run-section-9.7.fragment.sh",
	"crates/native/src/secure_fs.rs",
] as const;

describe("the recorded deviations", () => {
	test("the 2026-09-09 preflight note retires the top ticker row and adds a bottom one", () => {
		expect(DEVIATION_ROWS).toEqual([
			{
				action: "retire",
				cellId: "ticker-fanout/rate-250",
				label: "ticker 250",
			},
			{
				action: "add",
				row: {
					cellId: "ticker-fanout/rate-25",
					label: "ticker 25",
					publisherCount: 1,
					workerCount: 8,
					subscriberCount: 100,
					sessionCount: 101,
					windowSeconds: 10,
					measuredIngress: 250,
					expandedDeliveries: 25_000,
					deliveriesPerSecond: 2_500,
					warmupDeliveriesPerSecond: 200,
					messageBytes: 100,
					readinessDeadlineMs: 30_000,
				},
			},
		]);
	});

	test("every retired row was a D3 row, every added row is new, and the ladders keep three rungs", () => {
		for (const [cellId] of RETIRED_BY_DEVIATION) {
			expect(D3_ROWS.map((row) => row.cellId)).toContain(cellId);
			expect(CELL_IDS).not.toContain(cellId);
		}
		for (const deviation of DEVIATION_ROWS) {
			if (deviation.action !== "add") continue;
			expect(D3_ROWS.map((row) => row.cellId)).not.toContain(
				deviation.row.cellId,
			);
			expect(CELL_IDS).toContain(deviation.row.cellId);
		}
		expect(CELL_IDS).toEqual([
			"ticker-fanout/rate-25",
			"ticker-fanout/rate-50",
			"ticker-fanout/rate-100",
			"chat-fanout/subscribers-250",
			"chat-fanout/subscribers-500",
			"chat-fanout/subscribers-1000",
		]);
	});
});

describe("the D3 table itself", () => {
	test("the six rows are internally consistent and name the two families", () => {
		expect(TICKER_ROWS.length).toBe(3);
		expect(CHAT_ROWS.length).toBe(3);
		expect(new Set(CELL_IDS).size).toBe(6);
		expect(new Set(ROWS.map((row) => row.label)).size).toBe(6);
		for (const row of ROWS) {
			expect(row.workerCount).toBe(8);
			expect(row.sessionCount).toBe(row.publisherCount + row.subscriberCount);
			expect(row.expandedDeliveries).toBe(
				row.measuredIngress * row.subscriberCount,
			);
			expect(row.deliveriesPerSecond * row.windowSeconds).toBe(
				row.expandedDeliveries,
			);
			// D1: warmup offers WARMUP_MESSAGES_PER_PUBLISHER per publisher over
			// the 5 s epoch, every one of them expanded to every subscriber.
			expect(row.warmupDeliveriesPerSecond).toBe(
				((WARMUP_MESSAGES_PER_PUBLISHER * row.publisherCount) /
					((WARMUP_MESSAGES_PER_PUBLISHER * WARMUP_INTERVAL_MS) / 1_000)) *
					row.subscriberCount,
			);
		}
		for (const row of TICKER_ROWS) {
			const rate = row.measuredIngress / row.windowSeconds;
			expect(row.cellId).toBe(`ticker-fanout/rate-${rate}`);
			expect(row.label).toBe(`ticker ${rate}`);
			expect(row.publisherCount).toBe(1);
			expect(row.subscriberCount).toBe(100);
			expect(row.windowSeconds).toBe(10);
			expect(row.messageBytes).toBe(100);
		}
		for (const row of CHAT_ROWS) {
			expect(row.cellId).toBe(`chat-fanout/subscribers-${row.subscriberCount}`);
			expect(row.label).toBe(
				`chat ${row.subscriberCount === 1_000 ? "1k" : row.subscriberCount}`,
			);
			expect(row.publisherCount).toBe(10);
			expect(row.measuredIngress).toBe(300);
			expect(row.windowSeconds).toBe(30);
			expect(row.messageBytes).toBe(128);
		}
		for (const retired of RETIRED_CELL_IDS)
			expect(CELL_IDS).not.toContain(retired);
	});
});

describe("cohort-protocol.ts mirrors", () => {
	test("COHORT_CELL_CARDINALITIES is the table, row for row", () => {
		expect<readonly unknown[]>(COHORT_CELL_CARDINALITIES).toEqual(
			ROWS.map((row) => ({
				cell: row.label,
				publisherCount: row.publisherCount,
				workerCount: row.workerCount,
				subscriberCount: row.subscriberCount,
				sessionCount: row.sessionCount,
				measuredIngress: row.measuredIngress,
				expandedDeliveries: row.expandedDeliveries,
			})),
		);
	});

	test("COHORT_CELL_GRANT_PARAMETERS carries each row's window and payload", () => {
		expect<readonly unknown[]>(COHORT_CELL_GRANT_PARAMETERS).toEqual(
			ROWS.map((row) => ({
				cell: row.label,
				measuredDurationMs: row.windowSeconds * 1_000,
				messageBytes: row.messageBytes,
			})),
		);
	});

	test("the readiness closed set is exactly the deadlines the rows use", () => {
		const fromRows = [
			...new Set(ROWS.map((row) => row.readinessDeadlineMs)),
		].sort((a, b) => a - b);
		expect<readonly number[]>(
			[...READINESS_DEADLINE_MS_VALUES].sort((a, b) => a - b),
		).toEqual(fromRows);
		expect(fromRows).toEqual([30_000, 90_000]);
	});

	test("retired labels are unknown to both lookups", () => {
		for (const label of RETIRED_LABELS) {
			expect(() => cohortCellCardinality(label)).toThrow(RangeError);
			expect(() => cohortCellGrantParameters(label)).toThrow(RangeError);
		}
	});
});

describe("cross-supervisor-protocol.ts mirror", () => {
	test("FANOUT_EXPANDED_DECLARATION_BY_CELL_ID declares each row's expansion", () => {
		expect(Object.keys(FANOUT_EXPANDED_DECLARATION_BY_CELL_ID)).toEqual(
			CELL_IDS,
		);
		for (const row of ROWS) {
			expect(FANOUT_EXPANDED_DECLARATION_BY_CELL_ID[row.cellId]).toEqual({
				declaredMessageCount: row.expandedDeliveries,
				declaredMessageBytes: row.messageBytes,
			});
		}
		for (const retired of RETIRED_CELL_IDS) {
			expect(FANOUT_EXPANDED_DECLARATION_BY_CELL_ID[retired]).toBeUndefined();
		}
	});
});

describe("evidence.ts mirror", () => {
	test("FANOUT_COHORT_CELL_BY_ID maps each id to its label, in table order", () => {
		expect(Object.entries(FANOUT_COHORT_CELL_BY_ID)).toEqual(
			ROWS.map((row) => [row.cellId, row.label]),
		);
		expect(FANOUT_COHORT_CELL_IDS).toEqual(CELL_IDS);
		for (const retired of RETIRED_CELL_IDS) {
			expect(FANOUT_COHORT_CELL_BY_ID[retired]).toBeUndefined();
		}
	});
});

describe("scenario-registry.ts, types.ts and client.ts mirrors", () => {
	const registryCells = CANONICAL_SCENARIO_REGISTRY.cells;

	test("the canonical ticker and chat cells are the table's, with its parameters", () => {
		const ticker = registryCells.filter(
			(cell) => cell.scenarioId === "ticker-fanout",
		);
		const chat = registryCells.filter(
			(cell) => cell.scenarioId === "chat-fanout",
		);
		expect(ticker.map((cell) => cell.cellId)).toEqual(
			TICKER_ROWS.map((row) => row.cellId),
		);
		expect(chat.map((cell) => cell.cellId)).toEqual(
			CHAT_ROWS.map((row) => row.cellId),
		);
		for (const [index, cell] of ticker.entries()) {
			const row = TICKER_ROWS[index]!;
			expect(cell.parameters).toEqual({
				scenarioId: "ticker-fanout",
				ingressRatePerSecond: row.measuredIngress / row.windowSeconds,
				publisherCount: row.publisherCount,
				subscriberCount: row.subscriberCount,
				recordBytes: row.messageBytes,
				fanout: row.subscriberCount,
				durationSeconds: row.windowSeconds,
				delivery: "reliable",
			});
		}
		for (const [index, cell] of chat.entries()) {
			const row = CHAT_ROWS[index]!;
			expect(cell.parameters).toEqual({
				scenarioId: "chat-fanout",
				subscriberCount: row.subscriberCount,
				publisherCount: row.publisherCount,
				messageBytes: row.messageBytes,
				messagesPerSecondPerPublisher:
					row.measuredIngress / row.publisherCount / row.windowSeconds,
				durationSeconds: row.windowSeconds,
				delivery: "reliable",
			});
		}
		for (const retired of RETIRED_CELL_IDS) {
			expect(
				registryCells.find((cell) => cell.cellId === retired),
			).toBeUndefined();
		}
	});

	test("the TickerParameters rate union is the table's three rates", () => {
		const rates = TICKER_ROWS.map(
			(row) => row.measuredIngress / row.windowSeconds,
		);
		expect(read("tools/compare/types.ts")).toContain(
			`readonly ingressRatePerSecond: ${rates.join(" | ")};`,
		);
	});

	test("the executor defaults name a row of the table", () => {
		const ticker = SCENARIO_EXECUTORS.get("ticker-fanout");
		const chat = SCENARIO_EXECUTORS.get("chat-fanout");
		if (ticker === undefined || chat === undefined)
			throw new Error("executors");
		const tickerDefaults = ticker.parameters as {
			ingressRatePerSecond: number;
			durationSeconds: number;
		};
		const tickerRow = TICKER_ROWS.find(
			(row) =>
				row.measuredIngress / row.windowSeconds ===
				tickerDefaults.ingressRatePerSecond,
		);
		expect(tickerRow).toBeDefined();
		expect(tickerDefaults.durationSeconds).toBe(tickerRow!.windowSeconds);
		expect(ticker.legPlan()).toEqual({
			kind: "comparable",
			plan: {
				deliveryKind: "reliable-message",
				messageCount: tickerRow!.measuredIngress,
				messageBytes: tickerRow!.messageBytes,
			},
		});
		const chatDefaults = chat.parameters as { subscriberCount: number };
		expect(CHAT_ROWS.map((row) => row.subscriberCount)).toContain(
			chatDefaults.subscriberCount,
		);
	});
});

describe("bin/compare-controller.ts mirrors", () => {
	test("cohortReadinessDeadlineMs answers each label with its row and refuses the retired ones", () => {
		for (const row of ROWS) {
			expect(cohortReadinessDeadlineMs(row.label)).toBe(
				row.readinessDeadlineMs,
			);
		}
		for (const label of RETIRED_LABELS) {
			expect(() => cohortReadinessDeadlineMs(label)).toThrow(RangeError);
		}
	});

	test("the canonical role plan paces each publisher at the row's rate", () => {
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			const row = ROWS.find((candidate) => candidate.cellId === cell.cellId);
			if (row === undefined) continue;
			for (const transport of ["ws", "wt"] as const) {
				const preimage = rolePlanPreimageFor(cell, transport);
				expect(preimage.serverRole).toBe("fanout-relay");
				expect(preimage.publisherCount).toBe(row.publisherCount);
				expect(preimage.subscriberWorkerCount).toBe(row.workerCount);
				expect(preimage.subscriberCount).toBe(row.subscriberCount);
				expect(preimage.publisherRatePerSecond).toBe(
					row.measuredIngress / row.publisherCount / row.windowSeconds,
				);
				expect(preimage.payloadBytes).toBe(row.messageBytes);
				expect(preimage.measuredDurationMs).toBe(row.windowSeconds * 1_000);
			}
		}
	});

	test("the phase-4 gate cell and the help text name a row of the table", () => {
		const fanoutGateCells = PHASE4_GATE_CELLS.filter(
			(cellId) => cellId !== "bulk-one-way/physical",
		);
		expect(fanoutGateCells.length).toBe(1);
		const gateCell = fanoutGateCells[0]!;
		expect(CELL_IDS).toContain(gateCell);
		expect(CONTROLLER_USAGE).toContain(`--phase4 selects ${gateCell}`);
	});
});

describe("bin/render-phase4-report.ts mirror", () => {
	test("the default cell list names only registered cells", () => {
		const source = read("tools/compare/bin/render-phase4-report.ts");
		const match = /process\.argv\[4\] \?\? "([^"]+)"/.exec(source);
		if (match === null) throw new Error("no default cell list");
		for (const cellId of match[1]!.split(",")) {
			expect([...CELL_IDS, "bulk-one-way/physical"]).toContain(cellId);
		}
	});
});

describe("frozen run fragments and stage timeouts (D5)", () => {
	const fragment96 = read(
		"tools/compare/bin/frozen-run-section-9.6.fragment.sh",
	);
	const fragment97 = read(
		"tools/compare/bin/frozen-run-section-9.7.fragment.sh",
	);
	const stage = read("tools/compare/bin/stage-live-campaign.ts");

	/** The `CAMPAIGN_TIMEOUT_MS` / `RUN_TIMEOUT_MS` pair the D5 bullet pins. */
	function pinnedTimeouts(bullet: "B5" | "B6"): {
		campaignTimeoutMs: number;
		runTimeoutMs: number;
	} {
		const line = AMENDMENT.split("\n").find((candidate) =>
			candidate.startsWith(`- **${bullet}**`),
		);
		if (line === undefined) throw new Error(`D5 has no ${bullet} bullet`);
		const match =
			/`CAMPAIGN_TIMEOUT_MS=([\d,]+)`, `RUN_TIMEOUT_MS=([\d,]+)`/.exec(line);
		if (match === null) throw new Error(`${bullet} pins no timeouts`);
		return {
			campaignTimeoutMs: integer(match[1]!),
			runTimeoutMs: integer(match[2]!),
		};
	}

	function underscored(value: number): string {
		return value.toLocaleString("en-US").replace(/,/g, "_");
	}

	test("9.6 runs the B5 pilot cell the amendment names, or the top of its ladder once that row is retired", () => {
		const pilot = /\*\*B5\*\* pilot cell becomes `([^`]+)`/.exec(AMENDMENT);
		if (pilot === null) throw new Error("D5 names no pilot cell");
		const named = pilot[1]!;
		expect(D3_ROWS.map((row) => row.cellId)).toContain(named);
		// D3: "the next row down becomes the top of its ladder" -- the pilot
		// follows the top row, which is the last of its family in table order.
		const ladder = ROWS.filter((row) => family(row.cellId) === family(named));
		const pilotCell = RETIRED_CELL_IDS.includes(named)
			? ladder[ladder.length - 1]!.cellId
			: named;
		expect(CELL_IDS).toContain(pilotCell);
		expect<readonly string[]>(PHASE4_GATE_CELLS).toContain(pilotCell);
		expect(assignment(fragment96, "CELLS")).toBe(pilotCell);
		expect(assignment(fragment96, "REPS")).toBe("1");
		const pinned = pinnedTimeouts("B5");
		expect(pinned.campaignTimeoutMs).toBe(1_800_000);
		expect(pinned.runTimeoutMs).toBe(pinned.campaignTimeoutMs + 300_000);
		expect(assignment(fragment96, "CAMPAIGN_TIMEOUT_MS")).toBe(
			String(pinned.campaignTimeoutMs),
		);
		expect(stage).toContain(
			`return { section: "9.6", timeoutMs: ${underscored(pinned.runTimeoutMs)} };`,
		);
	});

	test("9.7 runs the six cells with the pinned timeouts", () => {
		expect(assignment(fragment97, "CELLS")).toBe(CELL_IDS.join(","));
		const reps = Number(assignment(fragment97, "REPS"));
		expect(reps).toBe(5);
		const measuredArms = ROWS.length * 2 * reps;
		expect(assignment(fragment97, "EXPECTED_PASS")).toBe(String(measuredArms));
		expect(assignment(fragment97, "EXPECTED_PROMOTABLE")).toBe(
			String(measuredArms),
		);
		expect(assignment(fragment97, "EXPECTED_SEALED")).toBe(
			String(measuredArms),
		);
		expect(assignment(fragment97, "EXPECTED_FLATS")).toBe(
			String(ROWS.length * 2),
		);
		expect(assignment(fragment97, "EXPECTED_PAIRED_PROMOTIONS")).toBe(
			String(ROWS.length),
		);
		const pinned = pinnedTimeouts("B6");
		expect(pinned.campaignTimeoutMs).toBe(14_400_000);
		expect(pinned.runTimeoutMs).toBe(pinned.campaignTimeoutMs + 1_800_000);
		expect(assignment(fragment97, "CAMPAIGN_TIMEOUT_MS")).toBe(
			String(pinned.campaignTimeoutMs),
		);
		expect(stage).toContain(
			`return { section: "9.7", timeoutMs: ${underscored(pinned.runTimeoutMs)} };`,
		);
	});
});

describe("crates/native/src/secure_fs.rs mirror", () => {
	test("COHORT_CELLS is the table, row for row", () => {
		const source = read("crates/native/src/secure_fs.rs");
		const start = source.indexOf("pub const COHORT_CELLS: &[CohortCell] = &[");
		const end = source.indexOf("];", start);
		if (start < 0 || end < 0) throw new Error("COHORT_CELLS not found");
		const block = source.slice(start, end);
		const rustRows = [...block.matchAll(/CohortCell \{([^}]*)\}/g)].map(
			(match) => {
				const fields: Record<string, string> = {};
				for (const line of match[1]!.split("\n")) {
					const field = /^\s*(\w+): (.+),$/.exec(line);
					if (field !== null) fields[field[1]!] = field[2]!;
				}
				return fields;
			},
		);
		expect(rustRows.map((fields) => fields.cell_id)).toEqual(
			CELL_IDS.map((cellId) => `"${cellId}"`),
		);
		for (const [index, fields] of rustRows.entries()) {
			const row = ROWS[index]!;
			expect(fields.cell).toBe(`"${row.label}"`);
			expect(integer(fields.publisher_count!)).toBe(row.publisherCount);
			expect(fields.worker_count).toBe("SUBSCRIBER_SHARD_MODULUS");
			expect(integer(fields.subscriber_count!)).toBe(row.subscriberCount);
			expect(integer(fields.session_count!)).toBe(row.sessionCount);
			expect(integer(fields.measured_ingress!)).toBe(row.measuredIngress);
			expect(integer(fields.expanded_deliveries!)).toBe(row.expandedDeliveries);
			expect(integer(fields.measured_duration_ms!)).toBe(
				row.windowSeconds * 1_000,
			);
			expect(integer(fields.message_bytes!)).toBe(row.messageBytes);
			expect(integer(fields.readiness_deadline_ms!)).toBe(
				row.readinessDeadlineMs,
			);
		}
		expect(source).toContain("pub const SUBSCRIBER_SHARD_MODULUS: u64 = 8;");
	});

	test("the rig accepts every execution of every frozen schedule", () => {
		// The rig's replay guard is never evicted, so its bound is the bound
		// on a campaign's executions. It was `MAX_SESSIONS_PER_CAMPAIGN` (64)
		// until fanout-attested-r1's 65th execution was refused with
		// `COHORT_PROTOCOL: overflow` on 2026-09-09; it is now derived from
		// the frozen table the rig binary carries, and this pin is what keeps
		// the TS side's largest schedule inside it.
		const source = read("crates/native/src/secure_fs.rs");
		expect(source).toContain(
			"pub const WARMUP_REPETITIONS_PER_ARM: usize = 1;",
		);
		expect(source).toContain(
			`pub const CANONICAL_MEASURED_REPETITIONS: usize = ${CANONICAL_MEASURED_REPETITIONS};`,
		);
		const bound =
			/pub const MAX_ACCEPTED_EXECUTIONS_PER_CAMPAIGN: usize = super::mac::COHORT_CELLS\.len\(\)\s*\* 2\s*\* \(WARMUP_REPETITIONS_PER_ARM \+ CANONICAL_MEASURED_REPETITIONS \+ (\d+)\);/.exec(
				source,
			);
		if (bound === null) {
			throw new Error(
				"MAX_ACCEPTED_EXECUTIONS_PER_CAMPAIGN is not derived from COHORT_CELLS",
			);
		}
		const marginPerArm = Number(bound[1]);
		const rigBound =
			ROWS.length * 2 * (1 + CANONICAL_MEASURED_REPETITIONS + marginPerArm);
		expect(rigBound).toBe(84);
		expect(rigBound).toBeGreaterThan(64);
		// Every frozen schedule, as the fragments state it: cells x two wires x
		// (one warmup + REPS measured), and the section 9.7 count is the one
		// the old bound refused.
		const schedules = [
			"tools/compare/bin/frozen-run-section-9.5.fragment.sh",
			"tools/compare/bin/frozen-run-section-9.6.fragment.sh",
			"tools/compare/bin/frozen-run-section-9.7.fragment.sh",
		].map((relative) => {
			const fragment = read(relative);
			const cells = assignment(fragment, "CELLS").split(",").length;
			const reps = Number(assignment(fragment, "REPS"));
			return { relative, executions: cells * 2 * (1 + reps) };
		});
		expect(
			schedules.find((schedule) =>
				schedule.relative.endsWith("9.7.fragment.sh"),
			)?.executions,
		).toBe(72);
		for (const schedule of schedules) {
			expect(schedule.executions).toBeLessThanOrEqual(rigBound);
		}
	});
});

describe("the retired ids are gone from every mirror's source", () => {
	for (const relative of MIRROR_SOURCES) {
		test(relative, () => {
			const source = read(relative);
			for (const retired of [...RETIRED_CELL_IDS, ...RETIRED_LABELS]) {
				expect(source.includes(retired)).toBe(false);
			}
		});
	}
});
