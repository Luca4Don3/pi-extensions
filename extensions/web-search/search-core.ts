/** 搜索后端共用的结果类型、错误分类与响应校验；不访问网络或凭据。 */

export interface WebSource {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

export type SearchErrorKind =
	| "quota_preflight" | "quota_exhausted" | "rate_limited" | "invalid_key" | "server_error"
	| "network_error" | "timeout" | "aborted" | "protocol_error" | "response_too_large";

/** 带分类的错误；请求层回填实际尝试次数。 */
export class BackendError extends Error {
	attempts = 0;

	constructor(message: string, readonly kind: SearchErrorKind, readonly retryAfterMs?: number) {
		super(message);
		this.name = "BackendError";
	}

	get retryable(): boolean {
		return this.kind === "rate_limited" || this.kind === "server_error" || this.kind === "network_error";
	}
}

export function statusKind(status: number): SearchErrorKind {
	if (status === 401 || status === 403) return "invalid_key";
	if (status === 402) return "quota_exhausted";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server_error";
	return "protocol_error";
}

export function messageKind(message: string): SearchErrorKind | undefined {
	const text = message.toLowerCase();
	if (/quota|credit|balance|insufficient|payment required|no remaining|(?:ran|run) out of searches|monthly.*limit/.test(text)) {
		return "quota_exhausted";
	}
	if (/rate limit|too many requests/.test(text)) return "rate_limited";
	if (/unauthoriz|forbidden|invalid api key|authentication|api key/.test(text)) return "invalid_key";
	return undefined;
}

export function httpKind(status: number, detail: string): SearchErrorKind {
	return messageKind(detail) ?? statusKind(status);
}

/** 只接受可点击的网页链接，不把脚本、本地文件或内联数据当作来源。 */
export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** 提取各服务的错误文本；调用方必须在输出前脱敏。 */
export function errorDetailFrom(payload: unknown): string | undefined {
	if (payload === null || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	for (const candidate of [record.error, record.detail]) {
		if (typeof candidate === "string" && candidate.length > 0) return candidate;
		if (candidate !== null && typeof candidate === "object") {
			const inner = candidate as Record<string, unknown>;
			for (const value of [inner.message, inner.error]) {
				if (typeof value === "string" && value.length > 0) return value;
			}
		}
	}
	return typeof record.message === "string" && record.message.length > 0 ? record.message : undefined;
}
