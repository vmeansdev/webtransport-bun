import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TicketStoreHost } from "./backend-wasm.js";

const POSIX_TICKET_DIRECTORY_MODE = 0o700;
const POSIX_TICKET_FILE_MODE = 0o600;

function isErrno(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === code
	);
}

function rejectUnsafeTicketPath(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) {
		throw new Error(`Refusing symlink ticket path: ${path}`);
	}
	if (!stat.isFile()) {
		throw new Error(`Refusing non-regular ticket path: ${path}`);
	}
}

function readTicket(path: string): Uint8Array | null {
	try {
		rejectUnsafeTicketPath(path);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return null;
		throw error;
	}

	if (process.platform === "win32") {
		return new Uint8Array(readFileSync(path));
	}

	let fd: number | undefined;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			throw new Error(`Refusing non-regular ticket path: ${path}`);
		}
		const ticket = new Uint8Array(readFileSync(fd));
		fchmodSync(fd, POSIX_TICKET_FILE_MODE);
		return ticket;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return null;
		if (isErrno(error, "ELOOP")) {
			throw new Error(`Refusing symlink ticket path: ${path}`, {
				cause: error,
			});
		}
		throw error;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function keyToFile(dir: string, key: string): string {
	const safe = Buffer.from(key, "utf8").toString("base64url");
	return join(dir, `${safe}.ticket`);
}

/** Bun/Node durable TicketStoreHost using one file per authority key. */
export class FileTicketStoreHost implements TicketStoreHost {
	constructor(private readonly directory: string) {
		mkdirSync(directory, {
			recursive: true,
			mode: POSIX_TICKET_DIRECTORY_MODE,
		});
		const stat = lstatSync(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Refusing unsafe ticket directory: ${directory}`);
		}
		if (process.platform !== "win32") {
			chmodSync(directory, POSIX_TICKET_DIRECTORY_MODE);
		}
	}

	async get(key: string): Promise<Uint8Array | null> {
		return readTicket(keyToFile(this.directory, key));
	}

	async put(key: string, ticket: Uint8Array): Promise<void> {
		const path = keyToFile(this.directory, key);
		try {
			rejectUnsafeTicketPath(path);
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}

		const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random()
			.toString(36)
			.slice(2)}.tmp`;
		let fd: number | undefined;
		let renamed = false;
		try {
			// No mode argument on Windows: it is meaningless there (the POSIX
			// tightening below is already skipped), and Bun 1.3.9 on Windows
			// fails the open with a spurious ENOENT when a mode is passed.
			fd =
				process.platform === "win32"
					? openSync(
							tmp,
							constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
						)
					: openSync(
							tmp,
							constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
							POSIX_TICKET_FILE_MODE,
						);
			writeFileSync(fd, ticket);
			if (process.platform !== "win32") {
				fchmodSync(fd, POSIX_TICKET_FILE_MODE);
			}
			closeSync(fd);
			fd = undefined;
			renameSync(tmp, path);
			renamed = true;
		} finally {
			if (fd !== undefined) closeSync(fd);
			if (!renamed) {
				try {
					unlinkSync(tmp);
				} catch (error) {
					if (!isErrno(error, "ENOENT")) throw error;
				}
			}
		}
	}

	async take(key: string): Promise<Uint8Array | null> {
		const path = keyToFile(this.directory, key);
		// Claim the ticket with an atomic rename before reading it. A plain
		// read-then-unlink lets two processes sharing this directory both read
		// the ticket before either unlinks it and replay the same 0-RTT ticket;
		// rename has exactly one winner (the same single-use guarantee the
		// IndexedDB host gets from its single readwrite transaction).
		const claim = `${path}.take-${process.pid}-${takeSequence++}`;
		try {
			renameSync(path, claim);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return null;
			throw error;
		}
		try {
			return readTicket(claim);
		} finally {
			try {
				unlinkSync(claim);
			} catch (error) {
				if (!isErrno(error, "ENOENT")) throw error;
			}
		}
	}
}

/** Monotonic suffix so concurrent take() claims in one process never collide. */
let takeSequence = 0;

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

	/**
	 * Read and remove one ticket in a single readwrite transaction. Reading
	 * through the public `get()` first would commit that read before the delete,
	 * letting a concurrent `take()` observe the same ticket and replay it.
	 */
	async take(key: string): Promise<Uint8Array | null> {
		const db = await this.db();
		return new Promise((resolve, reject) => {
			const tx = db.transaction(this.storeName, "readwrite");
			const store = tx.objectStore(this.storeName);
			const req = store.get(key);
			let taken: Uint8Array | null = null;
			req.onsuccess = () => {
				const value = req.result;
				if (value === undefined) return;
				if (!(value instanceof Uint8Array)) {
					// Corrupt or legacy-shaped row: evict it rather than leaving a
					// permanent tombstone that disables 0-RTT for this authority.
					store.delete(key);
					return;
				}
				taken = value.slice();
				store.delete(key);
			};
			req.onerror = () =>
				reject(req.error ?? new Error("indexedDB ticket read failed"));
			tx.oncomplete = () => resolve(taken);
			tx.onerror = () =>
				reject(tx.error ?? new Error("indexedDB ticket take failed"));
		});
	}
}
