/** Source-frozen command and receipt catalog; no evaluator or gate dependencies. */
export const G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA =
	"g6-capacity-execution-receipt/1";

export type LocalReceiptKind =
	| "candidate-local-native"
	| "candidate-local-linux"
	| "harness-lifecycle"
	| "bounded-overload";

// This executable catalog is part of the source freeze, not supplied by a receipt.
export const CAPACITY_NATIVE_PROOF_TESTS = [
	"datagram_reflector::tests::shared_peer_hints_coalesce_and_cancellation_is_not_connection_owned",
	...[
		"repeated_pending_polls_keep_one_owned_registration_and_drop_cancels_it",
		"independent_waiters_cancel_and_rebind_without_retained_storage",
		"drain_between_full_check_and_registration_is_rechecked_with_and_without_refill",
		"drain_wakes_outside_the_registry_lock",
		"partial_batch_eagain_resume_never_resends_the_accepted_prefix",
		"gso_fallback_retains_each_segment_and_metadata_until_accepted",
		"count_and_byte_credits_cover_pending_storage_and_release_on_drop",
		"quinn_poll_before_send_blocks_full_ring_before_any_peer_hint_is_inspected",
		"shutdown_while_fallback_waits_joins_and_releases_only_after_terminal_error",
		"receive_waker_removal_drops_outside_lock_on_ready_and_terminal_race",
		"batch_zero_runtime_returns_the_stock_quinn_socket_and_poller",
		"accepted_hard_failure_is_sticky_on_the_socket",
	].map((name) => `udp_send_batch::tests::${name}`),
];
export const CAPACITY_LINUX_PROOF_TESTS = [
	"direct_control_messages_preserve_ipv4_ecn_and_source_pktinfo",
	"direct_control_messages_preserve_ipv6_ecn_and_source_pktinfo",
	"linux_encoder_preserves_gso_size_ecn_and_source_values",
	"linux_sendmmsg_and_segmented_fallback_reach_loopback_without_duplication",
	"linux_writable_wait_checks_shutdown_and_bounds_false_ready_retries",
	"linux_hard_fallback_error_is_not_converted_to_success",
].map((name) => `udp_send_batch::linux::tests::${name}`);

/** Inspect actual cargo output; command exit and a declared count are not proof. */
export function assertNativeProofOutput(
	output: string,
	linux: boolean,
): { passed: number; failed: number } {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip only ANSI SGR escapes from retained cargo output.
	const text = output.replace(/\x1b\[[0-9;]*m/g, "");
	const summaries = [
		...text.matchAll(
			/test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;/g,
		),
	];
	let passed = 0;
	for (const summary of summaries) {
		passed += Number(summary[2]);
		if (
			summary[1] !== "ok" ||
			summary.slice(3).some((count) => Number(count) !== 0)
		)
			throw Error(
				"required native coverage failed, was ignored, measured, or filtered away",
			);
	}
	if (!Number.isSafeInteger(passed) || passed < 1)
		throw Error("missing passing native test summary");
	const names = new Set(
		[...text.matchAll(/^test ([a-zA-Z0-9_:]+) \.\.\. ok\s*$/gm)].map(
			(match) => match[1],
		),
	);
	for (const name of [
		...CAPACITY_NATIVE_PROOF_TESTS,
		...(linux ? CAPACITY_LINUX_PROOF_TESTS : []),
	])
		if (!names.has(name))
			throw Error(`required native test did not execute: ${name}`);
	return { passed, failed: 0 };
}
export const CAPACITY_HARNESS_PROOF_FILES = [
	"tools/load/g6-c32-work-plan.test.ts",
	"tools/load/g6-c32-capacity-work.test.ts",
	"tools/load/g6-c32-work-profile.test.ts",
	"tools/load/g6-c32-work-execution.test.ts",
	"tools/load/g6-c32-work-grade.test.ts",
	"tools/load/g6-c32-work-remote.test.ts",
	"tools/load/g6-c32-work-timeout.test.ts",
	"tools/load/g6-c32-execution-clock.test.ts",
	"tools/load/g6-c32-budget.test.ts",
	"tools/load/g6-c32-budget-cli.test.ts",
	"tools/load/g6-c32-rca-controller.test.ts",
	"tools/load/g6-c32-rig.test.ts",
	"tools/load/g6-c32-rig-production.test.ts",
	"tools/load/g6-c32-digitalocean.test.ts",
	"tools/load/g6-c32-terminal-evidence.test.ts",
	"tools/load/g6-c32-work-settlement.test.ts",
	"tools/load/g6-c32-prepared-command.test.ts",
	"tools/load/g6-c32-prepared-proof.test.ts",
	"tools/load/g6-c32-linux-work-process-proof.test.ts",
	"tools/load/g6-linux-probe-proof.test.ts",
	"tools/load/g6-c32-send-path-evaluate.test.ts",
	"tools/load/g6-c32-operation.test.ts",
	"tools/load/g6-c32-system-clock.test.ts",
	"tools/load/g6-c32-cell-admission.test.ts",
	"tools/load/g6-c32-freeze.test.ts",
	"tools/load/g6-c32-gates.test.ts",
	"tools/load/g6-capacity-goal-evaluate.test.ts",
	"tools/load/g6-capacity-goal-adapters.test.ts",
	"tools/load/g6-capacity-diagnostic-coverage.test.ts",
	"tools/load/g6-capacity-raw-cell.test.ts",
	"tools/load/g6-capacity-work-authority.test.ts",
	"tools/load/g6-capacity-host-review.test.ts",
] as const;
export function capacityLocalProofArgv(
	kind: LocalReceiptKind,
): readonly [readonly string[], readonly string[], readonly string[]] {
	const suite = kind.startsWith("candidate-local-")
		? [
				"cargo",
				"test",
				"-p",
				"native",
				...(kind === "candidate-local-linux" ? ["--release"] : []),
				"--locked",
				"--features",
				"webtransport_test_seams",
				"--",
				"--test-threads=1",
			]
		: [
				"bun",
				"test",
				...(kind === "harness-lifecycle"
					? CAPACITY_HARNESS_PROOF_FILES
					: ["tools/load/g6-capacity-overload.test.ts"]),
			];
	return [suite, ["uname", "-s"], ["git", "rev-parse", "HEAD"]];
}

export type LocalReceiptCommand = Readonly<{
	argv: readonly string[];
	exitCode: number;
	passed?: number;
	failed?: number;
	skipped?: number;
	todo?: number;
	durationMs?: number;
	stdoutPath?: string;
	stderrPath?: string;
	stdoutSha256?: string;
	stderrSha256?: string;
	signal?: string | null;
}>;

export type CapacityExecutionReceipt = Readonly<{
	schema: typeof G6_CAPACITY_EXECUTION_RECEIPT_SCHEMA;
	kind: LocalReceiptKind;
	sourceSha: string;
	phase: string;
	commands: readonly LocalReceiptCommand[];
	liveEvidence: boolean;
	note: string;
	executionSessionId?: string;
	platform?: string;
	linuxCoverage?: string;
}>;
