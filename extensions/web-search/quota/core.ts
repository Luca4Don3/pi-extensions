/** 额度核心：HMAC scope、冷却历史、额度查询缓存和进程内同步预留。 */
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { estimateSearchCost, type QuotaOperation } from "./cost.js";
import {
	createMemoryQuotaStateStore,
	type PersistedQuotaEntry,
	type PersistedQuotaState,
	type QuotaBackend,
	type QuotaChannel,
	type QuotaFailureReason,
	type QuotaStateStore,
} from "./state-store.js";
import {
	lookupUsage,
	type QuotaLookupInput,
	type QuotaLookupOptions,
	type QuotaLookupResult,
	type QuotaUnknownReason,
} from "./usage.js";

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_HISTORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const BALANCE_CACHE_MS = 5 * 60 * 1000;
const FAILURE_CACHE_MS = 30 * 1000;
const RATE_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 1_800_000] as const;
const QUOTA_BACKOFF_MS = [1_800_000, 3_600_000, 7_200_000, 14_400_000] as const;

export type { QuotaBackend, QuotaChannel, QuotaFailureReason, QuotaStateStore };
export type { QuotaLookupInput, QuotaLookupOptions, QuotaLookupResult, QuotaUnknownReason };

export interface QuotaCooldown {
	backend: QuotaBackend;
	channel: QuotaChannel;
	reason: QuotaFailureReason;
	until: number;
	remainingMs: number;
	failureCount: number;
	/** 额度冷却仅是建议探测时间，不代表真实额度重置时间。 */
	nextProbeAt?: number;
}

export interface QuotaFailureOptions {
	credential?: string;
	cooldownMs?: number;
	retryAfterMs?: number;
}

export interface QuotaSnapshot {
	persistence: "not_initialized" | "persistent" | "memory_only" | "degraded";
	cooldowns: QuotaCooldown[];
}

export interface QuotaManagerOptions {
	clock?: () => number;
	lookup?: (input: QuotaLookupInput, options?: QuotaLookupOptions) => Promise<QuotaLookupResult>;
	stateStore?: QuotaStateStore;
	/** 查询接口从 fetch 到解压正文共用的总期限，默认 2000 毫秒。 */
	deadlineMs?: number;
	/** 传给既有 readResponseTextLimited 的解压后正文上限，默认 5 MiB。 */
	maxResponseBytes?: number;
	/** 未提供时用分原因阶梯；0 禁用所有冷却，但仍记录当前历史计数。 */
	cooldownMs?: number;
}

export interface QuotaScope {
	backend: QuotaBackend;
	channel: QuotaChannel;
	credential?: string;
}

export interface QuotaBalanceInput extends QuotaScope {
	allowBillable: boolean;
	signal?: AbortSignal;
}

export type QuotaBalance = QuotaLookupResult & { cached?: boolean };

export interface QuotaReservationInput {
	backend: QuotaBackend;
	channel: "key";
	credential: string;
	allowBillable: boolean;
	operation: QuotaOperation;
	maxResults: number;
}

export interface QuotaReservation {
	readonly id: string;
	readonly cost: number;
	/** 必须紧邻真实 dispatch 调用；从此刻起无论结果如何均先扣预估费用。 */
	dispatch(): boolean;
	/** 仅未 dispatch 时释放预留；dispatch 后不会退款。 */
	release(): boolean;
	/** 可选可信 actualCost 只校正估算，不把失败/超时当成退款依据。 */
	settle(actualCost?: number): boolean;
}

export type QuotaReserveResult =
	| { status: "reserved"; cost: number; availableBefore: number; reservation: QuotaReservation }
	| { status: "denied"; reason: "authorization_required" | "unsupported_operation" | "unknown_balance" | "insufficient_credits"; available?: number };

interface InternalRecord extends PersistedQuotaEntry {}
interface CachedBalance {
	value: QuotaLookupResult;
	expiresAt: number;
}
interface HeldReservation {
	cost: number;
	quotaEpoch: number;
	dispatched: boolean;
	settled: boolean;
}
interface BalanceLedger {
	observedRemaining: number;
	debited: number;
	reservations: Map<string, HeldReservation>;
}
interface Flight {
	scopeId: string;
	quotaEpoch: number;
	controller: AbortController;
	waiters: Set<symbol>;
	promise: Promise<QuotaLookupResult>;
}

function abortError(): DOMException {
	return new DOMException("Quota lookup aborted", "AbortError");
}

function validateDuration(value: number | undefined, name: string): void {
	if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_COOLDOWN_MS)) {
		throw new Error(`${name} must be an integer from 0 to 86400000`);
	}
}

function validateRetryAfter(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || value < 0) throw new Error("retryAfterMs must be a non-negative safe integer");
	return Math.min(value, MAX_COOLDOWN_MS);
}

function safeLookupResult(value: unknown): QuotaLookupResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { state: "unknown", reason: "invalid_response" };
	const row = value as Record<string, unknown>;
	if (row.state === "known") {
		if (!Number.isSafeInteger(row.remaining) || typeof row.remaining !== "number" || row.remaining < 0 || row.eligibility !== "not_verified") {
			return { state: "unknown", reason: "invalid_response" };
		}
		return {
			state: "known",
			remaining: row.remaining as number,
			eligibility: "not_verified",
			...(Number.isSafeInteger(row.observedAt) && (row.observedAt as number) >= 0 ? { observedAt: row.observedAt as number } : {}),
		};
	}
	const reasons = new Set<QuotaUnknownReason>([
		"authorization_required", "unsupported_backend", "lookup_failed", "invalid_response", "timeout", "aborted", "rate_limited",
	]);
	if (row.state === "unknown" && reasons.has(row.reason as QuotaUnknownReason)) {
		return {
			state: "unknown",
			reason: row.reason as QuotaUnknownReason,
			...(Number.isSafeInteger(row.retryAfterMs) && (row.retryAfterMs as number) >= 0
				? { retryAfterMs: Math.min(row.retryAfterMs as number, MAX_COOLDOWN_MS) }
				: {}),
		};
	}
	return { state: "unknown", reason: "invalid_response" };
}

function lookupIsAborted(value: QuotaLookupResult): boolean {
	return value.state === "unknown" && value.reason === "aborted";
}

function statusKey(scopeId: string, reason: QuotaFailureReason): string {
	return `${scopeId}:${reason}`;
}

function cloneLookupResult(value: QuotaLookupResult): QuotaLookupResult {
	return { ...value };
}

/** 创建实例隔离的额度管理器；默认状态仓库是内存，不读取任何用户配置目录。 */
export function createQuotaManager(options: QuotaManagerOptions = {}) {
	const clock = options.clock ?? Date.now;
	const defaultCooldownMs = options.cooldownMs;
	validateDuration(defaultCooldownMs, "cooldownMs");
	const deadlineMs = options.deadlineMs ?? 2_000;
	const maxResponseBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60_000) throw new Error("deadlineMs must be from 1 to 60000");
	if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 20 * 1024 * 1024) throw new Error("maxResponseBytes is outside the supported range");
	const stateStore = options.stateStore ?? createMemoryQuotaStateStore();
	const lookup = options.lookup ?? lookupUsage;
	const records = new Map<string, InternalRecord>();
	const balances = new Map<string, CachedBalance>();
	const ledgers = new Map<string, BalanceLedger>();
	const flights = new Map<string, Flight>();
	let salt = randomBytes(32);
	let initialized: Promise<void> | undefined;
	let initializationComplete = false;
	let persistence: QuotaSnapshot["persistence"] = "not_initialized";
	const quotaEpochs = new Map<string, number>();
	let flushTail: Promise<unknown> = Promise.resolve();

	const initialize = (): Promise<void> => {
		if (initialized !== undefined) return initialized;
		initialized = (async () => {
			let loaded;
			try { loaded = await stateStore.load(); } catch { loaded = { status: "unavailable" as const, reason: "QUOTA_STATE_IO_UNAVAILABLE" }; }
			if (loaded.status === "ok") {
				salt = Buffer.from(loaded.state.salt, "base64");
				for (const entry of loaded.state.entries) records.set(statusKey(entry.scopeId, entry.reason), { ...entry });
				persistence = stateStore.kind === "private" ? "persistent" : "memory_only";
				pruneHistory();
			} else if (loaded.status === "missing") {
				persistence = stateStore.kind === "private" ? "persistent" : "memory_only";
			} else {
				persistence = "degraded";
			}
			initializationComplete = true;
		})();
		return initialized;
	};

	const assertInitialized = (): void => {
		if (!initializationComplete) throw new Error("QUOTA_MANAGER_NOT_INITIALIZED");
	};

	const scopeIdFor = (scope: QuotaScope): string => {
		assertInitialized();
		if (scope.channel === "key" && (typeof scope.credential !== "string" || scope.credential.length === 0)) {
			throw new Error("A key credential is required for keyed quota state");
		}
		const message = JSON.stringify([scope.backend, scope.channel, scope.channel === "key" ? scope.credential : null]);
		return createHmac("sha256", salt).update(message, "utf8").digest("hex");
	};

	function pruneHistory(): void {
		const now = clock();
		for (const [key, record] of records) {
			if (now - record.lastFailureAt > MAX_HISTORY_AGE_MS) records.delete(key);
		}
	}

	const recordFailure = (
		backend: QuotaBackend,
		channel: QuotaChannel,
		reason: QuotaFailureReason,
		failureOptions: QuotaFailureOptions = {},
	): QuotaCooldown | undefined => {
		assertInitialized();
		validateDuration(failureOptions.cooldownMs, "cooldownMs");
		const retryAfterMs = validateRetryAfter(failureOptions.retryAfterMs);
		const scope = { backend, channel, ...(failureOptions.credential === undefined ? {} : { credential: failureOptions.credential }) };
		const scopeId = scopeIdFor(scope);
		const key = statusKey(scopeId, reason);
		const now = clock();
		const previous = records.get(key);
		const historicalCount = previous !== undefined && !previous.cleared && now - previous.lastFailureAt <= MAX_HISTORY_AGE_MS
			? previous.failureCount
			: 0;
		const failureCount = Math.min(1_000_000, historicalCount + 1);
		const ladder = reason === "rate_limited" ? RATE_BACKOFF_MS : QUOTA_BACKOFF_MS;
		const steppedDuration = ladder[Math.min(failureCount - 1, ladder.length - 1)]!;
		const duration = failureOptions.cooldownMs ?? defaultCooldownMs ?? (retryAfterMs ?? steppedDuration);
		const retryDuration = retryAfterMs ?? duration;
		const actualDuration = duration === 0 ? 0 : Math.min(retryDuration, MAX_COOLDOWN_MS);
		const until = Math.min(Number.MAX_SAFE_INTEGER, now + actualDuration);
		const entry: InternalRecord = {
			scopeId,
			backend,
			channel,
			reason,
			failureCount,
			until,
			lastFailureAt: now,
			updatedAt: now,
		};
		records.set(key, entry);
		if (reason === "quota_exhausted") {
			quotaEpochs.set(scopeId, (quotaEpochs.get(scopeId) ?? 0) + 1);
			balances.delete(scopeId);
		}
		return actualDuration === 0 ? undefined : cooldownFrom(entry, now);
	};

	const cooldownFrom = (entry: InternalRecord, now: number): QuotaCooldown => ({
		backend: entry.backend,
		channel: entry.channel,
		reason: entry.reason,
		until: entry.until,
		remainingMs: Math.max(0, entry.until - now),
		failureCount: entry.failureCount,
		...(entry.reason === "quota_exhausted" ? { nextProbeAt: entry.until } : {}),
	});

	const getCooldown = (
		backend: QuotaBackend,
		channel: QuotaChannel,
		credentialOrCooldown?: string | number,
		cooldownMs?: number,
	): QuotaCooldown | undefined => {
		assertInitialized();
		const override = typeof credentialOrCooldown === "number" ? credentialOrCooldown : cooldownMs;
		validateDuration(override, "cooldownMs");
		if (override === 0 || defaultCooldownMs === 0) return undefined;
		const credential = typeof credentialOrCooldown === "string" ? credentialOrCooldown : undefined;
		const scopeId = scopeIdFor({ backend, channel, ...(credential === undefined ? {} : { credential }) });
		const now = clock();
		let active: InternalRecord | undefined;
		for (const reason of ["rate_limited", "quota_exhausted"] as const) {
			const entry = records.get(statusKey(scopeId, reason));
			if (entry !== undefined && !entry.cleared && entry.until > now && (active === undefined || entry.until > active.until)) active = entry;
		}
		return active === undefined ? undefined : cooldownFrom(active, now);
	};

	const recordSuccess = (
		backend: QuotaBackend,
		channel: QuotaChannel,
		credentialOrCooldown?: string | number,
		cooldownMs?: number,
	): void => {
		assertInitialized();
		validateDuration(typeof credentialOrCooldown === "number" ? credentialOrCooldown : cooldownMs, "cooldownMs");
		const credential = typeof credentialOrCooldown === "string" ? credentialOrCooldown : undefined;
		const scopeId = scopeIdFor({ backend, channel, ...(credential === undefined ? {} : { credential }) });
		const now = clock();
		if (!["rate_limited", "quota_exhausted"].some((reason) => records.has(statusKey(scopeId, reason as QuotaFailureReason)))) return;
		for (const reason of ["rate_limited", "quota_exhausted"] as const) {
			const key = statusKey(scopeId, reason);
			const previous = records.get(key);
			records.set(key, {
				scopeId,
				backend,
				channel,
				reason,
				failureCount: 0,
				until: now,
				lastFailureAt: previous?.lastFailureAt ?? now,
				updatedAt: now,
				cleared: true,
			});
		}
	};

	const lookupBalance = async (input: QuotaBalanceInput): Promise<QuotaBalance> => {
		await initialize();
		if (input.allowBillable !== true || input.channel !== "key" || typeof input.credential !== "string" || input.credential.length === 0) {
			return { state: "unknown", reason: "authorization_required" };
		}
		if (input.signal?.aborted) throw abortError();
		const credential = input.credential;
		const scopeId = scopeIdFor({ backend: input.backend, channel: "key", credential });
		const now = clock();
		const currentCooldown = getCooldown(input.backend, "key", credential);
		if (currentCooldown !== undefined) {
			return { state: "unknown", reason: currentCooldown.reason === "rate_limited" ? "rate_limited" : "lookup_failed", ...(currentCooldown.reason === "rate_limited" ? { retryAfterMs: currentCooldown.remainingMs } : {}) };
		}
		const cached = balances.get(scopeId);
		if (cached !== undefined && cached.expiresAt > now) return { ...cloneLookupResult(cached.value), cached: true };
		let flight = flights.get(scopeId);
		if (flight === undefined) {
			const created: Flight = { scopeId, quotaEpoch: quotaEpochs.get(scopeId) ?? 0, controller: new AbortController(), waiters: new Set(), promise: Promise.resolve({ state: "unknown", reason: "lookup_failed" }) };
			flights.set(scopeId, created);
			created.promise = Promise.resolve().then(() => lookup({
				backend: input.backend,
				credential,
				allowBillable: true,
				signal: created.controller.signal,
			}, { deadlineMs, maxResponseBytes, clock })).then((result) => {
				const safe = safeLookupResult(result);
				if (created.controller.signal.aborted || lookupIsAborted(safe)) return { state: "unknown", reason: "aborted" } as QuotaLookupResult;
				if (created.quotaEpoch !== (quotaEpochs.get(scopeId) ?? 0)) return { state: "unknown", reason: "lookup_failed" } as QuotaLookupResult;
				const expiresAt = clock() + (safe.state === "known" ? BALANCE_CACHE_MS : FAILURE_CACHE_MS);
				balances.set(scopeId, { value: safe, expiresAt });
				if (safe.state === "known") {
					const oldLedger = ledgers.get(scopeId);
					if (oldLedger !== undefined && oldLedger.reservations.size > 0) {
						oldLedger.observedRemaining = Math.min(oldLedger.observedRemaining, safe.remaining);
						// 有 reservation 时不重置 debited；新观测可能已包含这些请求，重复扣减是有意保守的。
					} else {
						ledgers.set(scopeId, { observedRemaining: safe.remaining, debited: 0, reservations: oldLedger?.reservations ?? new Map() });
					}
					if (safe.remaining === 0) recordFailure(input.backend, "key", "quota_exhausted", { credential });
				} else if (safe.reason === "rate_limited") {
					recordFailure(input.backend, "key", "rate_limited", {
						credential,
						...(safe.retryAfterMs === undefined ? {} : { retryAfterMs: safe.retryAfterMs }),
					});
				}
				return safe;
			}).catch(() => {
				if (created.controller.signal.aborted) return { state: "unknown", reason: "aborted" } as QuotaLookupResult;
				const failure: QuotaLookupResult = { state: "unknown", reason: "lookup_failed" };
				balances.set(scopeId, { value: failure, expiresAt: clock() + FAILURE_CACHE_MS });
				return failure;
			}).finally(() => {
				if (flights.get(scopeId) === created) flights.delete(scopeId);
			});
			flight = created;
		}
		return waitForFlight(flight, input.signal);
	};

	function waitForFlight(flight: Flight, signal?: AbortSignal): Promise<QuotaBalance> {
		if (signal?.aborted) return Promise.reject(abortError());
		const waiter = Symbol("quota-waiter");
		flight.waiters.add(waiter);
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (callback: () => void): void => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", onAbort);
				flight.waiters.delete(waiter);
				callback();
			};
			const onAbort = (): void => finish(() => {
				reject(abortError());
				if (flight.waiters.size === 0) {
					flight.controller.abort();
					if (flights.get(flight.scopeId) === flight) flights.delete(flight.scopeId);
				}
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			flight.promise.then(
				(value) => finish(() => resolve({ ...cloneLookupResult(value), cached: false })),
				() => finish(() => resolve({ state: "unknown", reason: "lookup_failed", cached: false })),
			);
			if (signal?.aborted) onAbort();
		});
	}

	const reserve = (input: QuotaReservationInput): QuotaReserveResult => {
		assertInitialized();
		if (input.allowBillable !== true) return { status: "denied", reason: "authorization_required" };
		const cost = estimateSearchCost(input.backend, input.maxResults, input.operation);
		if (cost === undefined) return { status: "denied", reason: "unsupported_operation" };
		const scopeId = scopeIdFor({ backend: input.backend, channel: "key", credential: input.credential });
		if (getCooldown(input.backend, "key", input.credential) !== undefined) return { status: "denied", reason: "unknown_balance" };
		const cached = balances.get(scopeId);
		if (cached === undefined || cached.expiresAt <= clock() || cached.value.state !== "known") return { status: "denied", reason: "unknown_balance" };
		let ledger = ledgers.get(scopeId);
		if (ledger === undefined) {
			ledger = { observedRemaining: cached.value.remaining, debited: 0, reservations: new Map() };
			ledgers.set(scopeId, ledger);
		}
		const reservedTotal = [...ledger.reservations.values()].reduce((total, reservation) => total + (reservation.dispatched ? 0 : reservation.cost), 0);
		const available = Math.max(0, ledger.observedRemaining - ledger.debited - reservedTotal);
		if (cost > available) return { status: "denied", reason: "insufficient_credits", available };
		const id = randomUUID();
		const held: HeldReservation = { cost, quotaEpoch: quotaEpochs.get(scopeId) ?? 0, dispatched: false, settled: false };
		ledger.reservations.set(id, held);
		let chargedCost = cost;
		const reservation: QuotaReservation = {
			id,
			cost,
			dispatch() {
				if (held.settled || held.dispatched) return false;
				const freshBalance = balances.get(scopeId);
				if (held.quotaEpoch !== (quotaEpochs.get(scopeId) ?? 0) || getCooldown(input.backend, "key", input.credential) !== undefined || freshBalance === undefined ||
					freshBalance.expiresAt <= clock() || freshBalance.value.state !== "known") return false;
				held.dispatched = true;
				ledger!.debited = safeAdd(ledger!.debited, cost);
				return true;
			},
			release() {
				if (held.settled || held.dispatched) return false;
				held.settled = true;
				ledger!.reservations.delete(id);
				return true;
			},
			settle(actualCost) {
				if (held.settled) return false;
				if (!held.dispatched) {
					if (actualCost !== undefined) return false;
					held.settled = true;
					ledger!.reservations.delete(id);
					return true;
				}
				if (actualCost !== undefined) {
					if (!Number.isSafeInteger(actualCost) || actualCost < 0) throw new Error("actualCost must be a non-negative safe integer");
					ledger!.debited = Math.max(0, ledger!.debited + actualCost - chargedCost);
					chargedCost = actualCost;
				}
				held.settled = true;
				ledger!.reservations.delete(id);
				return true;
			},
		};
		return { status: "reserved", cost, availableBefore: available, reservation };
	};

	const flush = (): Promise<{ status: "persisted" | "memory_only" | "degraded"; reason?: string }> => {
		const run = async () => {
			await initialize();
			pruneHistory();
			const state: PersistedQuotaState = {
				version: 1,
				salt: salt.toString("base64"),
				entries: [...records.values()].map((entry) => ({ ...entry })),
			};
			try {
				const result = await stateStore.save(state);
				if (result.status === "unavailable") {
					persistence = "degraded";
					return { status: "degraded" as const, reason: result.reason };
				}
				if (result.status === "memory_only") {
					persistence = "memory_only";
					return { status: "memory_only" as const };
				}
				persistence = "persistent";
				return { status: "persisted" as const };
			} catch {
				persistence = "degraded";
				return { status: "degraded" as const, reason: "QUOTA_STATE_IO_UNAVAILABLE" };
			}
		};
		const next = flushTail.then(run, run);
		flushTail = next.catch(() => undefined);
		return next;
	};

	const snapshot = (): QuotaSnapshot => {
		const now = clock();
		const cooldowns: QuotaCooldown[] = [];
		for (const record of records.values()) {
			if (record.cleared || record.until <= now) continue;
			cooldowns.push(cooldownFrom(record, now));
		}
		return { persistence, cooldowns: cooldowns.map((entry) => ({ ...entry })) };
	};

	return {
		initialize,
		restore: initialize,
		getCooldown,
		recordFailure,
		recordSuccess,
		lookupBalance,
		getBalance: lookupBalance,
		reserve,
		flush,
		snapshot,
		readonly: {
			balanceCacheMs: BALANCE_CACHE_MS,
			failureCacheMs: FAILURE_CACHE_MS,
		},
	};
}

function safeAdd(left: number, right: number): number {
	const sum = left + right;
	return Number.isSafeInteger(sum) ? sum : Number.MAX_SAFE_INTEGER;
}
