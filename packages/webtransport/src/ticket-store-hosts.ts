import {
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TicketStoreHost } from "./backend-wasm.js";

function keyToFile(dir: string, key: string): string {
	const safe = Buffer.from(key, "utf8").toString("base64url");
	return join(dir, `${safe}.ticket`);
}

/** Bun/Node durable TicketStoreHost using one file per authority key. */
export class FileTicketStoreHost implements TicketStoreHost {
	constructor(private readonly directory: string) {
		mkdirSync(directory, { recursive: true });
	}

	async get(key: string): Promise<Uint8Array | null> {
		try {
			return new Uint8Array(readFileSync(keyToFile(this.directory, key)));
		} catch {
			return null;
		}
	}

	async put(key: string, ticket: Uint8Array): Promise<void> {
		const path = keyToFile(this.directory, key);
		const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, ticket);
		renameSync(tmp, path);
	}

	async take(key: string): Promise<Uint8Array | null> {
		const path = keyToFile(this.directory, key);
		try {
			const value = new Uint8Array(readFileSync(path));
			unlinkSync(path);
			return value;
		} catch {
			return null;
		}
	}
}

// Minimal local shapes for the subset of the browser IndexedDB API used
// below. Declared locally (rather than relying on the DOM lib, which this
// package's tsconfig omits so the wasm bundle stays free of `window`/`document`
// globals) so this file type-checks under both Bun/Node and browser builds.
type IDBRequestLike<T> = {
	result: T;
	error: Error | null;
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
};
type IDBObjectStoreLike = {
	get(key: string): IDBRequestLike<Uint8Array | undefined>;
	put(value: Uint8Array, key: string): void;
	delete(key: string): void;
};
type IDBTransactionLike = {
	objectStore(name: string): IDBObjectStoreLike;
	error: Error | null;
	oncomplete: (() => void) | null;
	onerror: (() => void) | null;
};
type IDBDatabaseLike = {
	objectStoreNames: { contains(name: string): boolean };
	createObjectStore(name: string): void;
	transaction(
		storeName: string,
		mode: "readonly" | "readwrite",
	): IDBTransactionLike;
};
type IDBOpenDBRequestLike = IDBRequestLike<IDBDatabaseLike> & {
	onupgradeneeded: (() => void) | null;
};
type IDBFactoryLike = {
	open(name: string, version?: number): IDBOpenDBRequestLike;
};

/**
 * Browser/IWA IndexedDB TicketStoreHost. Requires global `indexedDB`.
 */
export class IndexedDBTicketStoreHost implements TicketStoreHost {
	private dbPromise: Promise<IDBDatabaseLike> | null = null;

	constructor(
		private readonly dbName = "webtransport-bun-tickets",
		private readonly storeName = "tickets",
	) {}

	private db(): Promise<IDBDatabaseLike> {
		if (this.dbPromise) return this.dbPromise;
		const factory = (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB;
		if (!factory) {
			return Promise.reject(new Error("indexedDB is not available"));
		}
		this.dbPromise = new Promise((resolve, reject) => {
			const req = factory.open(this.dbName, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(this.storeName)) {
					db.createObjectStore(this.storeName);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () =>
				reject(req.error ?? new Error("indexedDB open failed"));
		});
		return this.dbPromise;
	}

	async get(key: string): Promise<Uint8Array | null> {
		const db = await this.db();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(this.storeName, "readonly");
			const req = tx.objectStore(this.storeName).get(key);
			req.onsuccess = () => {
				const value = req.result;
				resolve(value instanceof Uint8Array ? value.slice() : null);
			};
			req.onerror = () => reject(req.error);
		});
	}

	async put(key: string, ticket: Uint8Array): Promise<void> {
		const db = await this.db();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(this.storeName, "readwrite");
			tx.objectStore(this.storeName).put(ticket.slice(), key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
	}

	async take(key: string): Promise<Uint8Array | null> {
		const existing = await this.get(key);
		if (!existing) return null;
		const db = await this.db();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(this.storeName, "readwrite");
			tx.objectStore(this.storeName).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		return existing;
	}
}
