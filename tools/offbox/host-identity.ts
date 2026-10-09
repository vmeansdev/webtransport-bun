export function canonicalGeneratorIdentity(hostname: string): string {
	const normalized = hostname.trim().replace(/\.+$/, "");
	if (normalized.length === 0) {
		throw new Error("generator identity must be nonempty");
	}
	const short = normalized.split(".")[0] ?? "";
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})$/.test(short)) {
		throw new Error(`generator identity '${hostname}' is not a valid hostname`);
	}
	return short;
}
