/**
 * Minimal IndexedDB double for the ticket-store tests. Bun has no `indexedDB`,
 * and the single-use ticket contract depends on exactly two IndexedDB
 * guarantees, both modeled here:
 *
 *   1. requests complete asynchronously, so other work runs between issuing a
 *      request and observing its result;
 *   2. transactions whose scopes overlap run one at a time, and a transaction
 *      stays open until it has no further pending requests — so a read and a
 *      delete issued from that read's callback commit together.
 *
 * Nothing else about IndexedDB is modeled. The same cases run against real
 * browser IndexedDB in the WASM Playwright lane.
 */

type Mode = "readonly" | "readwrite";

class FakeRequest<T> {
	result!: T;
	error: Error | null = null;
	onsuccess: (() => void) | null = null;
	onerror: (() => void) | null = null;
}

class FakeTransaction {
	error: Error | null = null;
	oncomplete: (() => void) | null = null;
	onerror: (() => void) | null = null;

	private ops: Array<() => void> = [];
	private started = false;
	private stepScheduled = false;
	private settled = false;

	constructor(
		private readonly db: FakeDatabase,
		private readonly storeName: string,
		readonly mode: Mode,
	) {
		db._enqueue(this);
	}

	objectStore(name: string) {
		if (name !== this.storeName) {
			throw new Error(`store ${name} is not in this transaction's scope`);
		}
		return {
			get: (key: string) => {
				const req = new FakeRequest<Uint8Array | undefined>();
				this.push(() => {
					req.result = this.db._data.get(key);
					req.onsuccess?.();
				});
				return req;
			},
			put: (value: Uint8Array, key: string) => {
				this.assertWritable();
				this.push(() => {
					this.db._data.set(key, value);
				});
			},
			delete: (key: string) => {
				this.assertWritable();
				this.push(() => {
					this.db._data.delete(key);
				});
			},
		};
	}

	/** @internal Called by the database once this transaction owns the store. */
	_start(): void {
		this.started = true;
		this.scheduleStep();
	}

	private assertWritable(): void {
		if (this.mode !== "readwrite") {
			throw new Error("write issued on a readonly transaction");
		}
	}

	private push(op: () => void): void {
		if (this.settled)
			throw new Error("request issued on a settled transaction");
		this.ops.push(op);
		if (this.started) this.scheduleStep();
	}

	private scheduleStep(): void {
		if (this.stepScheduled || this.settled) return;
		this.stepScheduled = true;
		queueMicrotask(() => {
			this.stepScheduled = false;
			this.step();
		});
	}

	private step(): void {
		if (this.settled) return;
		const op = this.ops.shift();
		if (!op) {
			// No pending requests left: the transaction commits and only now
			// releases the store to the next waiter.
			this.settled = true;
			this.db._release();
			this.oncomplete?.();
			return;
		}
		try {
			op();
		} catch (error) {
			this.settled = true;
			this.error = error instanceof Error ? error : new Error(String(error));
			this.db._release();
			this.onerror?.();
			return;
		}
		this.scheduleStep();
	}
}

class FakeDatabase {
	/** @internal */
	readonly _data = new Map<string, Uint8Array>();
	private readonly stores = new Set<string>();
	private readonly waiting: FakeTransaction[] = [];
	private active: FakeTransaction | null = null;

	readonly objectStoreNames = {
		contains: (name: string) => this.stores.has(name),
	};

	createObjectStore(name: string): void {
		this.stores.add(name);
	}

	transaction(storeName: string, mode: Mode): FakeTransaction {
		return new FakeTransaction(this, storeName, mode);
	}

	/** @internal */
	_enqueue(tx: FakeTransaction): void {
		this.waiting.push(tx);
		this.pump();
	}

	/** @internal */
	_release(): void {
		this.active = null;
		this.pump();
	}

	private pump(): void {
		if (this.active) return;
		const next = this.waiting.shift();
		if (!next) return;
		this.active = next;
		next._start();
	}
}

export type FakeIndexedDBHandle = {
	/** Direct view of stored ticket bytes, bypassing transactions. */
	raw(dbName: string): Map<string, Uint8Array>;
	restore(): void;
};

/**
 * Install a fake `globalThis.indexedDB` for the duration of a test. Returns a
 * handle that restores whatever was there before.
 */
export function installFakeIndexedDB(): FakeIndexedDBHandle {
	const target = globalThis as { indexedDB?: unknown };
	const previous = Object.getOwnPropertyDescriptor(target, "indexedDB");
	const databases = new Map<string, FakeDatabase>();

	const factory = {
		open(name: string) {
			const req =
				new FakeRequest<FakeDatabase>() as FakeRequest<FakeDatabase> & {
					onupgradeneeded: (() => void) | null;
				};
			req.onupgradeneeded = null;
			const fresh = !databases.has(name);
			const db = databases.get(name) ?? new FakeDatabase();
			databases.set(name, db);
			req.result = db;
			queueMicrotask(() => {
				if (fresh) req.onupgradeneeded?.();
				req.onsuccess?.();
			});
			return req;
		},
	};

	Object.defineProperty(target, "indexedDB", {
		value: factory,
		configurable: true,
		writable: true,
	});

	return {
		raw(dbName: string) {
			const db = databases.get(dbName);
			if (!db) throw new Error(`database ${dbName} was never opened`);
			return db._data;
		},
		restore() {
			if (previous) Object.defineProperty(target, "indexedDB", previous);
			else delete target.indexedDB;
		},
	};
}
