import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	cleanupWorkProcessCommand,
	ownedWorkProcessCommand,
	readGeneratorWorkOwner,
	shellQuote,
	workGeneratorSshArguments,
} from "./g6-c32-work-remote.ts";

const generatorEnvironment = {
	G6_OFFBOX_WORK_RUN_ID: "run-a",
	G6_OFFBOX_WORK_NODE_ID: "A0-1",
	G6_OFFBOX_WORK_ROOT:
		"/root/webtransport-bun/.scratch/bare-metal-campaign/runs/run-a",
	G6_OFFBOX_WORK_BOOT_ID: "11111111-1111-4111-8111-111111111111",
};
test("generator ownership accepts only a complete canonical authority for 1..16 processes", () => {
	expect(readGeneratorWorkOwner({}, 1)).toBeNull();
	expect(readGeneratorWorkOwner(generatorEnvironment, 1)?.role).toBe(
		"generator",
	);
	for (const key of Object.keys(generatorEnvironment)) {
		const partial: Record<string, string> = { ...generatorEnvironment };
		delete partial[key];
		expect(() => readGeneratorWorkOwner(partial, 1)).toThrow();
	}
	for (const root of [
		"/tmp/run-a",
		`${generatorEnvironment.G6_OFFBOX_WORK_ROOT}/.`,
		generatorEnvironment.G6_OFFBOX_WORK_ROOT.replace("run-a", "run-b"),
	])
		expect(() =>
			readGeneratorWorkOwner(
				{ ...generatorEnvironment, G6_OFFBOX_WORK_ROOT: root },
				1,
			),
		).toThrow();
	// The fan-out runs 1..16 processes inside the one owned group.
	for (const clientProcesses of [2, 4, 16])
		expect(
			readGeneratorWorkOwner(generatorEnvironment, clientProcesses)?.role,
		).toBe("generator");
	for (const clientProcesses of [0, 17, 1.5, Number.NaN])
		expect(() =>
			readGeneratorWorkOwner(generatorEnvironment, clientProcesses),
		).toThrow("1..16 client processes");
});
test("owned generator launch preserves the tracked entry and every argument boundary", () => {
	const owner = readGeneratorWorkOwner(generatorEnvironment, 1);
	if (!owner) throw Error("fixture requires an owned generator");
	const args = [
		"env",
		"WT_LINUXGEN_CLONE=/root/webtransport-bun",
		"bash",
		"/root/webtransport-bun/tools/offbox/linux-generator-entry-g6.sh",
		"--",
		"",
		"space value",
		"quote'value",
		"literal$(printf wrong)",
	];
	expect(workGeneratorSshArguments(null, args)).toEqual(args);
	expect(workGeneratorSshArguments(owner, args)).toEqual([
		ownedWorkProcessCommand(owner, args.map(shellQuote).join(" ")),
	]);
	const values = args.slice(4);
	const result = execFileSync(
		"bash",
		[
			"-c",
			`${shellQuote(process.execPath)} -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- ${values.map(shellQuote).join(" ")}`,
		],
		{ encoding: "utf8", timeout: 2000 },
	);
	expect(JSON.parse(result)).toEqual(values);
	expect(workGeneratorSshArguments(owner, args)[0]).not.toContain(
		"generator-entry.sh",
	);
});
test("work process ownership is exact role/run/node/boot and uses a new owned group", () => {
	const owner = {
		runId: "run-a",
		nodeId: "A0-1",
		role: "server" as const,
		remoteRoot: "/root/g6/run-a",
		bootId: "11111111-1111-4111-8111-111111111111",
	};
	const command = ownedWorkProcessCommand(owner, "exec bun scan.ts");
	// SSH can invoke the launcher as a process-group leader. It must wait for
	// the forked owned command and preserve its exit status in that case too.
	expect(command).toStartWith("setsid --wait bash -c ");
	expect(command).toContain("g6-c32-work-process-owner/1");
	expect(command).toContain("startTicks");
	const cleanup = cleanupWorkProcessCommand(owner);
	expect(cleanup).toContain("/root/g6/run-a/cells/work-A0-1/scan-owner.json");
	expect(cleanup).toContain("processGroupId");
	expect(cleanup).not.toContain("pkill");
	expect(cleanup).toContain("kill -0 --");
	expect(cleanup).toContain("exit 92");
	expect(() =>
		cleanupWorkProcessCommand({ ...owner, nodeId: "../other" }),
	).toThrow();
});
