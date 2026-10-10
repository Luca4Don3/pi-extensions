/**
 * web_fetch：本地优先的网页正文抓取扩展。
 *
 * 设计边界（v0.1.0-beta.1 脚手架阶段）：
 * - 只读取调用方给出的公开 URL，不执行网页脚本，不携带 Cookie / Authorization。
 * - 所有网络访问都要经过未实现的 URL 策略与有界传输层（后续阶段补齐）。
 * - 当前阶段仅建立工具契约、参数校验与配置校验；抓取流程返回固定诊断，
 *   不假装已经具备抓取能力。
 */

import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type WebFetchDetails, WebFetchParams } from "./params.js";
import { readWebFetchConfig, type WebFetchConfig } from "./config.js";
import { FetchError, type FetchErrorKind } from "./errors.js";
import { resolveFetchTarget } from "./transport/url-policy.js";
import { httpFetch } from "./transport/http-client.js";
import { extractContent } from "./extract/index.js";

export { WebFetchParams };
export type { WebFetchDetails, WebFetchConfig, FetchErrorKind };

/** 抓取与提取的依赖；默认走真实实现，测试可整体注入。 */
export interface WebFetchDependencies {
	resolveTarget?: (url: string) => ReturnType<typeof resolveFetchTarget>;
	fetchPage?: (request: {
		url: URL;
		target: { address: string; family: 4 | 6 };
		signal?: AbortSignal;
		timeoutMs: number;
		maxResponseBytes: number;
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
		return (override ?? readWebFetchConfig)();
	} catch (error) {
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
			if (!Number.isSafeInteger(maxChars) || (maxChars as number) < 1) {
				throw new FetchError("maxChars 必须是正整数", "invalid_url", {});
			}
			// 先做完整的目标校验，再决定是否发起任何连接。
			const resolveTarget = options.resolveTarget ?? resolveFetchTarget;
			const target = await resolveTarget(url);
			if (signal?.aborted) throw new FetchError("操作已取消", "aborted");

			const fetchPage = options.fetchPage ?? ((request) => httpFetch({
				url: request.url,
				target: { url: request.url, address: request.target.address, family: request.target.family },
				signal: request.signal,
				timeoutMs: request.timeoutMs,
				maxResponseBytes: request.maxResponseBytes,
				resolveTarget: async () => target,
			}).then((result) => ({
				body: result.body,
				contentType: result.headers["content-type"] ?? "",
				finalUrl: result.finalUrl,
				redirectCount: result.redirectCount,
				statusCode: result.status,
			})));
			const fetched = await fetchPage({ url: target.url, target, signal, timeoutMs: config.timeoutMs, maxResponseBytes: config.maxResponseBytes });
			if (signal?.aborted) throw new FetchError("操作已取消", "aborted");

			const extract = options.extract ?? extractContent;
			const extracted = extract(fetched.body, fetched.contentType, mode, maxChars);
			const text = extracted.markdown;
			return {
				content: [{ type: "text", text: text.length > 0 ? text : "（未提取到正文）" }],
				details: {
					requestedUrl: url,
					finalUrl: fetched.finalUrl.toString(),
					contentType: fetched.contentType,
					statusCode: fetched.statusCode,
					redirectCount: fetched.redirectCount,
					...(extracted.title === undefined ? {} : { title: extracted.title }),
					provider: "direct",
					extractedChars: text.length,
					truncated: text.length >= maxChars,
					durationMs: Date.now() - startedAt,
				} satisfies WebFetchDetails,
			};
		},
	});
}
