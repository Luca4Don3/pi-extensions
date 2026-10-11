/** 安全的有界 HTTP 传输：逐跳校验目标，并在请求全程共享绝对截止时间。 */

import { request } from "node:https";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { pipeline, Readable, type Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { FetchError, type FetchErrorKind } from "../errors.js";
import { createFetchDeadline } from "./deadline.js";
import { resolveFetchTarget, type ResolvedTarget } from "./url-policy.js";
import { readResponseTextLimited } from "./response-body.js";

export interface HttpFetchRequest {
	/** 规范化后的目标 URL。 */
	readonly url: URL;
	/** 已校验的目标地址；连接只允许使用它。 */
	readonly target: ResolvedTarget;
	readonly signal?: AbortSignal;
	readonly timeoutMs: number;
	/** 可传入先前创建的截止时刻，避免初始 DNS 后重置预算。 */
	readonly deadlineMs?: number;
	readonly maxResponseBytes: number;
	/** 重定向上限，默认 3。 */
	readonly maxRedirects?: number;
	/** 每一跳重新解析目标；默认策略会使用 signal 取消 DNS 等待。 */
	readonly resolveTarget?: (url: string, signal?: AbortSignal) => Promise<ResolvedTarget>;
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
		"accept-encoding": "gzip, deflate, br",
		"user-agent": "pi-web-fetch/0.1.0-beta.2",
		host: url.host,
	};
}

/** 只接受真正的 Location 头；相对地址按当前 URL 解析。 */
function redirectLocation(url: URL, headers: IncomingMessage["headers"]): string | undefined {
	const header = headers.location;
	const location = Array.isArray(header) ? header[0] : header;
	if (location === undefined) return undefined;
	try {
		return new URL(location, url).toString();
	} catch {
		return undefined;
	}
}

function signalError(signal: AbortSignal): Error {
	const reason = signal.reason;
	return reason instanceof Error ? reason : new FetchError("操作已取消", "aborted");
}

interface RequestHandle {
	readonly status: number;
	readonly headers: IncomingMessage["headers"];
	readonly raw: IncomingMessage;
	cleanup(): void;
}

/** 单次请求；lookup 始终绑定到已校验 IP，abort listener 保留至正文清理结束。 */
function requestOnce(
	target: ResolvedTarget,
	headers: Record<string, string>,
	signal: AbortSignal,
): Promise<RequestHandle> {
	if (signal.aborted) return Promise.reject(signalError(signal));
	const isTls = target.url.protocol === "https:";
	const impl = isTls ? request : httpRequest;
	return new Promise((resolve, reject) => {
		let settled = false;
		let raw: IncomingMessage | undefined;
		let detached = false;
		let req: ReturnType<typeof request> | undefined;
		const onAbort = (): void => { req?.destroy(signalError(signal)); };
		const onRawError = (): void => undefined;
		const cleanup = (): void => {
			if (detached) return;
			detached = true;
			signal.removeEventListener("abort", onAbort);
			req?.removeListener("error", onRequestError);
			raw?.removeListener("error", onRawError);
		};
		const onRequestError = (error: Error): void => {
			if (!settled) {
				settled = true;
				cleanup();
				reject(error);
			} else if (raw !== undefined && !raw.destroyed) {
				raw.destroy(error);
			}
		};
		try {
			req = impl(
				{
					protocol: target.url.protocol,
					hostname: target.address,
					port: target.url.port.length > 0 ? Number(target.url.port) : isTls ? 443 : 80,
					path: `${target.url.pathname}${target.url.search}`,
					method: "GET",
					headers,
					// 连接只使用已校验 IP，不让 HTTP 客户端重新解析主机名。
					lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
					...(isTls ? { servername: target.url.hostname } : {}),
				},
				(response) => {
					if (settled) {
						response.destroy();
						return;
					}
					settled = true;
					raw = response;
					raw.on("error", onRawError);
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						raw: response,
						cleanup,
					});
				},
			);
			req!.on("error", onRequestError);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
			else req!.end();
		} catch (error) {
			if (req !== undefined) cleanup();
			if (!settled) {
				settled = true;
				reject(error);
			}
		}
	});
}

/** 解压流通过 pipeline 关联源与变换流，确保任一端错误都会销毁另一端。 */
function decodeBody(raw: IncomingMessage): Readable {
	const encoding = (raw.headers["content-encoding"] ?? "").toString().trim().toLowerCase();
	if (encoding.length === 0 || encoding === "identity") return raw;
	let decoder: Transform;
	if (encoding === "gzip" || encoding === "x-gzip") decoder = createGunzip();
	else if (encoding === "deflate") decoder = createInflate();
	else if (encoding === "br") decoder = createBrotliDecompress();
	else throw new FetchError("目标使用了不支持的内容编码", "unsupported_content");
	pipeline(raw, decoder, (error) => {
		// pipeline 会销毁两端；回调负责消费退出错误，不让它成为未处理事件。
		if (error !== undefined && error !== null && !decoder.destroyed) decoder.destroy(error);
	});
	return decoder;
}

/** 把 Node 响应流转成 Fetch Response；解压后的长度不再沿用原始长度头。 */
function toWebResponse(raw: IncomingMessage, status: number): Response {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw.headers)) {
		const lower = name.toLowerCase();
		if (lower === "content-encoding" || lower === "content-length") continue;
		if (typeof value === "string") headers.set(name, value);
		else if (Array.isArray(value)) headers.set(name, value.join(", "));
	}
	return new Response(Readable.toWeb(decodeBody(raw)) as unknown as BodyInit, { status, headers });
}

function isRedirectStatus(status: number): boolean {
	return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 带逐跳目标校验与单一绝对截止时间的完整抓取。 */
export async function httpFetch(input: HttpFetchRequest): Promise<HttpFetchResponse> {
	const deadline = createFetchDeadline(input.timeoutMs, input.signal, input.deadlineMs);
	const resolve = input.resolveTarget ?? resolveFetchTarget;
	const maxRedirects = input.maxRedirects ?? 3;
	if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
		deadline.dispose();
		throw new FetchError("重定向次数配置无效", "blocked_url");
	}
	let current = input.target;
	let redirectCount = 0;
	let url = current.url;
	try {
		for (;;) {
			deadline.check();
			const controller = new AbortController();
			const relayAbort = (): void => {
				if (!controller.signal.aborted) controller.abort(deadline.signal.reason);
			};
			deadline.signal.addEventListener("abort", relayAbort, { once: true });
			let handle: RequestHandle | undefined;
			let succeeded = false;
			try {
				if (deadline.signal.aborted) relayAbort();
				handle = await deadline.run(() => requestOnce(current, buildHeaders(url), controller.signal));
				deadline.check();
				const { status, headers, raw } = handle;
				if (isRedirectStatus(status)) {
					const location = redirectLocation(url, headers);
					raw.destroy();
					if (location === undefined || redirectCount >= maxRedirects) {
						throw new FetchError("重定向不可用或次数超限", "blocked_url");
					}
					current = await deadline.run(() => resolve(location, deadline.signal));
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
				const body = await deadline.run(() => readResponseTextLimited(response, input.maxResponseBytes, controller));
				if (body.length === 0) throw new FetchError("目标没有返回正文", "extraction_failed");
				succeeded = true;
				return {
					status,
					headers: Object.fromEntries(Object.entries(raw.headers).filter(([, value]) => typeof value === "string")) as Record<string, string>,
					body,
					finalUrl: url,
					redirectCount,
				};
			} finally {
				deadline.signal.removeEventListener("abort", relayAbort);
				if (handle !== undefined) {
					handle.cleanup();
					if (!succeeded && !handle.raw.destroyed) handle.raw.destroy();
				}
			}
		}
	} catch (error) {
		try {
			deadline.check();
		} catch (deadlineError) {
			throw deadlineError;
		}
		if (error instanceof FetchError) throw error;
		// 目标解析的安全分类不得降级成普通网络错误。
		const kind = (error as { kind?: string } | undefined)?.kind;
		if (typeof kind === "string") throw new FetchError("目标不可达", kind as FetchErrorKind);
		throw new FetchError("抓取失败", "network_error");
	} finally {
		deadline.dispose();
	}
}

/** 解析 Retry-After 的秒与 HTTP 日期两种形式。 */
function parseRetryAfter(value: string | string[] | undefined): number | undefined {
	if (value === undefined) return undefined;
	const trimmed = (Array.isArray(value) ? value[0] : value).trim();
	if (trimmed.length === 0) return undefined;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
	const timestamp = Date.parse(trimmed);
	if (!Number.isFinite(timestamp)) return undefined;
	return Math.max(0, timestamp - Date.now());
}
