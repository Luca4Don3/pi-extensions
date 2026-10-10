/** SerpApi REST 请求与 Google organic_results 响应适配。 */
import { BackendError, type WebSource } from "../../search-core.js";
import {
	collectSources,
	normalizeSource,
	parseResponseObject,
	requireKey,
	type ApiChannel,
	type RequestSpec,
} from "../protocol.js";

export function buildSerpApiRequest(
	query: string,
	maxResults: number,
	key: string | undefined,
	channel: ApiChannel,
): RequestSpec {
	const apiKey = requireKey("serpapi", key, channel);
	const params = new URLSearchParams({ engine: "google", q: query, api_key: apiKey, num: String(maxResults) });
	return {
		url: `https://serpapi.com/search.json?${params.toString()}`,
		method: "GET",
		headers: { accept: "application/json" },
	};
}

export function parseSerpApiResponse(body: string, maxResults: number): WebSource[] {
	const record = parseResponseObject("serpapi", body);
	const metadata = record.search_metadata;
	if (
		metadata !== null &&
		typeof metadata === "object" &&
		(metadata as Record<string, unknown>).status === "Error"
	) {
		throw new BackendError("serpapi 搜索状态为 Error", "protocol_error");
	}
	if (!Array.isArray(record.organic_results)) {
		throw new BackendError("serpapi 响应缺少结果数组", "protocol_error");
	}
	return collectSources("serpapi", record.organic_results, maxResults, (item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
		const result = item as Record<string, unknown>;
		return normalizeSource({
			url: result.link,
			title: result.title,
			snippet: result.snippet,
			publishedAt: result.date,
		});
	});
}
