/** 有界读取上游响应正文，避免无上限缓冲远端数据。 */

import { BackendError } from "./search-core.js";

export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

const INVALID_CONFIG_MESSAGE = `PI_WEB_SEARCH_MAX_RESPONSE_BYTES must be a decimal integer from 1 to ${MAX_RESPONSE_BYTES}`;
const INVALID_LIMIT_MESSAGE = `maxBytes must be an integer from 1 to ${MAX_RESPONSE_BYTES}`;
const TOO_LARGE_MESSAGE = "Web search response body exceeded the configured byte limit";

function isValidLimit(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 1 && value <= MAX_RESPONSE_BYTES;
}

/** 读取响应体字节上限配置；设置了非法值时拒绝在读取凭据或发起请求前继续。 */
export function readMaxResponseBytes(env: Record<string, string | undefined> = process.env): number {
	const raw = env.PI_WEB_SEARCH_MAX_RESPONSE_BYTES;
	if (raw === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
	const value = raw.trim();
	if (!/^\d+$/.test(value)) throw new Error(INVALID_CONFIG_MESSAGE);
	const parsed = Number(value);
	if (!isValidLimit(parsed)) throw new Error(INVALID_CONFIG_MESSAGE);
	return parsed;
}

/**
 * 按流累计 UTF-8 字节数并增量解码。取消和超限时均中止请求、取消 reader，
 * 且不等待底层取消完成，避免不遵守 AbortSignal 的模拟流拖住调用方。
 */
export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	controller: AbortController,
): Promise<string> {
	if (!isValidLimit(maxBytes)) throw new Error(INVALID_LIMIT_MESSAGE);
	if (controller.signal.aborted) throw createReadAbortError();
	const body = response.body;
	if (controller.signal.aborted) throw createReadAbortError();
	if (body === null) return "";

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch (error) {
		controller.abort();
		throw error;
	}

	type ReadOutcome =
		| { type: "read"; value: ReadableStreamReadResult<Uint8Array> }
		| { type: "error"; error: unknown }
		| { type: "abort" };
	let resolveAbort!: () => void;
	const abortPromise = new Promise<ReadOutcome>((resolve) => {
		resolveAbort = () => resolve({ type: "abort" });
	});
	let cancelled = false;
	let released = false;
	let completed = false;
	let pendingRead: Promise<ReadOutcome> | undefined;

	const releaseLock = (): void => {
		if (released) return;
		try {
			reader.releaseLock();
			released = true;
		} catch {
			// 有挂起 read 时，待其迟到完成后再释放。
		}
	};
	const cancelReader = (): void => {
		if (!cancelled) {
			cancelled = true;
			try {
				void Promise.resolve(reader.cancel()).catch(() => {}).finally(releaseLock);
			} catch {
				// 清理错误不能覆盖主错误。
			}
		}
		releaseLock();
	};
	const onAbort = (): void => {
		cancelReader();
		resolveAbort();
	};
	const signal = controller.signal;
	signal.addEventListener("abort", onAbort, { once: true });

	try {
		if (signal.aborted) {
			onAbort();
			throw createReadAbortError();
		}
		const decoder = new TextDecoder();
		const parts: string[] = [];
		let totalBytes = 0;

		for (;;) {
			let read: Promise<ReadableStreamReadResult<Uint8Array>>;
			try {
				read = Promise.resolve(reader.read());
			} catch (error) {
				throw signal.aborted ? createReadAbortError() : error;
			}
			const outcome: Promise<ReadOutcome> = read.then(
				(value) => ({ type: "read", value }),
				(error) => ({ type: "error", error }),
			);
			void outcome.then(() => {
				if (cancelled) releaseLock();
			});
			pendingRead = outcome;
			const result = await Promise.race([outcome, abortPromise]);
			pendingRead = undefined;
			if (signal.aborted || result.type === "abort") throw createReadAbortError();
			if (result.type === "error") throw result.error;
			if (result.value.done) {
				const tail = decoder.decode();
				if (tail.length > 0) parts.push(tail);
				completed = true;
				return parts.join("");
			}

			totalBytes += result.value.value.byteLength;
			if (totalBytes > maxBytes) {
				controller.abort();
				cancelReader();
				throw new BackendError(TOO_LARGE_MESSAGE, "response_too_large");
			}
			const decoded = decoder.decode(result.value.value, { stream: true });
			if (decoded.length > 0) parts.push(decoded);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		if (!completed && !signal.aborted) controller.abort();
		if (!completed && !cancelled) cancelReader();
		releaseLock();
		// 即使取消后底层 read 迟到拒绝，也已被 outcome.then 的拒绝分支消费。
		if (pendingRead !== undefined) void pendingRead.then(releaseLock, releaseLock);
	}
}

function createReadAbortError(): DOMException {
	return new DOMException("Response body reading aborted", "AbortError");
}
