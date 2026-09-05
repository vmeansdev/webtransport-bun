import { expect, test } from "bun:test";
import { strictSshArgs } from "./g6-c32-host.ts";
import { preparedGateSshArgs } from "./g6-c32-prepared-command.ts";
import { shellQuote } from "./g6-c32-work-remote.ts";

test("prepared Linux gate binds the pinned executable PATH and exact quoted argument boundaries", () => {
	const args = preparedGateSshArgs({
		command: "cargo",
		args: ["test", "", "space value", "quote'value"],
		remoteCwd: "/root/webtransport-bun",
		publicIpv4: "203.0.113.10",
		knownHostsPath: "/owned/known_hosts",
	});
	expect(args).toEqual(
		strictSshArgs("/owned/known_hosts", "203.0.113.10", [
			"bash",
			"-lc",
			shellQuote(
				`set -euo pipefail; export PATH=/root/.cargo/bin:/opt/g6/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd '/root/webtransport-bun'; printf 'g6-prepared-boot-id=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)" >&2; exec '/root/.cargo/bin/cargo' 'test' '' 'space value' 'quote'\\''value'`,
			),
		]),
	);
	expect(
		preparedGateSshArgs({
			command: "bun",
			args: ["test"],
			remoteCwd: "/root/webtransport-bun",
			publicIpv4: "203.0.113.10",
			knownHostsPath: "/owned/known_hosts",
		}).join(" "),
	).toContain("/opt/g6/bin/bun");
	expect(() =>
		preparedGateSshArgs({
			command: "unknown",
			args: [],
			remoteCwd: "/root/webtransport-bun",
			publicIpv4: "203.0.113.10",
			knownHostsPath: "/owned/known_hosts",
		}),
	).toThrow();
});

test("prepared native gate records actual boot identity before the command", () => {
	const args = preparedGateSshArgs({
		command: "uname",
		args: ["-s"],
		remoteCwd: "/root/webtransport-bun",
		publicIpv4: "203.0.113.10",
		knownHostsPath: "/owned/known_hosts",
	});
	expect(args.at(-1)).toContain("g6-prepared-boot-id=%s");
	expect(args.at(-1)).toContain("/proc/sys/kernel/random/boot_id");
});
