/**
 * The wtransport driver datagram read path ("pump" | "legacy") is a campaign
 * arm knob for both roles. These checks refuse a run whose generator report
 * does not prove the configured path actually carried its traffic.
 */
/** Every per-process mmo-client report line (merged line excluded when re-tagged ones exist). */
export function clientReportsForDriverCheck(
	lines: readonly string[],
): unknown[] {
	const tagged = lines.filter((line) => /^mmo-client\[\d+\]: json /.test(line));
	const source =
		tagged.length > 0
			? tagged
			: lines.filter((line) => line.startsWith("mmo-client: json "));
	return source.map((line) =>
		JSON.parse(line.slice(line.indexOf("json ") + 5)),
	);
}

/** Refuses a generator report whose effective datagram driver differs from the arm. */
export function assertGeneratorDatagramDriver(
	report: unknown,
	expected: "pump" | "legacy",
): void {
	const driver = (report as { datagramDriver?: unknown } | null)
		?.datagramDriver as { mode?: unknown; pumpsSpawned?: unknown } | undefined;
	if (!driver || typeof driver !== "object")
		throw new Error("g6-sharded-scan: generator report lacks datagramDriver");
	const spawned = driver.pumpsSpawned;
	if (
		driver.mode !== expected ||
		typeof spawned !== "number" ||
		!Number.isSafeInteger(spawned)
	)
		throw new Error(
			`g6-sharded-scan: generator datagramDriver ${JSON.stringify(driver)} != ${expected}`,
		);
	if (expected === "pump" ? spawned < 1 : spawned !== 0)
		throw new Error(
			`g6-sharded-scan: generator pumpsSpawned ${spawned} contradicts ${expected}`,
		);
}
