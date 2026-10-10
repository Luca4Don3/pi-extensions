/** 原生 REST 服务提供方的共用协议；只负责离线解析，不执行网络请求。 */
import {
	BackendError,
	errorDetailFrom,
	isHttpUrl,
	messageKind,
	type WebSource,
} from "../search-core.js";

export interface RequestSpec {
	url: string;
	method: "POST" | "GET";
	headers: Record<string, string>;
	body?: string;
}

export type ApiChannel = "free" | "key";

/** 检查通道凭据组合，不在错误文本中包含凭据。 */
export function requireKey(backend: string, key: string | undefined, channel: ApiChannel): string {
	if (channel === "free") {
		if (key !== undefined && key.length > 0) {
			throw new BackendError(`${backend} 的免费通道不得传入密钥`, "invalid_key");
		}
		throw new BackendError(`${backend} 不支持免费通道`, "invalid_key");
	}
	if (channel !== "key") throw new BackendError(`${backend} 通道无效`, "protocol_error");
	if (key === undefined || key.trim().length === 0) {
		throw new BackendError(`${backend} 未配置密钥`, "invalid_key");
	}
	return key;
}

/** 为可免费使用的服务验证通道，确保密钥不会误入免费请求。 */
export function validateOptionalKey(backend: string, key: string | undefined, channel: ApiChannel): string | undefined {
	if (channel === "free") {
		if (key !== undefined && key.length > 0) {
			throw new BackendError(`${backend} 的免费通道不得传入密钥`, "invalid_key");
		}
		return undefined;
	}
	if (channel !== "key") throw new BackendError(`${backend} 通道无效`, "protocol_error");
	return requireKey(backend, key, "key");
}

/** 解码响应对象，统一拒绝 JSON 错误、错误字段与失败标记。 */
export function parseResponseObject(backend: string, body: string): Record<string, unknown> {
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
	if (detail !== undefined) {
		throw new BackendError(detail, messageKind(detail) ?? "protocol_error");
	}
	if (["error", "detail", "message"].some((field) => Object.prototype.hasOwnProperty.call(record, field))) {
		throw new BackendError(`${backend} 响应包含错误字段`, "protocol_error");
	}
	if (record.success === false) {
		throw new BackendError(`${backend} 响应标记为失败`, "protocol_error");
	}
	return record;
}

export interface SourceFields {
	url: unknown;
	title?: unknown;
	snippet?: unknown;
	publishedAt?: unknown;
}

/** 将服务字段映射为仅含公开字段的来源；摘要保留原始完整长度。 */
export function normalizeSource(fields: SourceFields): WebSource | undefined {
	if (typeof fields.url !== "string") return undefined;
	const url = fields.url.trim();
	if (!isHttpUrl(url)) return undefined;
	const source: WebSource = { url };
	for (const [field, value] of [
		["title", fields.title],
		["snippet", fields.snippet],
		["publishedAt", fields.publishedAt],
	] as const) {
		if (typeof value === "string" && value.trim().length > 0) source[field] = value.trim();
	}
	return source;
}

/** 校验结果数组、清理链接并按 URL 去重和限制数量。 */
export function collectSources(
	backend: string,
	items: unknown[],
	maxResults: number,
	mapItem: (item: unknown) => WebSource | undefined,
): WebSource[] {
	const limit = Number.isFinite(maxResults) ? Math.max(0, Math.floor(maxResults)) : 0;
	if (limit === 0) throw new BackendError(`${backend} 没有可用搜索结果`, "protocol_error");
	const seen = new Set<string>();
	const sources: WebSource[] = [];
	for (const item of items) {
		const source = mapItem(item);
		if (source === undefined || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
		if (sources.length >= limit) break;
	}
	if (sources.length === 0) throw new BackendError(`${backend} 没有可用搜索结果`, "protocol_error");
	return sources;
}
