export const G6_REGISTERED_OFFBOX_BRANCH = "probe/g6-mmo-closeout-04";

export function assertRegisteredG6CloneBranch(branch: string): string {
	if (branch !== G6_REGISTERED_OFFBOX_BRANCH) {
		throw new Error(
			`g6-offbox: refusing unsafe mac generator branch '${branch}'; expected ${G6_REGISTERED_OFFBOX_BRANCH}`,
		);
	}
	return branch;
}

export function g6MacgenCloneCommand(options: {
	cloneName: string;
	branch?: string;
}): string {
	const branch = assertRegisteredG6CloneBranch(
		options.branch ?? G6_REGISTERED_OFFBOX_BRANCH,
	);
	return `"$HOME/.bun/bin/bun" --version >/dev/null 2>&1 || true; CLONE=$HOME/${options.cloneName}; if [ ! -d "$CLONE/.git" ]; then if mkdir "$CLONE.lock" 2>/dev/null; then if [ ! -d "$CLONE/.git" ]; then git clone --quiet --branch ${branch} "https://github.com/vmeansdev/webtransport-bun.git" "$CLONE" 2>&1 || true; fi; rmdir "$CLONE.lock" 2>/dev/null || true; fi; fi; [ -d "$CLONE/.git" ] || { echo "macgen: $CLONE not provisioned" >&2; exit 3; }`;
}
