/** Firecrawl REST 请求与响应适配。 */
import { BackendError, type WebSource } from "../../search-core.js";
import {
	collectSources,
	normalizeSource,
	parseResponseObject,
	type ApiChannel,
	type RequestSpec,
	validateOptionalKey,
} from "../protocol.js";

export function buildFirecrawlRequest(
	query: string,
	maxResults: number,
	key: string | undefined,
	channel: ApiChannel,
): RequestSpec {
	const apiKey = validateOptionalKey("firecrawl", key, channel);
	const headers: Record<string, string> = {
		accept: "application/json",
		"content-type": "application/json",
	};
	if (channel === "key") headers.authorization = `Bearer ${apiKey}`;
	return {
		url: "https://api.firecrawl.dev/v2/search",
		method: "POST",
		headers,
		body: JSON.stringify({ query, limit: maxResults, sources: ["web"] }),
	};
}

export function parseFirecrawlResponse(body: string, maxResults: number): WebSource[] {
	const record = parseResponseObject("firecrawl", body);
	if (record.data === null || typeof record.data !== "object" || Array.isArray(record.data)) {
		throw new BackendError("firecrawl 响应缺少 data 对象", "protocol_error");
	}
	const data = record.data as Record<string, unknown>;
	if (!Array.isArray(data.web)) {
		throw new BackendError("firecrawl 响应缺少 data.web 数组", "protocol_error");
	}
	return collectSources("firecrawl", data.web, maxResults, (item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
		const result = item as Record<string, unknown>;
		return normalizeSource({
			url: result.url,
			title: result.title,
			snippet: result.description,
			publishedAt:
				typeof result.publish_date === "string" && result.publish_date.trim().length > 0
					? result.publish_date
					: result.publishedAt,
		});
	});
}
