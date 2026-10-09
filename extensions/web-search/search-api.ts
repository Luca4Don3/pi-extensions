/** Tavily / SerpApi 原生接口适配：请求构造与公开搜索结果归一化。 */
import { BackendError, errorDetailFrom, httpKind, isHttpUrl, messageKind, type WebSource } from "./search-core.js";

export type ApiBackend = "tavily" | "serpapi";

export interface RequestSpec {
	url: string;
	method: "POST" | "GET";
	headers: Record<string, string>;
	body?: string;
}

/** 密钥只出现在官方约定的位置（Tavily 为 Bearer 头，SerpApi 为查询参数）。 */
export function buildApiRequest(backend: ApiBackend, query: string, maxResults: number, key: string): RequestSpec {
	if (backend === "tavily") {
		return {
			url: "https://api.tavily.com/search",
			method: "POST",
			headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}` },
			// 显式 basic + auto_parameters=false，保证固定为 1 积分的基础搜索。
			body: JSON.stringify({
				query,
				max_results: maxResults,
				search_depth: "basic",
				auto_parameters: false,
				include_answer: false,
				include_raw_content: false,
			}),
		};
	}
	const params = new URLSearchParams({ engine: "google", q: query, api_key: key, num: String(maxResults) });
	return {
		url: `https://serpapi.com/search.json?${params.toString()}`,
		method: "GET",
		headers: { accept: "application/json" },
	};
}

/** 按后端专有规则归类 HTTP 错误：Tavily 432 / 433 为额度耗尽，其余沿用通用规则。 */
export function apiHttpKind(backend: string, status: number, detail: string): ReturnType<typeof httpKind> {
	if (backend === "tavily" && (status === 432 || status === 433)) return "quota_exhausted";
	return httpKind(status, detail);
}

/** 只取公开字段；摘要保持完整，截断必须等到脱敏之后再做。 */
function sourceFrom(item: unknown, backend: ApiBackend): WebSource | undefined {
	if (item === null || typeof item !== "object") return undefined;
	const record = item as Record<string, unknown>;
	const link = record[backend === "tavily" ? "url" : "link"];
	if (typeof link !== "string" || !isHttpUrl(link.trim())) return undefined;
	const source: WebSource = { url: link.trim() };
	const pairs: [keyof WebSource, unknown][] = [
		["title", record.title],
		["snippet", record[backend === "tavily" ? "content" : "snippet"]],
		["publishedAt", record[backend === "tavily" ? "published_date" : "date"]],
	];
	for (const [field, value] of pairs) {
		if (typeof value === "string" && value.trim().length > 0) source[field] = value.trim();
	}
	return source;
}

/** 解析原生响应：失败信号优先，结果只保留公开来源字段，并按 url 去重、限制条数。 */
export function parseApiResponse(backend: ApiBackend, body: string, maxResults: number): WebSource[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		throw new BackendError(`${backend} 返回了非法 JSON`, "protocol_error");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new BackendError(`${backend} 响应不是对象`, "protocol_error");
	}
	const record = parsed as Record<string, unknown>;
	const detail = errorDetailFrom(record);
	if (detail !== undefined) throw new BackendError(detail, messageKind(detail) ?? "protocol_error");
	const metadata = record.search_metadata;
	if (
		backend === "serpapi" &&
		metadata !== null &&
		typeof metadata === "object" &&
		(metadata as Record<string, unknown>).status === "Error"
	) {
		throw new BackendError("serpapi 搜索状态为 Error", "protocol_error");
	}
	const items = record[backend === "tavily" ? "results" : "organic_results"];
	if (!Array.isArray(items)) throw new BackendError(`${backend} 响应缺少结果数组`, "protocol_error");
	const seen = new Set<string>();
	const sources: WebSource[] = [];
	for (const item of items) {
		const source = sourceFrom(item, backend);
		if (source === undefined || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
		if (sources.length >= maxResults) break;
	}
	if (sources.length === 0) throw new BackendError(`${backend} 没有可用搜索结果`, "protocol_error");
	return sources;
}
