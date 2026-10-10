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

export { WebFetchParams };
export type { WebFetchDetails, WebFetchConfig, FetchErrorKind };

/** 未实现阶段的固定诊断；分类稳定，不含调用方输入。 */
const NOT_IMPLEMENTED_KIND: FetchErrorKind = "extraction_failed";

/** 供测试注入的依赖；默认全部未实现。 */
export interface WebFetchOptions {
	config?: () => WebFetchConfig;
	/** 抓取入口；脚手架阶段返回未实现诊断。 */
	fetchPage?: (url: string, mode: "auto" | "article" | "text", maxChars: number) => Promise<{
		title?: string;
		markdown: string;
		details: Omit<WebFetchDetails, "requestedUrl">;
	}>;
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
			const fetcher = options.fetchPage;
			if (fetcher === undefined) {
				throw new FetchError(
					"web_fetch 的抓取流程尚未实现：当前阶段只提供工具契约与安全校验",
					NOT_IMPLEMENTED_KIND,
					{},
				);
			}
			const outcome = await fetcher(url, mode, maxChars);
			const text = outcome.markdown;
			return {
				content: [{ type: "text", text: text.length > 0 ? text : "（未提取到正文）" }],
				details: {
					requestedUrl: url,
					...outcome.details,
					durationMs: Date.now() - startedAt,
				} satisfies WebFetchDetails,
			};
		},
	});
}
