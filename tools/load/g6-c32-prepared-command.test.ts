import { expect, test } from "bun:test";
import type { HostBindingHost } from "./g6-c32-freeze-model.ts";
import { strictSshArgs } from "./g6-c32-host.ts";
import {
	preparedCheckoutFromBoundHosts,
	preparedGateSshArgs,
} from "./g6-c32-prepared-command.ts";
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

function hostsFixture(checkout = "/opt/g6/run/proof-run-attempt-1/source"): {
	server: Pick<HostBindingHost, "binary">;
	generator: Pick<HostBindingHost, "binary">;
} {
	return {
		server: {
			binary: {
				kind: "native-addon",
				path: `${checkout}/crates/native/webtransport-native.linux-x64-gnu.node`,
				sha256: "a".repeat(64),
			},
		},
		generator: {
			binary: {
				kind: "mmo-client",
				path: `${checkout}/target/release/mmo-client`,
				sha256: "b".repeat(64),
			},
		},
	};
}

test.each([
	"/opt/g6/run/proof-run-attempt-1/source",
	"/root/webtransport-bun",
	"/owned/source tree/quote'value",
])("prepared checkout derives only from both frozen binary paths under %s", (checkout) => {
	expect(preparedCheckoutFromBoundHosts(hostsFixture(checkout))).toBe(checkout);
});

test.each([
	"server root",
	"generator root",
	"server suffix",
	"generator suffix",
	"server kind",
	"generator kind",
	"root-only checkout",
])("prepared checkout rejects mismatched %s", (change) => {
	const hosts = hostsFixture();
	if (change === "server root")
		hosts.server.binary.path = hosts.server.binary.path.replace(
			"attempt-1",
			"attempt-2",
		);
	if (change === "generator root")
		hosts.generator.binary.path = hosts.generator.binary.path.replace(
			"attempt-1",
			"attempt-2",
		);
	if (change === "server suffix") hosts.server.binary.path += ".backup";
	if (change === "generator suffix") hosts.generator.binary.path += ".backup";
	if (change === "server kind") hosts.server.binary.kind = "mmo-client";
	if (change === "generator kind") hosts.generator.binary.kind = "native-addon";
	if (change === "root-only checkout") {
		hosts.server.binary.path =
			"/crates/native/webtransport-native.linux-x64-gnu.node";
		hosts.generator.binary.path = "/target/release/mmo-client";
	}
	expect(() => preparedCheckoutFromBoundHosts(hosts)).toThrow(
		/prepared checkout/,
	);
});

const malformedCheckoutPaths = [
	"",
	"relative/source",
	"/",
	"//opt/source",
	"/opt//source",
	"/opt/./source",
	"/opt/other/../source",
	"/opt/source/",
	"/opt/source\\other",
	"/opt/source\0other",
	"/opt/source\nother",
	"/opt/source\rother",
	"/opt/source\tother",
	`/opt/source${String.fromCharCode(0x7f)}other`,
	`/opt/source${String.fromCharCode(0x85)}other`,
];

test.each(
	malformedCheckoutPaths,
)("prepared checkout rejects noncanonical binary root %j", (checkout) => {
	expect(() => preparedCheckoutFromBoundHosts(hostsFixture(checkout))).toThrow(
		/prepared checkout/,
	);
});

test.each(
	malformedCheckoutPaths,
)("prepared gate rejects noncanonical cwd %j", (remoteCwd) => {
	expect(() =>
		preparedGateSshArgs({
			command: "uname",
			args: ["-s"],
			remoteCwd,
			publicIpv4: "203.0.113.10",
			knownHostsPath: "/owned/known_hosts",
		}),
	).toThrow();
});
