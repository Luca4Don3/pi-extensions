/**
 * Pi Web Search 扩展
 *
 * 通过 JSON-RPC 2.0 直连 Exa / Parallel 的远程 MCP 端点，并直连 Tavily /
 * SerpApi 的原生 HTTP 接口，为 Pi 提供统一的 `web_search` 工具。
 * Exa / Parallel 默认免 key；Tavily / SerpApi 只在配置密钥后参与路由。
 *
 * 设计要点：
 * - 单请求预算可注入（默认 25 秒），外部取消信号会被转发且立即生效。
 * - 响应体既可能是直接 JSON，也可能是 SSE（`data:` 事件块），两种都解析。
 * - 默认先尝试免费通道；可用 PI_WEB_SEARCH_ROUTING=key-first 保留旧的 Key 优先顺序。
 * - 失败按错误类型决策：额度/鉴权直接换通道，限流与 5xx 退避重试，取消立即终止。
 * - 模型可见正文截断到 MAX_TEXT_CHARS，原文落盘供模型按需 read。
 * - Exa / Parallel key 解析顺序：环境变量优先，其次系统密钥库
 *   （macOS Keychain / Linux secret-tool，用 `/web-search-auth` 查看与删除）。
 *   key 不写入 session、不进入命令行参数、不落盘；错误文本统一脱敏。
 *
 * @module pi-web-search
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSecretStore, type SecretStore } from "./credentials.js";
import {
	BACKENDS,
	resolvePlanKeys,
	redactSecrets,
	safeDiagnostic,
	type Backend,
} from "./auth.js";
import { registerAuthCommand } from "./auth-ui.js";
import { createChannelHealth, type ChannelHealth } from "./channel-health.js";
import { buildRoutePlan, getRoutingStatus, readRoutingConfig, type Provider, type RoutingStep } from "./routing.js";
import {
	BackendError,
	errorDetailFrom,
	isHttpUrl,
	messageKind,
	type SearchErrorKind,
	type WebSource,
} from "./search-core.js";
import { apiHttpKind, buildApiRequest, parseApiResponse, type RequestSpec } from "./search-api.js";

export type { WebSource };

/** Exa 远程 MCP 端点（可选 key 以查询参数附加）。 */
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
/** Parallel 远程 MCP 端点（可选 key 以 Bearer 头附加）。 */
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
/** 默认单请求预算（毫秒），可用 PI_WEB_SEARCH_TIMEOUT_MS 覆盖。 */
const DEFAULT_TIMEOUT_MS = 25_000;
/** 默认重试次数（仅限流 / 5xx / 网络抖动可重试），可用 PI_WEB_SEARCH_RETRIES 覆盖。 */
const DEFAULT_RETRIES = 1;
/** 重试退避基数：第 n 次重试等待 RETRY_BASE_MS * 2^n。 */
const RETRY_BASE_MS = 400;
/** 单次退避等待上限，避免上游 Retry-After 把一次搜索拖太久。 */
const RETRY_MAX_WAIT_MS = 5_000;
/** 默认返回条数。 */
const DEFAULT_NUM_RESULTS = 8;
/** 模型可见正文上限，超出部分被截断并显式告知模型。 */
const MAX_TEXT_CHARS = 24_000;
/** 落盘完整正文的单文件硬上限，避免超大响应写满磁盘。 */
const SPILL_MAX_BYTES = 2 * 1024 * 1024;
/** 落盘目录保留的最大文件数，更旧的会被清理。 */
const SPILL_KEEP_FILES = 20;
/** 落盘目录名（位于系统临时目录下，不进入任何公开目录）。 */
const SPILL_DIR_NAME = "pi-web-search";
/** 归属标识，便于端点侧识别调用方。 */
const USER_AGENT = "pi-web-search/0.4.0-beta.2";

/** 一次尝试：某个后端的某个通道。 */
interface RouteStep extends RoutingStep {
	/** key 通道使用的凭据；仅存在于内存，绝不写入日志、session 或落盘内容。 */
	apiKey?: string;
}

/** 一次搜索的完整结果。 */
interface SearchOutcome {
	backend: Backend;
	text: string;
	sources: WebSource[];
	truncated: boolean;
}

/** 落盘结果：路径 + 正文是否完整写入（受 SPILL_MAX_BYTES 约束）。 */
interface SpillResult {
	path: string;
	complete: boolean;
}

/** 工具参数表。 */
const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"The query. Describe the page you want in natural language instead of stacking keywords, e.g. 'a blog post comparing React and Vue performance'.",
	}),
	maxResults: Type.Optional(
		Type.Integer({
			description: `Number of results to return. Defaults to ${DEFAULT_NUM_RESULTS}.`,
			minimum: 1,
			maximum: 20,
		}),
	),
	provider: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("exa"), Type.Literal("parallel"), Type.Literal("tavily"), Type.Literal("serpapi")], {
			description: "Search backend. auto (default) tries Exa, Parallel, then configured Tavily and SerpApi.",
		}),
	),
});

/** URL 以空白或闭合标点结束；带 g 标志，仅供 matchAll 使用。 */
const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/gu;
/** 同一模式的非全局副本，供 test() 使用，避免 lastIndex 状态串联。 */
const URL_CHECK_RE = /https?:\/\/[^\s<>()"'`\]]+/u;
/** 部分后端会在标题周围带上零宽字符与 BOM。 */
const ZWSP_RE = /[\u200B-\u200D\uFEFF]/gu;
/** 纯省略号行不是摘要。 */
const ELLIPSIS_RE = /^\.{3,}$/u;

/** MCP `tools/call` 的 JSON-RPC 请求体。 */
interface McpRequest {
	jsonrpc: "2.0";
	id: number;
	method: "tools/call";
	params: { name: string; arguments: object };
}

/** MCP `tools/call` 的响应信封（直接 JSON 或单个 SSE 帧）。 */
interface McpEnvelope {
	result?: {
		/** MCP 允许 HTTP 200 + JSON-RPC 成功时用该字段表示工具执行失败。 */
		isError?: boolean;
		content?: { type?: string; text?: string }[];
	};
	error?: { code?: number; message?: string } | string;
}

/** 读取整数环境变量，非法或越界时回退默认值。 */
function readIntEnv(name: string, fallback: number, min: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim().length === 0) return fallback;
	const value = Number(raw);
	return Number.isInteger(value) && value >= min ? value : fallback;
}

/** 解析 Retry-After（秒数或 HTTP 日期）；原值用于冷却，重试等待另行限幅。 */
function parseRetryAfter(value: string | null): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.ceil(seconds * 1000), Number.MAX_SAFE_INTEGER);
	const at = Date.parse(value);
	if (Number.isNaN(at)) return undefined;
	return Math.min(Math.max(at - Date.now(), 0), Number.MAX_SAFE_INTEGER);
}

/** 失败信息里标识具体通道。 */
function stepLabel(step: RouteStep): string {
	return step.channel === "key" ? `${step.backend}(key)` : step.backend;
}

/** Exa 免费 MCP 的精确额度提示；仅允许有限标点/空白变化，不匹配普通摘要。 */
function isExaFreeRateLimitNotice(text: string): boolean {
	return /^\s*You['’‘]ve\s+hit\s+Exa['’‘]s\s+free\s+MCP\s+rate\s+limit\b(?:[\s.!?…:;,—–-]|$)/iu.test(text);
}

/** 统一创建可被运行时识别的取消错误，不传播底层错误文本。 */
function createAbortError(): DOMException {
	return new DOMException("web_search aborted", "AbortError");
}

/** 取消状态可在异步等待期间改变，每次检查都重新读取。 */
function isAborted(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}

/** 后端错误信息不再在内部预截断：截断必须发生在脱敏之后（见 safeDiagnostic）。 */

/** 可被 AbortSignal 立即打断的等待。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(createAbortError());
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, ms);
		if (isAborted(signal)) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

/** Exa 端点：key 通道带 Key，free 通道不带任何凭据。 */
function exaEndpoint(step: RouteStep): string {
	if (step.channel === "key" && step.apiKey !== undefined && step.apiKey.length > 0) {
		return `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(step.apiKey)}`;
	}
	return EXA_MCP_URL;
}

/** Exa 文本布局中一块结果的解析结果。 */
function parseExaBlock(block: string): WebSource | undefined {
	let title: string | undefined;
	let url: string | undefined;
	let snippet: string | undefined;
	let inHighlights = false;
	for (const line of block.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith("Title:")) {
			title = trimmed
				.slice("Title:".length)
				.replace(/^\s*(?:\d+[.)]?|[-*•])\s*/u, "")
				.replace(/^title:\s*/iu, "")
				.replace(ZWSP_RE, "")
				.trim();
			continue;
		}
		if (trimmed.startsWith("URL:")) {
			url = trimmed.slice("URL:".length).trim();
			continue;
		}
		if (/^(?:Published|Author):/iu.test(trimmed)) continue;
		if (trimmed.startsWith("Highlights:")) {
			inHighlights = true;
			continue;
		}
		if (inHighlights && snippet === undefined) {
			const candidate = trimmed
				.replace(/^(?:content|snippet|excerpt):\s*/iu, "")
				.replace(/^###\s*/u, "")
				.trim();
			if (candidate.length > 0 && !ELLIPSIS_RE.test(candidate)) snippet = candidate;
		}
	}
	if (url === undefined || !isHttpUrl(url)) return undefined;
	return {
		url,
		...(title !== undefined && title.length > 0 ? { title } : {}),
		...(snippet !== undefined ? { snippet } : {}),
	};
}

/** 兜底扫描：每条含 URL 的行取上一行为标题、下一行为摘要，按 URL 去重。 */
function extractSourcesByLines(text: string): WebSource[] {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const seen = new Set<string>();
	const sources: WebSource[] = [];
	const isUrlLine = (line: string | undefined): boolean =>
		line === undefined || /^(?:url|link|source):/iu.test(line) || URL_CHECK_RE.test(line);
	for (let i = 0; i < lines.length; i++) {
		for (const match of lines[i].matchAll(URL_RE)) {
			const url = match[0].replace(/[.,;:!?)\]]+$/u, "");
			if (seen.has(url) || !isHttpUrl(url)) continue;
			seen.add(url);
			const prev = i > 0 ? lines[i - 1] : undefined;
			const next = i + 1 < lines.length ? lines[i + 1] : undefined;
			const title = isUrlLine(prev) ? undefined : prev?.replace(ZWSP_RE, "").trim();
			const snippet = isUrlLine(next) ? undefined : next;
			sources.push({
				url,
				...(title !== undefined && title.length > 0 ? { title } : {}),
				...(snippet !== undefined && snippet.length > 0 ? { snippet } : {}),
			});
		}
	}
	return sources;
}

/** 解析 Parallel 的 JSON 布局：`results[]` 中每个 `{url,title,publish_date,excerpts[]}`。 */
function parseParallelJson(text: string): WebSource[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	const envelope = parsed as { results?: unknown } | null;
	if (envelope === null || typeof envelope !== "object" || !Array.isArray(envelope.results)) return undefined;
	const seen = new Set<string>();
	const sources: WebSource[] = [];
	for (const item of envelope.results as Record<string, unknown>[]) {
		if (item === null || typeof item !== "object") continue;
		const url = typeof item.url === "string" ? item.url : undefined;
		if (url === undefined || url.length === 0 || seen.has(url) || !isHttpUrl(url)) continue;
		seen.add(url);
		const title = typeof item.title === "string" ? item.title.replace(ZWSP_RE, "").trim() : undefined;
		const excerpt = Array.isArray(item.excerpts)
			? (item.excerpts as unknown[]).find(
					(value): value is string => typeof value === "string" && value.trim().length > 0,
				)
			: undefined;
		const publishedAt =
			typeof item.publish_date === "string" && item.publish_date.length > 0 ? item.publish_date : undefined;
		sources.push({
			url,
			...(title !== undefined && title.length > 0 ? { title } : {}),
			...(excerpt !== undefined ? { snippet: excerpt.trim() } : {}),
			...(publishedAt !== undefined ? { publishedAt } : {}),
		});
	}
	return sources;
}

/** 从正文提取结构化来源：Parallel JSON → Exa 分块 → 行扫描。 */
function extractSources(text: string): WebSource[] {
	const fromJson = parseParallelJson(text);
	if (fromJson !== undefined && fromJson.length > 0) return fromJson;

	const seen = new Set<string>();
	const sources: WebSource[] = [];
	for (const block of text.split(/\r?\n(?:-{3,}|\*{3,})\r?\n/u)) {
		const source = parseExaBlock(block);
		if (source === undefined || seen.has(source.url)) continue;
		seen.add(source.url);
		sources.push(source);
	}
	if (sources.length > 0) return sources;
	return extractSourcesByLines(text);
}

/** 解析一个 JSON 载荷：JSON-RPC 错误与 MCP isError 都归类抛出，否则返回首个非空 text。 */
function parsePayload(line: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	const envelope = parsed as McpEnvelope | null;
	if (envelope === null || typeof envelope !== "object") return undefined;
	if (envelope.error !== undefined) {
		const detail = typeof envelope.error === "string" ? envelope.error : envelope.error.message;
		const message = typeof detail === "string" && detail.length > 0 ? detail : "MCP search error";
		throw new BackendError(message, messageKind(message) ?? "protocol_error");
	}
	const content = envelope.result?.content;
	const item = Array.isArray(content)
		? content.find((entry) => typeof entry?.text === "string" && entry.text.length > 0)
		: undefined;
	const text = item?.text;
	// MCP 协议允许 HTTP 200 + JSON-RPC 成功时用 result.isError 表示工具执行失败，
	// 这种情况必须当成错误，不能把 content 里的错误文本当作搜索结果交给模型。
	if (envelope.result?.isError === true) {
		const message = typeof text === "string" && text.length > 0 ? text : "MCP search tool failed";
		throw new BackendError(message, messageKind(message) ?? "protocol_error");
	}
	return text;
}

/** 解析 MCP HTTP 响应体：先按直接 JSON，再按 SSE 事件块（同一事件的多行 data 拼接）。 */
function parseMcpResponse(body: string): string | undefined {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		const direct = parsePayload(trimmed);
		if (direct !== undefined) return direct;
	}

	let buffer: string[] = [];
	const flush = (): string | undefined => {
		if (buffer.length === 0) return undefined;
		const payload = buffer.join("\n");
		buffer = [];
		return parsePayload(payload);
	};
	for (const line of trimmed.split("\n")) {
		if (line.startsWith("data:")) {
			buffer.push(line.slice("data:".length).trimStart());
			continue;
		}
		// 空行表示一个 SSE 事件结束；未结束事件的尾部在循环后 flush。
		if (line.trim().length === 0) {
			const found = flush();
			if (found !== undefined) return found;
		}
	}
	return flush();
}

/** 落盘目录仅保留最近 SPILL_KEEP_FILES 个文件；清理是尽力而为。 */
async function pruneSpillDirectory(directory: string): Promise<void> {
	try {
		const entries = (await readdir(directory))
			.filter((name) => name.startsWith("results-") && name.endsWith(".txt"))
			.sort();
		const stale = entries.slice(0, Math.max(0, entries.length - SPILL_KEEP_FILES));
		await Promise.all(stale.map((name) => rm(join(directory, name), { force: true })));
	} catch {
		// 任何清理失败都不应影响搜索结果返回。
	}
}

/**
 * 正文超限时把内容落到独立临时目录，供模型按需 read。
 * 目录权限 0700、文件权限 0600，单文件受 SPILL_MAX_BYTES 限制。
 */
async function spillFullText(text: string): Promise<SpillResult> {
	const directory = join(tmpdir(), SPILL_DIR_NAME);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const file = join(directory, `results-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
	const buffer = Buffer.from(text, "utf8");
	await writeFile(file, buffer.subarray(0, SPILL_MAX_BYTES), { mode: 0o600 });
	await pruneSpillDirectory(directory);
	return { path: file, complete: buffer.byteLength <= SPILL_MAX_BYTES };
}

/**
 * 对单条来源的所有可见字段统一脱敏。
 * 上游响应可能回显 key（例如错误链接或 URL 查询参数），这里保证 key
 * 不会经 content / details / 落盘进入模型上下文。
 */
function redactSource(source: WebSource, secrets: readonly (string | undefined)[]): WebSource {
	return {
		url: redactSecrets(source.url, secrets),
		...(source.title !== undefined ? { title: redactSecrets(source.title, secrets) } : {}),
		...(source.snippet !== undefined ? { snippet: redactSecrets(source.snippet, secrets).slice(0, 200) } : {}),
		...(source.publishedAt !== undefined ? { publishedAt: redactSecrets(source.publishedAt, secrets) } : {}),
	};
}

/** Parallel 的来源列表转 Markdown；没有可用来源时退回原始正文。 */
function renderParallel(sources: WebSource[], text: string): string {
	if (sources.length === 0) return text;
	return sources
		.map((source, index) => {
			const title = source.title ?? source.url;
			const meta = source.publishedAt !== undefined ? ` (${source.publishedAt})` : "";
			const snippet = source.snippet !== undefined ? `\n   ${source.snippet}` : "";
			return `${index + 1}. [${title}](${source.url})${meta}${snippet}`;
		})
		.join("\n");
}

/** 渲染模型可见正文；所有分支共用同一个字符上限。 */
function renderOutcome(query: string, outcome: SearchOutcome, spill?: SpillResult): string {
	const label = { exa: "Exa", parallel: "Parallel", tavily: "Tavily", serpapi: "SerpApi" }[outcome.backend];
	const heading = `[${label}] search: ${query}`;
	const body = outcome.backend === "exa" ? outcome.text : renderParallel(outcome.sources, outcome.text);
	if (body.length <= MAX_TEXT_CHARS) return `${heading}\n\n${body}`;
	const note =
		spill === undefined
			? ""
			: spill.complete
				? `; full text: ${spill.path}`
				: `; full text (capped at ${SPILL_MAX_BYTES} bytes): ${spill.path}`;
	return `${heading}\n\n${body.slice(0, MAX_TEXT_CHARS)}\n\n[content truncated to ${MAX_TEXT_CHARS} chars${note}]`;
}

/**
 * 在单个通道上执行搜索：限流 / 5xx / 网络抖动按指数退避重试，
 * 其余错误立即抛出交给路由层决定换通道还是换后端。
 */
async function searchChannel(
	step: RouteStep,
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ text: string; sources: WebSource[]; attempts: number }> {
	// 每次调用时读取，便于测试注入（PI_WEB_SEARCH_TIMEOUT_MS / PI_WEB_SEARCH_RETRIES）。
	const timeoutMs = readIntEnv("PI_WEB_SEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 100);
	const retries = readIntEnv("PI_WEB_SEARCH_RETRIES", DEFAULT_RETRIES, 0);
	const { backend, channel } = step;

	const payload: McpRequest = {
		jsonrpc: "2.0",
		id: 1,
		method: "tools/call",
		params:
			backend === "exa"
				? {
						name: "web_search_exa",
						arguments: {
							query,
							type: "auto",
							numResults,
							livecrawl: "fallback",
							contextMaxCharacters: 10_000,
						},
					}
				: {
						name: "web_search",
						arguments: { objective: query, search_queries: [query] },
					},
	};

	const headers: Record<string, string> = {
		accept: "application/json, text/event-stream",
		"content-type": "application/json",
		"user-agent": USER_AGENT,
	};
	if (backend === "parallel" && channel === "key" && step.apiKey !== undefined && step.apiKey.length > 0) {
		headers.authorization = `Bearer ${step.apiKey}`;
	}

	/** 执行一次请求；失败一律以带分类的 BackendError 抛出。 */
	const attempt = async (): Promise<{ text: string; sources: WebSource[] }> => {
		// 一个控制器同时承担调用方取消与超时预算：预算耗尽算超时，调用方取消按取消处理。
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = (): void => controller.abort(signal?.reason);
		if (isAborted(signal)) {
			clearTimeout(timer);
			throw createAbortError();
		}
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			if ((backend === "tavily" || backend === "serpapi") && (step.apiKey === undefined || step.apiKey.length === 0)) {
				throw new BackendError(`${backend} 未配置密钥`, "invalid_key");
			}
			// Tavily / SerpApi 使用原生接口，Exa / Parallel 继续使用 MCP 信封。
			const request: RequestSpec =
				backend === "tavily" || backend === "serpapi"
					? buildApiRequest(backend, query, numResults, step.apiKey ?? "")
					: {
							url: backend === "exa" ? exaEndpoint(step) : PARALLEL_MCP_URL,
							method: "POST",
							headers,
							body: JSON.stringify(payload),
						};
			const response = await fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: controller.signal,
			});
			if (!response.ok) {
				let detail = "";
				try {
					const raw = errorDetailFrom(await response.json());
					if (raw !== undefined) detail = `: ${raw}`;
				} catch {
					// 状态码已经足够定位问题，非 JSON 响应体不覆盖它。
				}
				const kind = apiHttpKind(backend, response.status, detail);
				const retryAfterMs = kind === "rate_limited" ? parseRetryAfter(response.headers.get("retry-after")) : undefined;
				throw new BackendError(`${backend} HTTP ${response.status}${detail}`, kind, retryAfterMs);
			}
			const body = await response.text();
			if (backend === "tavily" || backend === "serpapi") {
				const sources = parseApiResponse(backend, body, numResults);
				return { text: renderParallel(sources, ""), sources };
			}
			const text = parseMcpResponse(body);
			if (text === undefined) throw new BackendError(`${backend} returned no usable results`, "protocol_error");
			if (backend === "exa" && channel === "free" && isExaFreeRateLimitNotice(text)) {
				throw new BackendError(text.trim(), "quota_exhausted");
			}
			return { text, sources: extractSources(text) };
		} catch (error) {
			if (isAborted(signal)) throw createAbortError();
			if (timedOut) throw new BackendError(`${backend} timed out after ${timeoutMs}ms`, "timeout");
			if (error instanceof BackendError) throw error;
			// fetch 网络层错误（DNS、连接重置等）值得重试。
			throw new BackendError(`${backend} request failed: ${String(error)}`, "network_error");
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};

	for (let round = 0; ; round++) {
		try {
			const result = await attempt();
			return { ...result, attempts: round + 1 };
		} catch (error) {
			if (isAborted(signal)) throw createAbortError();
			if (error instanceof BackendError) error.attempts = round + 1;
			if (!(error instanceof BackendError) || !error.retryable || round >= retries) throw error;
			// 退避等待可被取消打断；Retry-After 影响退避但等待最多 5 秒。
			await sleep(Math.min(RETRY_MAX_WAIT_MS, Math.max(RETRY_BASE_MS * 2 ** round, error.retryAfterMs ?? 0)), signal);
		}
	}
}

/** 扩展的可注入选项（测试用）。 */
export interface WebSearchOptions {
	/** 系统密钥库；默认按平台选择（macOS Keychain / Linux secret-tool）。测试注入 fake，不触碰真实密钥库。 */
	credentialStore?: SecretStore;
	/** 可注入的进程内通道冷却状态；用于测试或与认证状态界面共享。 */
	channelHealth?: ChannelHealth;
}

/** 注册 `web_search` 工具与 `/web-search-auth` 命令。 */
export default function piWebSearch(pi: ExtensionAPI, options: WebSearchOptions = {}): void {
	const store: SecretStore = options.credentialStore ?? createSecretStore();
	const channelHealth = options.channelHealth ?? createChannelHealth();
	registerAuthCommand(pi, store, () => getRoutingStatus(readRoutingConfig(), channelHealth.snapshot().channels));

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Exa, Parallel, Tavily, or SerpApi. Exa and Parallel work without keys; Tavily and SerpApi require configured keys. Returns citable page content and source URLs for current events, documentation, and facts beyond the training data.",
		parameters: WebSearchParams,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			if (query.length === 0) throw new Error("query must not be empty");
			if (isAborted(signal)) throw createAbortError();

			const provider = params.provider ?? "auto";
			const numResults = params.maxResults ?? DEFAULT_NUM_RESULTS;
			const config = readRoutingConfig();
			// 禁用付费路由时不读取任何 key 环境变量，也不访问 SecretStore。
			const keys: Record<Backend, string | undefined> = config.allowPaid
				? await resolvePlanKeys(provider, store, signal)
				: { exa: undefined, parallel: undefined, tavily: undefined, serpapi: undefined };
			if (isAborted(signal)) throw createAbortError();
			const routes: RouteStep[] = buildRoutePlan(provider, keys, config).map((step) => ({
				...step,
				...(step.channel === "key" ? { apiKey: keys[step.backend] } : {}),
			}));
			// 本次请求涉及的全部 key，用于把所有对外错误文本中的凭据抹掉。
			const secrets = BACKENDS.map((backend) => keys[backend]);
			const failures: { label: string; kind: SearchErrorKind | "unknown" | "cooldown"; message: string }[] = [];
			let attemptCount = 0;

			for (const step of routes) {
				if (isAborted(signal)) throw createAbortError();
				if (config.freeCooldownMs > 0) {
					const cooldown = channelHealth.getCooldown(step.backend, step.channel);
					if (cooldown !== undefined) {
						failures.push({
							label: stepLabel(step),
							kind: "cooldown",
							message: `通道正在冷却，剩余约 ${Math.ceil(cooldown.remainingMs / 1000)} 秒；本次未发送网络请求`,
						});
						continue;
					}
				}
				try {
					if (isAborted(signal)) throw createAbortError();
					const { text: rawText, sources: rawSources, attempts } = await searchChannel(step, query, numResults, signal);
					attemptCount += attempts;
					// 上游响应可能回显 key（错误正文、URL 查询参数等）：在进入模型上下文
					// （content / details）与落盘前统一脱敏，key 绝不流出。
					const text = redactSecrets(rawText, secrets);
					const safeQuery = redactSecrets(query, secrets);
					// Exa 自身遵守 numResults；Parallel 不受该参数约束，这里统一截断到请求条数。
					const sources = rawSources.map((source) => redactSource(source, secrets)).slice(0, numResults);
					const outcome: SearchOutcome = {
						backend: step.backend,
						text,
						sources,
						truncated: text.length > MAX_TEXT_CHARS,
					};
					// 超限正文落盘，模型仍可按需 read 完整内容（沿用 Pi 对大结果的惯例）。
					if (isAborted(signal)) throw createAbortError();
					const spill = outcome.truncated ? await spillFullText(text) : undefined;
					// 取消贯穿整个生命周期：取消时不改变任何通道健康状态。
					if (isAborted(signal)) throw createAbortError();
					channelHealth.recordSuccess(step.backend, step.channel);
					const fallbackReason =
						failures.length > 0
							? safeDiagnostic(
									failures.map((failure) => `${failure.label}[${failure.kind}]: ${failure.message}`).join(" | "),
									secrets,
								)
							: undefined;
					return {
						content: [{ type: "text" as const, text: renderOutcome(safeQuery, outcome, spill) }],
						details: {
							provider: step.backend,
							channel: step.channel,
							query: safeQuery,
							numResults,
							sourceCount: sources.length,
							sources,
							truncated: outcome.truncated,
							attemptCount,
							...(fallbackReason !== undefined ? { fallbackReason } : {}),
							...(spill !== undefined ? { fullTextPath: spill.path, fullTextComplete: spill.complete } : {}),
						},
					};
				} catch (error) {
					if (isAborted(signal)) throw createAbortError();
					attemptCount += error instanceof BackendError ? error.attempts : 1;
					if (error instanceof BackendError && config.freeCooldownMs > 0) {
						if (error.kind === "rate_limited" || (error.kind === "quota_exhausted" && step.channel === "free")) {
							channelHealth.recordFailure(
								step.backend,
								step.channel,
								error.kind === "rate_limited" ? "rate_limited" : "quota_exhausted",
								{
									cooldownMs: config.freeCooldownMs,
									...(error.kind === "rate_limited" && error.retryAfterMs !== undefined
										? { retryAfterMs: error.retryAfterMs }
										: {}),
								},
							);
						}
					}
					failures.push({
						label: stepLabel(step),
						kind: error instanceof BackendError ? error.kind : "unknown",
						message: safeDiagnostic(error, secrets),
					});
				}
			}
			throw new Error(
				`web_search failed — ${failures.map((failure) => `${failure.label}[${failure.kind}]: ${failure.message}`).join(" | ")}`,
			);
		},
	});
}
