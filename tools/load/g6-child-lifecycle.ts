type ChildCloseEmitter = {
	once(event: "close", listener: () => void): unknown;
};

const closeEvents = new WeakMap<object, Promise<void>>();

export function trackChildClose<T extends ChildCloseEmitter & object>(
	child: T,
): T {
	if (!closeEvents.has(child)) {
		closeEvents.set(
			child,
			new Promise<void>((resolve) => child.once("close", resolve)),
		);
	}
	return child;
}

export async function waitForChildClose(
	child: ChildCloseEmitter & object,
): Promise<void> {
	const close = closeEvents.get(child);
	if (!close) {
		throw new Error("g6 child lifecycle: child close was not tracked at spawn");
	}
	await close;
}
