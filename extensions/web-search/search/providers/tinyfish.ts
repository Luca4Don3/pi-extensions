/**
 * TinyFish keyless MCP 匿名搜索适配。
 *
 * 匿名入口只存在于 MCP 端点：不读取、不接受也不发送任何凭据，仅以
 * `X-TinyFish-Access-Mode: keyless` 声明匿名接入。REST 端点必须携带 `X-API-Key`，
 * 且官方文档对「超出每日额度后是否扣减钱包余额」存在相互矛盾的说明，
 * 因此本模块不实现任何认证通道，避免引入无法验证的费用风险。
 */
import { BackendError, type WebSource } from "../../search-core.js";
import { collectSources, normalizeSource, parseResponseObject, type RequestSpec } from "../protocol.js";

/** TinyFish 匿名 MCP 端点；固定地址，不含凭据。 */
export const TINYFISH_MCP_URL = "https://agent.tinyfish.ai/mcp";
/** keyless 唯一暴露的工具名。 */
export const TINYFISH_TOOL_NAME = "search";
/** 匿名接入标识；与认证方式的 `X-API-Key` 严格互斥。 */
export const TINYFISH_ACCESS_MODE = "keyless";

/** 构造零凭据的 `tools/call` 参数；只传查询词。 */
export function buildTinyFishPayload(query: string): { name: string; arguments: { query: string } } {
	return { name: TINYFISH_TOOL_NAME, arguments: { query } };
}

/** 匿名请求头：与 MCP 传输声明一致，只追加 keyless 接入标识。 */
export function buildTinyFishHeaders(): Record<string, string> {
	return {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
		"X-TinyFish-Access-Mode": TINYFISH_ACCESS_MODE,
	};
}

/** 完整的零凭据请求描述，供路由层直接使用。 */
export function buildTinyFishRequest(query: string): RequestSpec {
	return {
		url: TINYFISH_MCP_URL,
		method: "POST",
		headers: buildTinyFishHeaders(),
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: buildTinyFishPayload(query) }),
	};
}

/**
 * 解析 keyless search 的结果负载：`{ query, results[{ position, site_name, title, url, snippet }] }`。
 * 只接受公开字段；`results` 缺失或类型不符时明确失败，不静默返回空结果。
 */
export function parseTinyFishResults(text: string, maxResults: number): WebSource[] {
	const record = parseResponseObject("tinyfish", text);
	if (!Array.isArray(record.results)) {
		throw new BackendError("tinyfish 响应缺少结果数组", "protocol_error");
	}
	return collectSources("tinyfish", record.results, maxResults, (item) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return undefined;
		const result = item as Record<string, unknown>;
		return normalizeSource({
			url: result.url,
			title: result.title,
			snippet: result.snippet,
			publishedAt: result.date,
		});
	});
}
