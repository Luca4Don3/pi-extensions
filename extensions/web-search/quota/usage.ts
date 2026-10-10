/** Tavily / Firecrawl 官方额度接口的严格离线解析与有界查询。 */
import { BackendError } from "../search-core.js";
import { DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES, readResponseTextLimited } from "../response-body.js";
import type { QuotaBackend } from "./state-store.js";

export type QuotaUnknownReason =
	| "authorization_required" | "unsupported_backend" | "lookup_failed" | "invalid_response"
	| "timeout" | "aborted" | "rate_limited";

export type QuotaLookupResult =
	| { state: "known"; remaining: number; eligibility: "not_verified"; observedAt?: number }
	| { state: "unknown"; reason: QuotaUnknownReason; retryAfterMs?: number };

export interface QuotaLookupInput {
	backend: QuotaBackend;
	credential: string;
	allowBillable: boolean;
	signal?: AbortSignal;
}

export interface QuotaLookupOptions {
	deadlineMs?: number;
	maxResponseBytes?: number;
	clock?: () => number;
	fetch?: typeof globalThis.fetch;
}

const MAX_DEADLINE_MS = 60_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const NOT_AUTHORIZED: QuotaLookupResult = { state: "unknown", reason: "authorization_required" };

function safeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function remaining(usage: unknown, limit: unknown): number | undefined {
	if (!safeInteger(usage) || !safeInteger(limit)) return undefined;
	return Math.max(0, limit - usage);
}

function accountRemaining(account: unknown): number | undefined {
	if (account === null || typeof account !== "object" || Array.isArray(account)) return undefined;
	const row = account as Record<string, unknown>;
	const plan = remaining(row.plan_usage, row.plan_limit);
	const paygo = remaining(row.paygo_usage, row.paygo_limit);
	if (plan === undefined || paygo === undefined || !Number.isSafeInteger(plan + paygo)) return undefined;
	return plan + paygo;
}

/** key.limit 明确为 null 仅表示没有 key 专属上限；账户计划与按量余额仍须有限且可验证。 */
export function parseTavilyUsage(value: unknown): QuotaLookupResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { state: "unknown", reason: "invalid_response" };
	const row = value as Record<string, unknown>;
	if (row.key === null || typeof row.key !== "object" || Array.isArray(row.key)) return { state: "unknown", reason: "invalid_response" };
	const key = row.key as Record<string, unknown>;
	const account = accountRemaining(row.account);
	if (account === undefined) return { state: "unknown", reason: "invalid_response" };
	if (key.limit === null) {
		return { state: "known", remaining: account, eligibility: "not_verified" };
	}
	const keyRemaining = remaining(key.usage, key.limit);
	if (keyRemaining === undefined) return { state: "unknown", reason: "invalid_response" };
	return { state: "known", remaining: Math.min(keyRemaining, account), eligibility: "not_verified" };
}

/** Firecrawl 的 planCredits 与账期日期不能证明剩余额度或免费资格。 */
export function parseFirecrawlUsage(value: unknown): QuotaLookupResult {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { state: "unknown", reason: "invalid_response" };
	const row = value as Record<string, unknown>;
	if (row.success !== true || row.data === null || typeof row.data !== "object" || Array.isArray(row.data)) {
		return { state: "unknown", reason: "invalid_response" };
	}
	const remainingCredits = (row.data as Record<string, unknown>).remainingCredits;
	if (!safeInteger(remainingCredits)) return { state: "unknown", reason: "invalid_response" };
	return { state: "known", remaining: remainingCredits, eligibility: "not_verified" };
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
	if (value === null || value.trim().length === 0) return undefined;
	const seconds = Number(value.trim());
	let ms: number;
	if (Number.isFinite(seconds) && seconds >= 0) ms = Math.ceil(seconds * 1000);
	else {
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) return undefined;
		ms = Math.max(0, timestamp - now);
	}
	return Math.min(ms, MAX_RETRY_AFTER_MS);
}

function unknown(reason: QuotaUnknownReason, retryAfterMs?: number): QuotaLookupResult {
	return { state: "unknown", reason, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}

function cancelBody(response: Response): void {
	try {
		const cancel = response.body?.cancel();
		if (cancel !== undefined) void Promise.resolve(cancel).catch(() => undefined);
	} catch {
		// 清理失败不能覆盖固定额度诊断。
	}
}

function fixedUrl(backend: QuotaBackend): string | undefined {
	if (backend === "tavily") return "https://api.tavily.com/usage";
	if (backend === "firecrawl") return "https://api.firecrawl.dev/v2/team/credit-usage";
	return undefined;
}

/** 仅明确授权的 key 可调用；单次 GET 的总期限覆盖 fetch 与有界解压正文读取。 */
export async function lookupUsage(input: QuotaLookupInput, options: QuotaLookupOptions = {}): Promise<QuotaLookupResult> {
	if (input.allowBillable !== true || typeof input.credential !== "string" || input.credential.length === 0) return NOT_AUTHORIZED;
	const url = fixedUrl(input.backend);
	if (url === undefined) return unknown("unsupported_backend");
	const deadlineMs = options.deadlineMs ?? 2_000;
	const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
	if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > MAX_DEADLINE_MS) throw new Error("QUOTA_LOOKUP_INVALID_DEADLINE");
	if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) throw new Error("QUOTA_LOOKUP_INVALID_BODY_LIMIT");
	const fetcher = options.fetch ?? globalThis.fetch;
	const now = options.clock ?? Date.now;
	if (input.signal?.aborted) return unknown("aborted");

	const controller = new AbortController();
	let timedOut = false;
	let externallyAborted = false;
	let resolveAbort!: (kind: "timeout" | "aborted") => void;
	const abortResult = new Promise<{ type: "abort"; kind: "timeout" | "aborted" }>((resolve) => {
		resolveAbort = (kind) => resolve({ type: "abort", kind });
	});
	const onExternalAbort = (): void => {
		externallyAborted = true;
		controller.abort();
		resolveAbort("aborted");
	};
	input.signal?.addEventListener("abort", onExternalAbort, { once: true });
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
		resolveAbort("timeout");
	}, deadlineMs);

	try {
		if (input.signal?.aborted) {
			onExternalAbort();
			return unknown("aborted");
		}
		const pendingFetch = Promise.resolve().then(() => fetcher(url, {
			method: "GET",
			headers: { accept: "application/json", authorization: `Bearer ${input.credential}` },
			signal: controller.signal,
		})).then((response) => {
			if (externallyAborted || timedOut || controller.signal.aborted) cancelBody(response);
			return response;
		});
		// fetch 即使忽略 signal 并迟到拒绝，也始终有 rejection handler。
		void pendingFetch.catch(() => undefined);
		const fetched = await Promise.race([
			pendingFetch.then((response) => ({ type: "response" as const, response }), () => ({ type: "failed" as const })),
			abortResult,
		]);
		if (fetched.type === "abort") return unknown(fetched.kind);
		if (fetched.type === "failed") return unknown("lookup_failed");
		if (externallyAborted || input.signal?.aborted) return unknown("aborted");
		if (timedOut) return unknown("timeout");
		const response = fetched.response;
		if (externallyAborted || input.signal?.aborted) {
			cancelBody(response);
			return unknown("aborted");
		}
		if (timedOut) {
			cancelBody(response);
			return unknown("timeout");
		}
		if (response.status === 429) {
			const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), now());
			cancelBody(response);
			controller.abort();
			return unknown("rate_limited", retryAfterMs);
		}
		if (!response.ok) {
			cancelBody(response);
			controller.abort();
			return unknown("lookup_failed");
		}
		let body: string;
		try {
			body = await readResponseTextLimited(response, maxResponseBytes, controller);
		} catch (error) {
			if (controller.signal.aborted) cancelBody(response);
			if (externallyAborted || input.signal?.aborted) return unknown("aborted");
			if (timedOut) return unknown("timeout");
			if (error instanceof BackendError && error.kind === "response_too_large") return unknown("invalid_response");
			return unknown("lookup_failed");
		}
		if (timedOut) return unknown("timeout");
		if (input.signal?.aborted) return unknown("aborted");
		let payload: unknown;
		try { payload = JSON.parse(body); } catch { return unknown("invalid_response"); }
		const parsed = input.backend === "tavily" ? parseTavilyUsage(payload) : parseFirecrawlUsage(payload);
		return parsed.state === "known" ? { ...parsed, observedAt: now() } : parsed;
	} finally {
		clearTimeout(timer);
		input.signal?.removeEventListener("abort", onExternalAbort);
		if (!controller.signal.aborted) controller.abort();
	}
}
