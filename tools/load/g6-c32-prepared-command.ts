import { posix } from "node:path";
import type { HostBindingHost } from "./g6-c32-freeze-model.ts";
import { strictSshArgs } from "./g6-c32-host.ts";
import { shellQuote } from "./g6-c32-work-remote.ts";

function canonicalAbsolutePosixPath(value: string, label: string): string {
	if (
		typeof value !== "string" ||
		!posix.isAbsolute(value) ||
		value === "/" ||
		value.includes("\\") ||
		/\p{Cc}/u.test(value) ||
		value.endsWith("/") ||
		posix.normalize(value) !== value
	)
		throw Error(
			`g6-c32-prepared-command: ${label} must be a canonical absolute POSIX path`,
		);
	return value;
}

/** The caller must independently verify these frozen BOUND binary identities. */
export function preparedCheckoutFromBoundHosts(hosts: {
	server: Pick<HostBindingHost, "binary">;
	generator: Pick<HostBindingHost, "binary">;
}): string {
	const nativeSuffix = "/crates/native/webtransport-native.linux-x64-gnu.node";
	const generatorSuffix = "/target/release/mmo-client";
	if (
		hosts.server.binary.kind !== "native-addon" ||
		hosts.generator.binary.kind !== "mmo-client"
	)
		throw Error(
			"g6-c32-prepared-command: prepared checkout binary kinds differ from their roles",
		);
	const nativePath = canonicalAbsolutePosixPath(
		hosts.server.binary.path,
		"prepared checkout native binary",
	);
	const generatorPath = canonicalAbsolutePosixPath(
		hosts.generator.binary.path,
		"prepared checkout generator binary",
	);
	if (
		!nativePath.endsWith(nativeSuffix) ||
		!generatorPath.endsWith(generatorSuffix)
	)
		throw Error(
			"g6-c32-prepared-command: prepared checkout binary suffix mismatch",
		);
	const nativeCheckout = canonicalAbsolutePosixPath(
		nativePath.slice(0, -nativeSuffix.length),
		"prepared checkout native root",
	);
	const generatorCheckout = canonicalAbsolutePosixPath(
		generatorPath.slice(0, -generatorSuffix.length),
		"prepared checkout generator root",
	);
	if (nativeCheckout !== generatorCheckout)
		throw Error(
			"g6-c32-prepared-command: prepared checkout binary roots differ",
		);
	return nativeCheckout;
}

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
	if (!executable)
		throw Error("unsupported prepared gate executable or working directory");
	const remoteCwd = canonicalAbsolutePosixPath(
		input.remoteCwd,
		"prepared gate working directory",
	);
	const command = [executable, ...input.args].map(shellQuote).join(" ");
	return strictSshArgs(input.knownHostsPath, input.publicIpv4, [
		"bash",
		"-lc",
		shellQuote(
			`set -euo pipefail; export PATH=/root/.cargo/bin:/opt/g6/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd ${shellQuote(remoteCwd)}; printf 'g6-prepared-boot-id=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)" >&2; exec ${command}`,
		),
	]);
}
