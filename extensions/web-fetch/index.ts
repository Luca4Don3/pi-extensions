/**
 * web_fetch：本地优先的网页正文抓取扩展。
 *
 * - 只读取调用方给出的公开 URL，不执行网页脚本，不携带 Cookie / Authorization。
 * - 初始解析、逐跳重定向、连接与正文读取共享同一绝对截止时间。
 * - 同步提取前后检查截止时间，不返回过期结果；不启用任何远程回退。
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type WebFetchDetails, WebFetchParams } from "./params.js";
import { MAX_CHARS_LIMIT, readWebFetchConfig, type WebFetchConfig } from "./config.js";
import { FetchError, type FetchErrorKind } from "./errors.js";
import { resolveFetchTarget } from "./transport/url-policy.js";
import { httpFetch } from "./transport/http-client.js";
import { createFetchDeadline } from "./transport/deadline.js";
import { extractContent } from "./extract/index.js";

export { WebFetchParams };
export type { WebFetchDetails, WebFetchConfig, FetchErrorKind };

/** 抓取与提取的依赖；默认走真实实现，测试可整体注入。 */
export interface WebFetchDependencies {
	resolveTarget?: (url: string, signal?: AbortSignal) => ReturnType<typeof resolveFetchTarget>;
	fetchPage?: (request: {
		url: URL;
		target: { address: string; family: 4 | 6 };
		signal?: AbortSignal;
		timeoutMs: number;
		deadlineMs: number;
		maxResponseBytes: number;
		maxRedirects: number;
	}) => Promise<{ body: string; contentType: string; finalUrl: URL; redirectCount: number; statusCode: number }>;
	extract?: typeof extractContent;
}

/** 可注入配置与依赖；测试只替换需要替换的部分。 */
export interface WebFetchOptions extends WebFetchDependencies {
	config?: () => WebFetchConfig;
}

/** 把配置读取收敛为一次调用，便于测试注入。 */
function resolveConfig(override?: () => WebFetchConfig): WebFetchConfig {
	try {
		const config = (override ?? readWebFetchConfig)();
		if (config.remoteFallback !== "off") throw new FetchError("远程回退尚未实现，请将 PI_WEB_FETCH_REMOTE_FALLBACK 设为 off", "remote_blocked");
		return config;
	} catch (error) {
		if (error instanceof FetchError && error.kind === "remote_blocked") throw error;
		throw new FetchError("web_fetch 配置无效", "blocked_url", {});
	}
}

/** 注册 `web_fetch` 工具。 */
export default function piWebFetch(pi: ExtensionAPI, options: WebFetchOptions = {}): void {
	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"读取一个公开 URL 并返回适合模型阅读的正文。本地直接抓取优先，不执行网页脚本，不携带任何凭据；私有与内网地址一律拒绝。",
		parameters: WebFetchParams,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			const startedAt = Date.now();
			if (signal?.aborted) throw new FetchError("操作已取消", "aborted", {});
			const config = resolveConfig(options.config);
			const url = typeof params.url === "string" ? params.url.trim() : "";
			if (url.length === 0) throw new FetchError("url 不能为空", "invalid_url", {});
			const mode = params.mode ?? "auto";
			const maxChars = params.maxChars ?? config.maxChars;
			if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_CHARS_LIMIT) {
				throw new FetchError("maxChars 超出允许范围", "invalid_url", {});
			}
			if (mode !== "auto" && mode !== "article" && mode !== "text") throw new FetchError("mode 不受支持", "invalid_url");
			// 先做完整的目标校验，再决定是否发起任何连接。
			const resolveTarget = options.resolveTarget ?? resolveFetchTarget;
			// details 一律只保留来源与路径：签名 URL、令牌等查询参数不得进入对外结果。
			const safeUrl = (value: URL): string => `${value.origin}${value.pathname}`;
			const deadline = createFetchDeadline(config.timeoutMs, signal);
			try {
				const target = await deadline.run(() => resolveTarget(url, deadline.signal));
				const fetchPage = options.fetchPage ?? ((request) => httpFetch({
					url: request.url,
					target: { url: request.url, address: request.target.address, family: request.target.family },
					signal: request.signal,
					timeoutMs: request.timeoutMs,
					deadlineMs: request.deadlineMs,
					maxResponseBytes: request.maxResponseBytes,
					maxRedirects: request.maxRedirects,
					resolveTarget,
				}).then((result) => ({
					body: result.body,
					contentType: result.headers["content-type"] ?? "",
					finalUrl: result.finalUrl,
					redirectCount: result.redirectCount,
					statusCode: result.status,
				})));
				const fetched = await deadline.run(() => fetchPage({
					url: target.url, target, signal: deadline.signal, timeoutMs: config.timeoutMs,
					deadlineMs: deadline.deadlineMs, maxResponseBytes: config.maxResponseBytes, maxRedirects: config.maxRedirects,
				}));
				const extract = options.extract ?? extractContent;
				deadline.check();
				const extracted = extract(fetched.body, fetched.contentType, mode, maxChars, fetched.finalUrl);
				// 同步提取不可被计时器抢占，完成后必须检查真实时钟，不返回过期正文。
				deadline.check();
				const text = extracted.markdown;
				return {
					content: [{ type: "text", text }],
					details: {
						requestedUrl: safeUrl(target.url),
						finalUrl: safeUrl(fetched.finalUrl),
						contentType: fetched.contentType,
						statusCode: fetched.statusCode,
						redirectCount: fetched.redirectCount,
						...(extracted.title === undefined ? {} : { title: extracted.title }),
						provider: "direct",
						extractedChars: text.length,
						truncated: extracted.truncated,
						durationMs: Date.now() - startedAt,
					} satisfies WebFetchDetails,
				};
			} finally {
				deadline.dispose();
			}
		},
	});
}
