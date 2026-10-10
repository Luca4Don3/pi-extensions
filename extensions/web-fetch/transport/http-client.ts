/**
 * 安全的有界 HTTP 传输。
 *
 * 关键约束：
 * - 目标地址必须来自 `resolveFetchTarget`，随后**只连接那个已校验的 IP**，
 *   不让 HTTP 客户端按主机名重新解析，关闭 DNS 重绑定窗口。
 * - 重定向手动跟随，每一跳都重新走一遍完整的目标校验。
 * - 只发送固定的请求头，不携带 Cookie、Authorization 或调用方提供的头。
 * - 超时、外部取消与响应体上限各自生效，互不掩盖。
 */

import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { FetchError, type FetchErrorKind } from "../errors.js";
import { resolveFetchTarget, type ResolvedTarget } from "./url-policy.js";
import { readResponseTextLimited } from "./response-body.js";

export interface HttpFetchRequest {
	/** 规范化后的目标 URL。 */
	readonly url: URL;
	/** 已校验的目标地址；连接只允许使用它。 */
	readonly target: ResolvedTarget;
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
	readonly maxResponseBytes: number;
	/**
	 * 目标解析注入点；默认使用 `resolveFetchTarget`。
	 * 测试用它在不放弃安全语义的前提下驱动本地服务器。
	 */
	readonly resolveTarget?: (url: string) => Promise<ResolvedTarget>;
}

export interface HttpFetchResponse {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly finalUrl: URL;
	readonly redirectCount: number;
}

/** 只发送固定请求头，不转发调用方任何头。 */
export function buildHeaders(url: URL): Record<string, string> {
	return {
		accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		"accept-encoding": "gzip, deflate",
		"user-agent": "pi-web-fetch/0.1.0-beta.1",
		host: url.host,
	};
}

/** 取出响应头中的跳转目标；相对地址按当前 URL 解析。 */
function redirectLocation(url: URL, headers: Record<string, string>): string | undefined {
	const location = headers.location ?? headers["content-location"];
	if (location === undefined) return undefined;
	try {
		return new URL(location, url).toString();
	} catch {
		return undefined;
	}
}

/** 单次请求；不使用跟随重定向的 fetch，保证每一跳都被校验。 */
function requestOnce(
	target: ResolvedTarget,
	headers: Record<string, string>,
	controller: AbortController,
): Promise<{ status: number; headers: Record<string, string>; raw: import("node:http").IncomingMessage }> {
	const isTls = target.url.protocol === "https:";
	const impl = isTls ? request : httpRequest;
	return new Promise((resolve, reject) => {
		const req = impl(
			{
				protocol: target.url.protocol,
				hostname: target.address,
				port: target.url.port.length > 0 ? Number(target.url.port) : isTls ? 443 : 80,
				path: `${target.url.pathname}${target.url.search}`,
				method: "GET",
				headers,
				// 连接必须落在已校验的地址上；这里不再做任何域名解析。
				lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
				...(isTls ? { servername: target.url.hostname } : {}),
			},
			(response) => resolve({ status: response.statusCode ?? 0, headers: response.headers as Record<string, string>, raw: response }),
		);
		req.on("error", reject);
		req.end();
		controller.signal.addEventListener("abort", () => req.destroy(), { once: true });
	});
}

/** 按 content-encoding 先解压；Node 原生 http 不像 fetch 那样自动解压。 */
function decodeBody(raw: import("node:http").IncomingMessage): Readable {
	const encoding = (raw.headers["content-encoding"] ?? "").toString().trim().toLowerCase();
	if (encoding === "gzip" || encoding === "x-gzip") return raw.pipe(createGunzip());
	if (encoding === "deflate") return raw.pipe(createInflate());
	if (encoding === "br") return raw.pipe(createBrotliDecompress());
	return raw;
}

/**
 * 把 Node 响应流转成 Fetch Response，复用同一套有界解码逻辑。
 * 已解压的正文不再带原始的 content-encoding 与 content-length，避免与流长度不符。
 */
function toWebResponse(raw: import("node:http").IncomingMessage, status: number): Response {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw.headers)) {
		const lower = name.toLowerCase();
		if (lower === "content-encoding" || lower === "content-length") continue;
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) headers.set(name, value.join(", "));
	}
	return new Response(Readable.toWeb(decodeBody(raw)) as unknown as BodyInit, { status, headers });
}

/** 带重定向与预算控制的一次完整抓取。 */
export async function httpFetch(input: HttpFetchRequest): Promise<HttpFetchResponse> {
	const startedAt = Date.now();
	const resolve = input.resolveTarget ?? resolveFetchTarget;
	let current = input.target;
	let redirectCount = 0;
	let url = current.url;

	for (;;) {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, input.timeoutMs);
		const onExternalAbort = (): void => controller.abort(input.signal?.reason);
		if (input.signal?.aborted) {
			clearTimeout(timer);
			throw new FetchError("操作已取消", "aborted");
		}
		input.signal?.addEventListener("abort", onExternalAbort, { once: true });
		try {
			const { status, headers, raw } = await requestOnce(current, buildHeaders(url), controller);
			if (status >= 300 && status < 400) {
				const location = redirectLocation(url, headers);
				raw.resume();
				if (location === undefined || redirectCount >= MAX_REDIRECTS) {
					throw new FetchError("重定向不可用或次数超限", "blocked_url");
				}
				// 每一跳都重新校验协议、地址与端口，绝不复用上一跳的结论。
				current = await resolve(location);
				url = current.url;
				redirectCount += 1;
				continue;
			}
			if (status === 401 || status === 403) throw new FetchError("目标要求认证", "http_error", { statusCode: status });
			if (status === 404) throw new FetchError("目标不存在", "http_error", { statusCode: status });
			if (status === 429) {
				throw new FetchError("目标限流", "http_error", { statusCode: status, retryAfterMs: parseRetryAfter(headers["retry-after"]) });
			}
			if (status >= 500) throw new FetchError("目标服务端错误", "http_error", { statusCode: status });
			if (status !== 200) throw new FetchError("目标返回了不受支持的状态", "http_error", { statusCode: status });

			const response = toWebResponse(raw, status);
			const body = await readResponseTextLimited(response, input.maxResponseBytes, controller);
			if (body.length === 0) throw new FetchError("目标没有返回正文", "extraction_failed");
			return {
				status,
				headers: Object.fromEntries(Object.entries(raw.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>,
				body,
				finalUrl: url,
				redirectCount,
			};
		} catch (error) {
			if (input.signal?.aborted) throw new FetchError("操作已取消", "aborted");
			if (timedOut) throw new FetchError("抓取超时", "timeout");
			if (error instanceof FetchError) throw error;
			// 目标解析（含每一跳重定向）失败时沿用其分类，不把安全拒绝降级成网络错误。
			const kind = (error as { kind?: string } | undefined)?.kind;
			if (typeof kind === "string") throw new FetchError("目标不可达", kind as FetchErrorKind);
			throw new FetchError("抓取失败", "network_error");
		} finally {
			clearTimeout(timer);
			input.signal?.removeEventListener("abort", onExternalAbort);
		}
		if (Date.now() - startedAt > MAX_TOTAL_MS) throw new FetchError("抓取超时", "timeout");
	}
}

const MAX_REDIRECTS = 3;
const MAX_TOTAL_MS = 20_000;

/** 解析 Retry-After 的秒与 HTTP 日期两种形式。 */
function parseRetryAfter(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return undefined;
	return Math.max(0, timestamp - Date.now());
}
