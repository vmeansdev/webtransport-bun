type ProvenanceInput = {
	offboxClone: string;
	entryScript: string;
	candidateSha: string;
	run: (remoteArgs: string[]) => string;
};

function assertSafeAbsolutePath(name: string, value: string): void {
	if (!value.startsWith("/") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
		throw new Error(
			`g6 off-box provenance: ${name} must be a safe absolute path`,
		);
	}
}

export function assertOffboxCandidateProvenance({
	offboxClone,
	entryScript,
	candidateSha,
	run,
}: ProvenanceInput): void {
	assertSafeAbsolutePath("G6_OFFBOX_CLONE", offboxClone);
	assertSafeAbsolutePath("G6_OFFBOX_ENTRY_SCRIPT", entryScript);
	const clonePrefix = `${offboxClone}/`;
	if (!entryScript.startsWith(clonePrefix)) {
		throw new Error(
			"g6 off-box provenance: G6_OFFBOX_ENTRY_SCRIPT must be inside G6_OFFBOX_CLONE",
		);
	}
	const entryRelative = entryScript.slice(clonePrefix.length);
	if (!entryRelative) {
		throw new Error(
			"g6 off-box provenance: entry script must name a tracked file",
		);
	}

	const dirty = run([
		"git",
		"-C",
		offboxClone,
		"status",
		"--porcelain",
		"--untracked-files=all",
	]).trim();
	if (dirty) {
		throw new Error("g6 off-box provenance: remote clone is dirty");
	}
	const head = run(["git", "-C", offboxClone, "rev-parse", "HEAD"]).trim();
	if (head !== candidateSha) {
		throw new Error(
			`g6 off-box provenance: remote candidate ${head || "missing"} != ${candidateSha}`,
		);
	}
	const tracked = run([
		"git",
		"-C",
		offboxClone,
		"ls-files",
		"--error-unmatch",
		"--",
		entryRelative,
	]).trim();
	if (tracked !== entryRelative) {
		throw new Error(
			"g6 off-box provenance: entry script is not tracked by the remote candidate",
		);
	}
	run([
		"git",
		"-C",
		offboxClone,
		"diff",
		"--quiet",
		"HEAD",
		"--",
		entryRelative,
	]);
}
