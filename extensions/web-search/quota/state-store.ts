/** 额度状态存储：只保存 HMAC scope 标识和冷却元数据，不保存凭据或请求内容。 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export type QuotaBackend = "exa" | "parallel" | "tavily" | "firecrawl" | "serpapi";
export type QuotaChannel = "anonymous" | "key";
export type QuotaFailureReason = "rate_limited" | "quota_exhausted";

export interface PersistedQuotaEntry {
	scopeId: string;
	backend: QuotaBackend;
	channel: QuotaChannel;
	reason: QuotaFailureReason;
	failureCount: number;
	until: number;
	lastFailureAt: number;
	updatedAt: number;
	cleared?: boolean;
}

export interface PersistedQuotaState {
	version: 1;
	salt: string;
	entries: PersistedQuotaEntry[];
}

export type QuotaStateLoadResult =
	| { status: "ok"; state: PersistedQuotaState }
	| { status: "missing" }
	| { status: "unavailable" | "corrupt" | "unknown_version"; reason: string };
export type QuotaStateSaveResult = { status: "saved" | "memory_only" } | { status: "unavailable"; reason: string };

export interface QuotaStateStore {
	readonly kind?: "memory" | "private";
	load(): Promise<QuotaStateLoadResult>;
	save(state: PersistedQuotaState): Promise<QuotaStateSaveResult>;
}

const BACKENDS = new Set<QuotaBackend>(["exa", "parallel", "tavily", "firecrawl", "serpapi"]);
const REASONS = new Set<QuotaFailureReason>(["rate_limited", "quota_exhausted"]);
const MAX_ENTRIES = 512;
const MAX_STATE_FILES = MAX_ENTRIES;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 4096;
const LOCK_WAIT_MS = 250;
const LOCK_RETRY_MS = 10;
const SAFE_UNAVAILABLE = "QUOTA_STATE_IO_UNAVAILABLE";
const SAFE_CORRUPT = "QUOTA_STATE_CORRUPT";
const SAFE_UNKNOWN = "QUOTA_STATE_UNKNOWN_VERSION";
const SAFE_LOCK_TIMEOUT = "QUOTA_STATE_LOCK_TIMEOUT";
const SAFE_LOCK_UNAVAILABLE = "QUOTA_STATE_LOCK_UNAVAILABLE";

function cloneState(state: PersistedQuotaState): PersistedQuotaState {
	return { version: 1, salt: state.salt, entries: state.entries.map((entry) => ({ ...entry })) };
}

function validateState(value: unknown): PersistedQuotaState | "unknown_version" | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	try { if (Buffer.byteLength(JSON.stringify(value)) > MAX_STATE_BYTES) return undefined; } catch { return undefined; }
	const record = value as Record<string, unknown>;
	if (record.version !== 1) return "unknown_version";
	if (Object.keys(record).some((key) => !["version", "salt", "entries"].includes(key))) return undefined;
	if (typeof record.salt !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(record.salt)) return undefined;
	const salt = Buffer.from(record.salt, "base64");
	if (salt.byteLength !== 32 || salt.toString("base64") !== record.salt) return undefined;
	if (!Array.isArray(record.entries) || record.entries.length > MAX_ENTRIES) return undefined;
	const entries: PersistedQuotaEntry[] = [];
	for (const item of record.entries) {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
		const row = item as Record<string, unknown>;
		if (Object.keys(row).some((key) => !["scopeId", "backend", "channel", "reason", "failureCount", "until", "lastFailureAt", "updatedAt", "cleared"].includes(key))) return undefined;
		if (typeof row.scopeId !== "string" || !/^[a-f0-9]{64}$/u.test(row.scopeId)) return undefined;
		if (!BACKENDS.has(row.backend as QuotaBackend) || (row.channel !== "anonymous" && row.channel !== "key") || !REASONS.has(row.reason as QuotaFailureReason)) return undefined;
		if (!Number.isSafeInteger(row.failureCount) || (row.failureCount as number) < 0 || (row.failureCount as number) > 1_000_000) return undefined;
		for (const field of ["until", "lastFailureAt", "updatedAt"] as const) {
			if (!Number.isSafeInteger(row[field]) || (row[field] as number) < 0) return undefined;
		}
		if (row.cleared !== undefined && typeof row.cleared !== "boolean") return undefined;
		entries.push({
			scopeId: row.scopeId,
			backend: row.backend as QuotaBackend,
			channel: row.channel,
			reason: row.reason as QuotaFailureReason,
			failureCount: row.failureCount as number,
			until: row.until as number,
			lastFailureAt: row.lastFailureAt as number,
			updatedAt: row.updatedAt as number,
			...(row.cleared === true ? { cleared: true } : {}),
		});
	}
	return { version: 1, salt: record.salt, entries };
}

function entryKey(entry: Pick<PersistedQuotaEntry, "scopeId" | "reason">): string {
	return `${entry.scopeId}:${entry.reason}`;
}

/** 并发更新只延长冷却、保留较大失败阶数；清除时间更新必须避免丢失新失败。 */
function conservativeMerge(current: PersistedQuotaEntry | undefined, incoming: PersistedQuotaEntry): PersistedQuotaEntry {
	if (current === undefined) return { ...incoming };
	if (current.backend !== incoming.backend || current.channel !== incoming.channel || current.reason !== incoming.reason) return { ...current };
	if (current.cleared || incoming.cleared) {
		if (incoming.updatedAt > current.updatedAt) return { ...incoming };
		if (current.updatedAt > incoming.updatedAt) return { ...current };
		if (current.cleared !== incoming.cleared) return current.cleared ? { ...incoming } : { ...current };
	}
	return {
		...((incoming.updatedAt > current.updatedAt ? incoming : current)),
		failureCount: Math.max(current.failureCount, incoming.failureCount),
		until: Math.max(current.until, incoming.until),
		lastFailureAt: Math.max(current.lastFailureAt, incoming.lastFailureAt),
		updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
	};
}

async function ensureDirectory(directory: string): Promise<void> {
	const absolute = resolve(directory);
	if (!isAbsolute(absolute)) throw new Error(SAFE_UNAVAILABLE);
	const root = parse(absolute).root;
	let current = root;
	const parts = absolute.slice(root.length).split(sep).filter(Boolean);
	for (const part of parts.slice(0, -1)) {
		current = join(current, part);
		const stat = await lstat(current);
		if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(SAFE_UNAVAILABLE);
	}
	try {
		await mkdir(absolute, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = await lstat(absolute);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(SAFE_UNAVAILABLE);
	if (process.getuid !== undefined && stat.uid !== process.getuid()) throw new Error(SAFE_UNAVAILABLE);
	// 已有目录权限不自动修改；只有新建时由 mkdir 请求 0700，umask 只会进一步收紧。
	if ((stat.mode & 0o077) !== 0) throw new Error(SAFE_UNAVAILABLE);
}

async function readPrivateFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0 || stat.size > maxBytes) {
			throw new Error(SAFE_UNAVAILABLE);
		}
		const buffer = Buffer.alloc(maxBytes + 1);
		let total = 0;
		while (total < buffer.byteLength) {
			const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
			if (bytesRead === 0) break;
			total += bytesRead;
		}
		if (total > maxBytes) throw new Error(SAFE_UNAVAILABLE);
		return buffer.subarray(0, total);
	} finally {
		await handle.close();
	}
}

async function safeReadStateFile(path: string): Promise<PersistedQuotaEntry | "missing" | "corrupt" | "unknown_version"> {
	const bytes = await readPrivateFile(path, MAX_ENTRY_BYTES);
	if (bytes === undefined) return "missing";
	let decoded: unknown;
	try { decoded = JSON.parse(bytes.toString("utf8")); } catch { return "corrupt"; }
	if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return "corrupt";
	const row = decoded as Record<string, unknown>;
	if (row.version !== 1) return "unknown_version";
	if (Object.keys(row).some((key) => !["version", "entry"].includes(key))) return "corrupt";
	const checked = validateState({ version: 1, salt: Buffer.alloc(32).toString("base64"), entries: [row.entry] });
	if (checked === undefined || checked === "unknown_version") return "corrupt";
	return checked.entries[0];
}

async function atomicWrite(path: string, bytes: string): Promise<void> {
	const directory = dirname(path);
	const temporary = join(directory, `.quota-tmp-${process.pid}-${randomBytes(12).toString("hex")}`);
	const handle = await open(temporary, "wx", 0o600);
	try {
		await handle.writeFile(bytes, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	const stat = await lstat(temporary);
	if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) throw new Error(SAFE_UNAVAILABLE);
	await rename(temporary, path);
}

interface HeldLock {
	handle: Awaited<ReturnType<typeof open>>;
	nonce: string;
}

async function acquireLock(path: string): Promise<HeldLock | "timeout"> {
	const nonce = randomBytes(24).toString("hex");
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			const handle = await open(path, "wx+", 0o600);
			try {
				await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce }), "utf8");
				await handle.sync();
				const stat = await handle.stat();
				if (!stat.isFile() || (process.getuid !== undefined && stat.uid !== process.getuid()) || (stat.mode & 0o077) !== 0) throw new Error(SAFE_LOCK_UNAVAILABLE);
				return { handle, nonce };
			} catch (error) {
				await handle.close();
				throw error;
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline) return "timeout";
			await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
		}
	}
}

async function releaseLock(path: string, lock: HeldLock): Promise<boolean> {
	try {
		const own = await lock.handle.stat();
		const current = await lstat(path);
		if (current.isSymbolicLink() || !current.isFile() || current.dev !== own.dev || current.ino !== own.ino ||
			(process.getuid !== undefined && current.uid !== process.getuid()) || (current.mode & 0o077) !== 0) return false;
		const buffer = Buffer.alloc(512);
		const { bytesRead } = await lock.handle.read(buffer, 0, buffer.byteLength, 0);
		const parsed: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
		const record = parsed as Record<string, unknown>;
		if (record.version !== 1 || record.pid !== process.pid || record.nonce !== lock.nonce || Object.keys(record).length !== 3) return false;
		const latest = await lstat(path);
		if (latest.isSymbolicLink() || latest.dev !== own.dev || latest.ino !== own.ino) return false;
		await unlink(path);
		return true;
	} catch {
		return false;
	} finally {
		await lock.handle.close().catch(() => undefined);
	}
}

function entryFileName(entry: Pick<PersistedQuotaEntry, "scopeId" | "reason">): string {
	return `scope-${entry.scopeId}-${entry.reason}.json`;
}

const ENTRY_PATTERN = /^scope-([a-f0-9]{64})-(rate_limited|quota_exhausted)\.json$/u;

async function readEntries(directory: string): Promise<
	| { status: "ok"; entries: Map<string, PersistedQuotaEntry> }
	| { status: "corrupt" | "unknown_version" | "unavailable"; reason: string }
> {
	const names = await readdir(directory);
	const scopeFiles = names.filter((name) => name.startsWith("scope-"));
	if (scopeFiles.length > MAX_STATE_FILES) return { status: "corrupt", reason: SAFE_CORRUPT };
	const entries = new Map<string, PersistedQuotaEntry>();
	for (const name of scopeFiles) {
		const match = ENTRY_PATTERN.exec(name);
		if (match === null) return { status: "corrupt", reason: SAFE_CORRUPT };
		const row = await safeReadStateFile(join(directory, name));
		if (row === "unknown_version") return { status: "unknown_version", reason: SAFE_UNKNOWN };
		if (row === "corrupt" || row === "missing") return { status: "corrupt", reason: SAFE_CORRUPT };
		if (row.scopeId !== match[1] || row.reason !== match[2]) return { status: "corrupt", reason: SAFE_CORRUPT };
		const key = entryKey(row);
		if (entries.has(key)) return { status: "corrupt", reason: SAFE_CORRUPT };
		entries.set(key, row);
	}
	return { status: "ok", entries };
}

function checkSalt(value: unknown): PersistedQuotaState | "unknown_version" | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const row = value as Record<string, unknown>;
	return validateState({ ...row, entries: [] });
}

/** 默认内存状态仓库；新 manager 实例不共享，测试可自行注入。 */
export function createMemoryQuotaStateStore(): QuotaStateStore {
	let state: PersistedQuotaState | undefined;
	return {
		kind: "memory",
		async load() {
			return state === undefined ? { status: "missing" } : { status: "ok", state: cloneState(state) };
		},
		async save(next) {
			state = cloneState(next);
			return { status: "memory_only" };
		},
	};
}

/** 私有磁盘仓库；只有显式构造后才访问该目录。 */
export function createPrivateQuotaStateStore(directory: string): QuotaStateStore {
	const base = resolve(directory);
	const saltPath = join(base, "quota-salt.json");
	const lockPath = join(base, ".quota-state.lock");
	let blocked: QuotaStateLoadResult | undefined;

	const readSalt = async (): Promise<PersistedQuotaState | "missing" | "corrupt" | "unknown_version"> => {
		const bytes = await readPrivateFile(saltPath, 1024);
		if (bytes === undefined) return "missing";
		let decoded: unknown;
		try { decoded = JSON.parse(bytes.toString("utf8")); } catch { return "corrupt"; }
		const checked = checkSalt(decoded);
		if (checked === "unknown_version") return "unknown_version";
		return checked === undefined ? "corrupt" : checked;
	};

	const load = async (): Promise<QuotaStateLoadResult> => {
		try {
			await ensureDirectory(base);
			const lock = await acquireLock(lockPath);
			if (lock === "timeout") {
				blocked = { status: "unavailable", reason: SAFE_LOCK_TIMEOUT };
				return blocked;
			}
			let saltState: PersistedQuotaState | "missing" | "corrupt" | "unknown_version";
			try {
				saltState = await readSalt();
				if (saltState === "missing") {
					const names = await readdir(base);
					if (names.some((name) => name.startsWith("scope-"))) saltState = "corrupt";
					else {
						const generated = JSON.stringify({ version: 1, salt: randomBytes(32).toString("base64") });
						const handle = await open(saltPath, "wx", 0o600);
						try { await handle.writeFile(generated, "utf8"); await handle.sync(); } finally { await handle.close(); }
						saltState = await readSalt();
					}
				}
				if (saltState === "unknown_version") {
					blocked = { status: "unknown_version", reason: SAFE_UNKNOWN };
					return blocked;
				}
				if (saltState === "corrupt" || saltState === "missing") {
					blocked = { status: "corrupt", reason: SAFE_CORRUPT };
					return blocked;
				}
				// 持锁读取完整快照，避免并发写入只恢复部分冷却记录。
				const read = await readEntries(base);
				if (read.status !== "ok") {
					blocked = read;
					return blocked;
				}
				if (read.entries.size > MAX_ENTRIES) {
					blocked = { status: "corrupt", reason: SAFE_CORRUPT };
					return blocked;
				}
				return { status: "ok", state: { version: 1, salt: saltState.salt, entries: [...read.entries.values()] } };
			} finally {
				if (!(await releaseLock(lockPath, lock))) throw new Error(SAFE_LOCK_UNAVAILABLE);
			}
		} catch {
			blocked = { status: "unavailable", reason: SAFE_UNAVAILABLE };
			return blocked;
		}
	};

	const saveLocked = async (state: PersistedQuotaState): Promise<QuotaStateSaveResult> => {
		if (blocked !== undefined) return { status: "unavailable", reason: "reason" in blocked ? blocked.reason : SAFE_CORRUPT };
		const checked = validateState(state);
		if (checked === undefined || checked === "unknown_version") return { status: "unavailable", reason: SAFE_CORRUPT };
		let saltState = await readSalt();
		if (saltState === "unknown_version") return { status: "unavailable", reason: SAFE_UNKNOWN };
		if (saltState === "corrupt") return { status: "unavailable", reason: SAFE_CORRUPT };
		if (saltState === "missing") {
			const names = await readdir(base);
			if (names.some((name) => name.startsWith("scope-"))) return { status: "unavailable", reason: SAFE_CORRUPT };
			const encoded = JSON.stringify({ version: 1, salt: checked.salt });
			try {
				const handle = await open(saltPath, "wx", 0o600);
				try { await handle.writeFile(encoded, "utf8"); await handle.sync(); } finally { await handle.close(); }
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			saltState = await readSalt();
		}
		if (saltState === "unknown_version") return { status: "unavailable", reason: SAFE_UNKNOWN };
		if (saltState === "corrupt" || saltState === "missing" || saltState.salt !== checked.salt) return { status: "unavailable", reason: SAFE_CORRUPT };
		const read = await readEntries(base);
		if (read.status !== "ok") return { status: "unavailable", reason: read.reason };
		const mergedEntries = new Map(read.entries);
		const updates: PersistedQuotaEntry[] = [];
		for (const incoming of checked.entries) {
			const key = entryKey(incoming);
			const previous = mergedEntries.get(key);
			const merged = conservativeMerge(previous, incoming);
			if (JSON.stringify(previous) !== JSON.stringify(merged)) updates.push(merged);
			mergedEntries.set(key, merged);
		}
		if (mergedEntries.size > MAX_ENTRIES) return { status: "unavailable", reason: SAFE_CORRUPT };
		for (const entry of updates) {
			await atomicWrite(join(base, entryFileName(entry)), JSON.stringify({ version: 1, entry }));
		}
		return { status: "saved" };
	};

	const save = async (state: PersistedQuotaState): Promise<QuotaStateSaveResult> => {
		try {
			await ensureDirectory(base);
			const checked = validateState(state);
			if (checked === undefined || checked === "unknown_version") return { status: "unavailable", reason: SAFE_CORRUPT };
			const lock = await acquireLock(lockPath);
			if (lock === "timeout") return { status: "unavailable", reason: SAFE_LOCK_TIMEOUT };
			let result: QuotaStateSaveResult;
			try { result = await saveLocked(checked); }
			finally {
				if (!(await releaseLock(lockPath, lock))) result = { status: "unavailable", reason: SAFE_LOCK_UNAVAILABLE };
			}
			return result!;
		} catch {
			return { status: "unavailable", reason: SAFE_UNAVAILABLE };
		}
	};

	return { kind: "private", load, save };
}
