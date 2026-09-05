import { strictSshArgs } from "./g6-c32-host.ts";
import { shellQuote } from "./g6-c32-work-remote.ts";

/** Shared by prepared-host execution and raw-receipt verification. */
export function preparedGateSshArgs(input: {
	command: string;
	args: readonly string[];
	remoteCwd: string;
	publicIpv4: string;
	knownHostsPath: string;
}): string[] {
	const executables: Record<string, string> = {
		cargo: "/root/.cargo/bin/cargo",
		bun: "/opt/g6/bin/bun",
		git: "/usr/bin/git",
		uname: "/usr/bin/uname",
		bash: "/bin/bash",
	};
	const executable = executables[input.command];
	if (!executable || !input.remoteCwd.startsWith("/"))
		throw Error("unsupported prepared gate executable or working directory");
	const command = [executable, ...input.args].map(shellQuote).join(" ");
	return strictSshArgs(input.knownHostsPath, input.publicIpv4, [
		"bash",
		"-lc",
		shellQuote(
			`set -euo pipefail; export PATH=/root/.cargo/bin:/opt/g6/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd ${shellQuote(input.remoteCwd)}; printf 'g6-prepared-boot-id=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)" >&2; exec ${command}`,
		),
	]);
}
