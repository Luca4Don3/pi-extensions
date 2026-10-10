/** 原生 REST 服务提供方的薄兼容分发层；不执行网络请求。 */
import { httpKind, type SearchErrorKind, type WebSource } from "./search-core.js";
import { parseFirecrawlResponse, buildFirecrawlRequest } from "./search/providers/firecrawl.js";
import { parseSerpApiResponse, buildSerpApiRequest } from "./search/providers/serpapi.js";
import { parseTavilyResponse, buildTavilyRequest } from "./search/providers/tavily.js";
import type { ApiChannel, RequestSpec } from "./search/protocol.js";

export type ApiBackend = "tavily" | "firecrawl" | "serpapi";
export type { RequestSpec } from "./search/protocol.js";

type ProviderAdapter = {
	build: (query: string, maxResults: number, key: string | undefined, channel: ApiChannel) => RequestSpec;
	parse: (body: string, maxResults: number) => WebSource[];
	httpKind: (status: number, detail: string) => SearchErrorKind;
};

/** 单一服务提供方表同时驱动识别、请求构造、解析与 HTTP 错误分类。 */
const API_PROVIDERS: Record<ApiBackend, ProviderAdapter> = {
	tavily: {
		build: buildTavilyRequest,
		parse: parseTavilyResponse,
		httpKind: (status, detail) => (status === 432 || status === 433 ? "quota_exhausted" : httpKind(status, detail)),
	},
	firecrawl: {
		build: buildFirecrawlRequest,
		parse: parseFirecrawlResponse,
		httpKind: (status, detail) =>
			status === 402 ? "quota_exhausted" : status === 429 ? "rate_limited" : httpKind(status, detail),
	},
	serpapi: {
		build: buildSerpApiRequest,
		parse: parseSerpApiResponse,
		httpKind,
	},
};

export function isApiBackend(backend: string): backend is ApiBackend {
	return Object.prototype.hasOwnProperty.call(API_PROVIDERS, backend);
}

/** 兼容统一入口的 REST 请求构造；免费通道与密钥通道严格隔离。 */
export function buildApiRequest(
	backend: ApiBackend,
	query: string,
	numResults: number,
	key?: string,
	channel: ApiChannel = "key",
): RequestSpec {
	return API_PROVIDERS[backend].build(query, numResults, key, channel);
}

/** 保留统一入口使用的原生响应解析接口。 */
export function parseApiResponse(backend: ApiBackend, body: string, maxResults: number): WebSource[] {
	return API_PROVIDERS[backend].parse(body, maxResults);
}

/** 按服务提供方规则分类 HTTP 错误，其余情况沿用通用分类。 */
export function apiHttpKind(backend: string, status: number, detail: string): SearchErrorKind {
	return isApiBackend(backend) ? API_PROVIDERS[backend].httpKind(status, detail) : httpKind(status, detail);
}
