/** Scripts for the frozen exact pair only. Merely constructing them performs no I/O. */
export type WorkProcessOwner = {
	runId: string;
	nodeId: string;
	role: "server" | "generator";
	remoteRoot: string;
	bootId: string;
};
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function ownerPath(owner: WorkProcessOwner): string {
	if (
		![owner.runId, owner.nodeId].every((value) =>
			/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value),
		) ||
		!/^\/[a-zA-Z0-9_./-]+$/.test(owner.remoteRoot) ||
		owner.remoteRoot.split("/").includes("..") ||
		!/^[a-f0-9-]{36}$/.test(owner.bootId) ||
		!["server", "generator"].includes(owner.role)
	)
		throw Error("invalid exact work process owner");
	return `${owner.remoteRoot}/cells/work-${owner.nodeId}/${owner.role === "server" ? "scan" : "generator"}-owner.json`;
}
/** Optional only for legacy scans; a work scan has one complete, canonical owner. */
export function readGeneratorWorkOwner(
	environment: Record<string, string | undefined>,
	clientProcesses: number,
): WorkProcessOwner | null {
	const keys = [
		"G6_OFFBOX_WORK_RUN_ID",
		"G6_OFFBOX_WORK_NODE_ID",
		"G6_OFFBOX_WORK_ROOT",
		"G6_OFFBOX_WORK_BOOT_ID",
	] as const;
	const values = keys.map((key) => environment[key]);
	if (values.every((value) => value === undefined)) return null;
	const [runId, nodeId, remoteRoot, bootId] = values;
	if (!runId || !nodeId || !remoteRoot || !bootId || clientProcesses !== 1)
		throw Error(
			"work generator requires complete authority and exactly one client process",
		);
	const owner: WorkProcessOwner = {
		runId,
		nodeId,
		role: "generator",
		remoteRoot,
		bootId,
	};
	ownerPath(owner);
	if (
		owner.remoteRoot !==
		`/root/webtransport-bun/.scratch/bare-metal-campaign/runs/${owner.runId}`
	)
		throw Error("work generator root differs from canonical run ownership");
	return owner;
}

export function workGeneratorSshArguments(
	owner: WorkProcessOwner | null,
	argv: readonly string[],
): string[] {
	if (owner === null) return [...argv];
	if (owner.role !== "generator" || argv.length === 0)
		throw Error("invalid owned generator launch");
	return [ownedWorkProcessCommand(owner, argv.map(shellQuote).join(" "))];
}
export function ownedWorkProcessCommand(
	owner: WorkProcessOwner,
	command: string,
): string {
	const path = ownerPath(owner);
	const script = `set -eu
[ "$(cat /proc/sys/kernel/random/boot_id)" = ${shellQuote(owner.bootId)} ]
pid=$$
group=$(awk '{print $5}' /proc/$$/stat)
ticks=$(awk '{print $22}' /proc/$$/stat)
[ "$pid" = "$group" ]
set -C
printf '{"schema":"g6-c32-work-process-owner/1","runId":"${owner.runId}","nodeId":"${owner.nodeId}","role":"${owner.role}","pid":%s,"processGroupId":%s,"startTicks":"%s","bootId":"${owner.bootId}"}\\n' "$pid" "$group" "$ticks" >${shellQuote(path)}
set +C
${command}`;
	return `setsid --wait bash -c ${shellQuote(script)}`;
}
export function cleanupWorkProcessCommand(owner: WorkProcessOwner): string {
	const path = ownerPath(owner);
	return `set -eu
[ "$(cat /proc/sys/kernel/random/boot_id)" = ${shellQuote(owner.bootId)} ] || exit 91
[ -f ${shellQuote(path)} ] || exit 0
jq -e ${shellQuote(`.schema == "g6-c32-work-process-owner/1" and .runId == "${owner.runId}" and .nodeId == "${owner.nodeId}" and .role == "${owner.role}" and .bootId == "${owner.bootId}" and .pid == .processGroupId and (.pid | type == "number") and (.startTicks | type == "string")`)} ${shellQuote(path)} >/dev/null || exit 91
pid=$(jq -r .pid ${shellQuote(path)})
ticks=$(jq -r .startTicks ${shellQuote(path)})
case "$pid:$ticks" in *[!0-9:]*|:*) exit 91;; esac
[ "$pid" -gt 1 ] || exit 91
if [ ! -r /proc/$pid/stat ]; then
 kill -0 -- -"$pid" 2>/dev/null && exit 91
 exit 0
fi
[ "$(awk '{print $22}' /proc/$pid/stat)" = "$ticks" ] || exit 91
[ "$(awk '{print $5}' /proc/$pid/stat)" = "$pid" ] || exit 91
kill -TERM -- -"$pid" 2>/dev/null || true
sleep 0.2
if kill -0 -- -"$pid" 2>/dev/null; then
 if [ -r /proc/$pid/stat ]; then [ "$(awk '{print $22}' /proc/$pid/stat)" = "$ticks" ] || exit 91; fi
 kill -KILL -- -"$pid" 2>/dev/null || true
fi
attempt=0
while kill -0 -- -"$pid" 2>/dev/null; do
 attempt=$((attempt + 1))
 [ "$attempt" -lt 20 ] || exit 92
 sleep 0.1
done`;
}
