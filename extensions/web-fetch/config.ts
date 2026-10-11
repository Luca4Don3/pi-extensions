import process from "node:process";
import { FetchError } from "./errors.js";

/**
 * web_fetch 的配置读取与严格校验。
 *
 * 所有取值都来自环境变量，非法配置在发起任何网络请求之前失败，
 * 并且错误文本不回显调用方给出的原值。
 */

/** 默认整次抓取总预算，包含初始解析、所有跳转与正文读取。 */
export const DEFAULT_TIMEOUT_MS = 20_000;
/** 默认解压后响应体上限，与 web-search 的响应体上限保持一致。 */
export const DEFAULT_MAX_RESPONSE_BYTES = 5_242_880;
export const MAX_RESPONSE_BYTES = 20_971_520;
/** 默认模型可见正文字符上限。 */
export const DEFAULT_MAX_CHARS = 24_000;
export const MAX_CHARS_LIMIT = 200_000;
/** 默认最大重定向次数。 */
export const DEFAULT_MAX_REDIRECTS = 3;
export const MAX_REDIRECTS_LIMIT = 5;

/** 当前仅实现本地抓取；远程回退必须保持关闭。 */
export type RemoteFallback = "off";

export interface WebFetchConfig {
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
	readonly maxChars: number;
	readonly maxRedirects: number;
	readonly remoteFallback: RemoteFallback;
}

/** 读取十进制正整数；空白允许，其他字符一律拒绝。 */
function readPositiveInt(source: Record<string, string | undefined>, name: string, fallback: number, max: number): number {
	const raw = source[name];
	if (raw === undefined) return fallback;
	const trimmed = raw.trim();
	if (!/^\d+$/u.test(trimmed)) throw new Error(`${name} 必须是十进制正整数`);
	const value = Number(trimmed);
	if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name} 超出允许范围`);
	return value;
}

/** 远程回退开关只接受白名单字面量；未设置时默认关闭。 */
function readRemoteFallback(source: Record<string, string | undefined>): RemoteFallback {
	const raw = source.PI_WEB_FETCH_REMOTE_FALLBACK;
	if (raw === undefined) return "off";
	const trimmed = raw.trim().toLowerCase();
	if (trimmed === "jina") throw new FetchError("远程回退尚未实现，请将 PI_WEB_FETCH_REMOTE_FALLBACK 设为 off", "remote_blocked");
	if (trimmed !== "off") throw new Error("PI_WEB_FETCH_REMOTE_FALLBACK 当前只接受 off");
	return "off";
}

/** 从环境变量读取抓取配置；未设置时全部使用默认值。 */
export function readWebFetchConfig(source: Record<string, string | undefined> = process.env): WebFetchConfig {
	return {
		timeoutMs: readPositiveInt(source, "PI_WEB_FETCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 60_000),
		maxResponseBytes: readPositiveInt(source, "PI_WEB_FETCH_MAX_RESPONSE_BYTES", DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES),
		maxChars: readPositiveInt(source, "PI_WEB_FETCH_MAX_CHARS", DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT),
		maxRedirects: readPositiveInt(source, "PI_WEB_FETCH_MAX_REDIRECTS", DEFAULT_MAX_REDIRECTS, MAX_REDIRECTS_LIMIT),
		remoteFallback: readRemoteFallback(source),
	};
}
