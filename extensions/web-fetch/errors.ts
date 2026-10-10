/**
 * web_fetch 的抓取错误类型与分类。
 *
 * 与 web-search 的错误分类刻意保持相似但相互独立：两个扩展可分别安装，
 * 不互相 import，避免升级其中一个破坏另一个。
 */

/** 抓取失败的固定分类；`details.errorKind` 只使用这些值。 */
export type FetchErrorKind =
	| "invalid_url"
	| "blocked_url"
	| "http_error"
	| "network_error"
	| "timeout"
	| "aborted"
	| "response_too_large"
	| "unsupported_content"
	| "extraction_failed"
	| "remote_unavailable"
	| "remote_blocked";

/** 带分类的抓取错误；分类是固定字符串，不回显调用方输入或上游原文。 */
export class FetchError extends Error {
	constructor(
		message: string,
		readonly kind: FetchErrorKind,
		readonly options?: { readonly statusCode?: number; readonly retryAfterMs?: number },
	) {
		super(message);
		this.name = "FetchError";
	}

	get retryable(): boolean {
		return this.kind === "remote_unavailable" || this.kind === "network_error";
	}
}

/** 把未知异常统一收敛为带分类的抓取错误；异常原文不进入分类。 */
export function toFetchError(error: unknown, fallbackKind: FetchErrorKind = "network_error"): FetchError {
	if (error instanceof FetchError) return error;
	return new FetchError("抓取失败", fallbackKind);
}
