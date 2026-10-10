/**
 * Pi Web Search 扩展
 *
 * 通过 JSON-RPC 2.0 直连 Exa / Parallel 的远程 MCP 端点，并直连 Tavily /
 * Firecrawl / SerpApi 的原生 HTTP 接口，为 Pi 提供统一的 `web_search` 工具。
 * 四个匿名通道默认启用；任何密钥通道都需要显式计费授权。
 *
 * 设计要点：
 * - 单请求预算可注入（默认 25 秒），外部取消信号会被转发且立即生效。
 * - 响应体既可能是直接 JSON，也可能是 SSE（`data:` 事件块），两种都解析。
 * - 所有匿名通道先于所有 Key 通道；默认禁止计费，所有真实 Key 均按可能计费处理。
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
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createSecretStore, type SecretStore } from "./credentials.js";
import {
	BACKENDS,
	emptyPlanKeys,
	resolvePlanKeys,
	redactSecrets,
	safeDiagnostic,
	type Backend,
} from "./auth.js";
import { registerAuthCommand } from "./auth-ui.js";
import type { ChannelHealth } from "./channel-health.js";
import { buildRouteCandidates, getRoutingStatus, readRoutingConfig, type Provider, type RoutingConfig, type RoutingStep } from "./routing.js";
import { createQuotaManager, type QuotaChannel, type QuotaFailureReason } from "./quota/core.js";
import { createPrivateQuotaStateStore } from "./quota/state-store.js";
import {
	BackendError,
	errorDetailFrom,
	isHttpUrl,
	messageKind,
	type SearchErrorKind,
	type WebSource,
} from "./search-core.js";
import { apiHttpKind, buildApiRequest, isApiBackend, parseApiResponse, type RequestSpec } from "./search-api.js";
import {
	buildTinyFishHeaders,
	buildTinyFishPayload,
	parseTinyFishResults,
	TINYFISH_MCP_URL,
} from "./search/providers/tinyfish.js";
import { getProviderMetadata, isProviderId, PROVIDER_IDS } from "./search/registry.js";
import { readMaxResponseBytes, readResponseTextLimited } from "./response-body.js";

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
const USER_AGENT = "pi-web-search/0.6.0-beta.3";

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
		Type.Union([Type.Literal("auto"), ...PROVIDER_IDS.map((backend) => Type.Literal(backend))], {
			description: "先按固定顺序尝试所有匿名通道；仅在显式授权后逐个尝试可能计费的 Key 通道。",
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
	if (value === null || value.trim().length === 0) return undefined;
	const seconds = Number(value.trim());
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

/** 可取消等待不遵守信号的状态加载，并始终消费其迟到拒绝。 */
function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(createAbortError());
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(createAbortError()));
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (signal.aborted) onAbort();
	});
}

class QuotaPreflightError extends BackendError {
	constructor(readonly reason: string) {
		super("额度预检未通过，未发送搜索请求", "quota_preflight");
	}
}

/** 额度预检失败原因映射为固定中文诊断；不含任何凭据或上游原文。 */
function quotaPreflightMessage(reason: string): string {
	switch (reason) {
		case "cooldown":
			return "额度通道冷却中，未发送搜索请求";
		case "insufficient_credits":
			return "当前余额不足以支付本次搜索，未发送搜索请求";
		case "authorization_required":
			return "缺少计费授权，未发送搜索请求";
		case "unsupported_operation":
			return "该后端没有可估算的额度成本，未发送搜索请求";
		case "rate_limited":
			return "额度查询被限流，未发送搜索请求";
		case "invalid_response":
			return "额度查询响应不可用，未发送搜索请求";
		case "lookup_failed":
			return "额度查询失败，未发送搜索请求";
		default:
			return "额度状态未知，未发送搜索请求";
	}
}

/** 超时或外部取消时立即返回，并消费不遵守 AbortSignal 的迟到网络结果。 */
function waitForControllerAbort<T>(promise: Promise<T>, controller: AbortController): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			controller.signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = (): void => finish(() => reject(createAbortError()));
		controller.signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (controller.signal.aborted) onAbort();
	});
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
	const label = getProviderMetadata(outcome.backend).label;
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

interface QuotaSearchContext {
	manager: ReturnType<typeof createQuotaManager>;
	config: RoutingConfig;
	legacyHealth?: ChannelHealth;
	persistenceWarnings: Set<string>;
}

function quotaChannel(channel: RouteStep["channel"]): QuotaChannel {
	return channel === "free" ? "anonymous" : "key";
}

async function flushQuotaState(context: QuotaSearchContext, signal?: AbortSignal): Promise<void> {
	const pending = Promise.resolve().then(() => context.manager.flush());
	const result = await waitForAbort(pending, signal);
	if (result.status === "degraded") context.persistenceWarnings.add(result.reason ?? "QUOTA_STATE_IO_UNAVAILABLE");
}

async function recordQuotaFailure(
	context: QuotaSearchContext,
	step: RouteStep,
	reason: QuotaFailureReason,
	signal?: AbortSignal,
	retryAfterMs?: number,
	managerAlreadyRecorded = false,
): Promise<void> {
	const channel = quotaChannel(step.channel);
	if (!managerAlreadyRecorded) {
		context.manager.recordFailure(step.backend, channel, reason, {
			...(step.apiKey === undefined ? {} : { credential: step.apiKey }),
			...(context.config.cooldownOverrideMs === undefined ? {} : { cooldownMs: context.config.cooldownOverrideMs }),
			...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		});
	}
	context.legacyHealth?.recordFailure(step.backend, step.channel, reason, {
		cooldownMs: context.config.cooldownOverrideMs ?? context.config.freeCooldownMs,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	});
	await flushQuotaState(context, signal);
}

/**
 * 在单个通道上执行搜索：每个已 dispatch 请求单独预留额度；限流立即冷却，
 * 仅网络、5xx 按指数退避重试，其余错误交给路由层。
 */
async function searchChannel(
	step: RouteStep,
	query: string,
	numResults: number,
	maxResponseBytes: number,
	quotaContext: QuotaSearchContext,
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
				: backend === "tinyfish"
					? buildTinyFishPayload(query)
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
	if (backend === "tinyfish") Object.assign(headers, buildTinyFishHeaders());

	/** 执行一次请求；失败一律以带分类的 BackendError 抛出。 */
	const attempt = async (): Promise<{ text: string; sources: WebSource[] }> => {
		let reservation: { dispatch(): boolean; release(): boolean; settle(actualCost?: number): boolean } | undefined;
		let dispatched = false;
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
			// 原生接口通过适配器表分发，Exa / Parallel 保持原有 MCP 信封。
			const request: RequestSpec =
				isApiBackend(backend)
					? buildApiRequest(backend, query, numResults, step.apiKey, channel)
					: {
							url: backend === "exa"
								? exaEndpoint(step)
								: backend === "tinyfish"
									? TINYFISH_MCP_URL
									: PARALLEL_MCP_URL,
							method: "POST",
							headers,
							body: JSON.stringify(payload),
						};
			const credential = channel === "key" ? step.apiKey : undefined;
			const cooldownOverride = quotaContext.config.cooldownOverrideMs;
			const activeCooldown = quotaContext.manager.getCooldown(
				backend,
				quotaChannel(channel),
				credential,
				cooldownOverride,
			);
			if (activeCooldown !== undefined) throw new QuotaPreflightError("cooldown");
			if (channel === "key" && (backend === "tavily" || backend === "firecrawl")) {
				if (credential === undefined) throw new QuotaPreflightError("authorization_required");
				const balance = await quotaContext.manager.lookupBalance({
					backend,
					channel: "key",
					credential,
					allowBillable: true,
					signal: controller.signal,
					maxResponseBytes,
					...(quotaContext.config.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: quotaContext.config.cooldownOverrideMs }),
				});
				if (isAborted(signal)) throw createAbortError();
				if (timedOut) throw new BackendError(`${backend} timed out before dispatch`, "timeout");
				if (balance.state === "unknown") {
					if (balance.reason === "rate_limited") {
						await recordQuotaFailure(quotaContext, step, "rate_limited", signal, balance.retryAfterMs, true);
					}
					throw new QuotaPreflightError(balance.reason);
				}
				if (balance.remaining === 0) {
					await recordQuotaFailure(quotaContext, step, "quota_exhausted", signal, undefined, true);
					throw new QuotaPreflightError("insufficient_credits");
				}
				const result = quotaContext.manager.reserve({
					backend,
					channel: "key",
					credential,
					allowBillable: true,
					operation: "search",
					maxResults: numResults,
					...(quotaContext.config.cooldownOverrideMs === undefined ? {} : { cooldownOverrideMs: quotaContext.config.cooldownOverrideMs }),
				});
				if (result.status === "denied") {
					// 单次搜索预估开销高于余额不等于额度耗尽：不据此刻冷却，避免阻断更省额度的后续搜索。
					throw new QuotaPreflightError(result.reason);
				}
				reservation = result.reservation;
			}
			if (isAborted(signal)) throw createAbortError();
			if (timedOut) throw new BackendError(`${backend} timed out before dispatch`, "timeout");
			const finalCooldown = quotaContext.manager.getCooldown(
				backend,
				quotaChannel(channel),
				credential,
				quotaContext.config.cooldownOverrideMs,
			);
			if (finalCooldown !== undefined) throw new QuotaPreflightError("cooldown");
			if (reservation !== undefined && !reservation.dispatch()) throw new QuotaPreflightError("unknown_balance");
			dispatched = true;
			const pendingFetch = Promise.resolve().then(() => fetch(request.url, {
				method: request.method,
				headers: request.headers,
				body: request.body,
				signal: controller.signal,
			}));
			void pendingFetch.catch(() => undefined);
			const response = await waitForControllerAbort(pendingFetch, controller);
			if (!response.ok) {
				let detail = "";
				try {
					const body = await readResponseTextLimited(response, maxResponseBytes, controller);
					const raw = errorDetailFrom(JSON.parse(body));
					if (raw !== undefined) detail = `: ${raw}`;
				} catch (error) {
					if (isAborted(signal)) throw createAbortError();
					if (timedOut) throw error;
					if (error instanceof BackendError && error.kind === "response_too_large") throw error;
					// 正文超限优先于状态分类；普通读取或解析失败仍按已知状态码分类。
				}
				const kind = apiHttpKind(backend, response.status, detail);
				const retryAfterMs = kind === "rate_limited" ? parseRetryAfter(response.headers.get("retry-after")) : undefined;
				throw new BackendError(`${backend} HTTP ${response.status}${detail}`, kind, retryAfterMs);
			}
			let body: string;
			try {
				body = await readResponseTextLimited(response, maxResponseBytes, controller);
			} catch (error) {
				if (isAborted(signal) || timedOut || error instanceof BackendError) throw error;
				throw new Error("Response body stream read failed");
			}
			if (isApiBackend(backend)) {
				const sources = parseApiResponse(backend, body, numResults);
				return { text: renderParallel(sources, ""), sources };
			}
			const text = parseMcpResponse(body);
			if (text === undefined) throw new BackendError(`${backend} returned no usable results`, "protocol_error");
			if (backend === "exa" && channel === "free" && isExaFreeRateLimitNotice(text)) {
				throw new BackendError(text.trim(), "quota_exhausted");
			}
			const sources = backend === "tinyfish" ? parseTinyFishResults(text, numResults) : extractSources(text);
			if (sources.length === 0) {
				throw new BackendError(`${backend} 未返回可用的搜索来源`, "protocol_error");
			}
			return { text, sources };
		} catch (error) {
			if (isAborted(signal)) throw createAbortError();
			const failure = timedOut
				? new BackendError(`${backend} timed out after ${timeoutMs}ms`, "timeout")
				: error instanceof BackendError
					? error
					: new BackendError(`${backend} request failed: ${String(error)}`, "network_error");
			if (dispatched) {
				failure.attempts = 1;
				if (failure.kind === "rate_limited") {
					await recordQuotaFailure(quotaContext, step, "rate_limited", signal, failure.retryAfterMs);
				} else if (failure.kind === "quota_exhausted") {
					await recordQuotaFailure(quotaContext, step, "quota_exhausted", signal);
				}
			}
			throw failure;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			if (reservation !== undefined) {
				if (dispatched) reservation.settle();
				else reservation.release();
			}
		}
	};

	let attempts = 0;
	for (let round = 0; ; round++) {
		try {
			const result = await attempt();
			return { ...result, attempts: attempts + 1 };
		} catch (error) {
			if (isAborted(signal)) throw createAbortError();
			const dispatchedAttempts = error instanceof BackendError ? error.attempts : 0;
			attempts += dispatchedAttempts;
			if (error instanceof BackendError) error.attempts = attempts;
			if (!(error instanceof BackendError) || !error.retryable || error.kind === "rate_limited" || round >= retries) throw error;
			// 退避等待可被取消打断；Retry-After 影响退避但等待最多 5 秒。
			await sleep(Math.min(RETRY_MAX_WAIT_MS, Math.max(RETRY_BASE_MS * 2 ** round, error.retryAfterMs ?? 0)), signal);
		}
	}
}

/** 扩展的可注入选项（测试用）。 */
export interface WebSearchOptions {
	/** 系统密钥库；默认按平台选择（macOS Keychain / Linux secret-tool）。测试注入 fake，不触碰真实密钥库。 */
	credentialStore?: SecretStore;
	/** 可注入的旧式通道冷却状态；仅显式注入时与额度管理器双写兼容状态。 */
	channelHealth?: ChannelHealth;
	/** 可注入额度管理器；默认无注入的生产实例使用 Pi 私有配置目录持久化。 */
	quotaManager?: ReturnType<typeof createQuotaManager>;
	/** 与注入的旧式冷却状态共享测试时钟；不注入时使用真实时间。 */
	quotaClock?: () => number;
}

/** 注册 `web_search` 工具与 `/web-search-auth` 命令。 */
export default function piWebSearch(pi: ExtensionAPI, options: WebSearchOptions = {}): void {
	const store: SecretStore = options.credentialStore ?? createSecretStore();
	const channelHealth = options.channelHealth;
	const injectedTestBoundary = options.credentialStore !== undefined || options.channelHealth !== undefined;
	const quotaManager = options.quotaManager ?? createQuotaManager(injectedTestBoundary
		? { ...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }) }
		: {
			stateStore: createPrivateQuotaStateStore(join(getAgentDir(), "config", "web-search")),
			...(options.quotaClock === undefined ? {} : { clock: options.quotaClock }),
		});
	registerAuthCommand(pi, store, () => getRoutingStatus(
		readRoutingConfig(),
		channelHealth?.snapshot().channels ?? [],
		quotaManager.snapshot(),
	));

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"先尝试匿名搜索；所有已配置 API Key 均按可能计费处理，额度预检不代表免费。只有显式授权后才使用 Key 通道；返回可引用来源。",
		parameters: WebSearchParams,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			if (query.length === 0) throw new Error("query must not be empty");
			if (isAborted(signal)) throw createAbortError();
			const maxResponseBytes = readMaxResponseBytes();

			const provider = params.provider ?? "auto";
			if (provider !== "auto" && !isProviderId(provider)) throw new Error("未知的搜索后端");
			const numResults = params.maxResults ?? DEFAULT_NUM_RESULTS;
			const config = readRoutingConfig();
			// 未授权计费时绝不读取密钥环境变量或系统密钥库；授权时在路由前一次解析，
			// 保证本工具所有对外文本与落盘内容都能抹掉本次已读取的凭据。
			const keys = config.allowBillable
				? await resolvePlanKeys(provider, store, signal)
				: emptyPlanKeys();
			if (isAborted(signal)) throw createAbortError();
			const candidates = buildRouteCandidates(provider, config);
			await waitForAbort(Promise.resolve().then(() => quotaManager.initialize()), signal);
			const secrets = BACKENDS.map((backend) => keys[backend]);
			interface SearchFailure {
				label: string;
				kind: SearchErrorKind | "unknown" | "cooldown" | "missing_key";
				/** 原始诊断；只在最终对外输出时按已读取凭据统一脱敏。 */
				message: string;
			}
			const failures: SearchFailure[] = [];
			const persistenceWarnings = new Set<string>();
			const quotaContext: QuotaSearchContext = {
				manager: quotaManager,
				config,
				persistenceWarnings,
				...(channelHealth === undefined ? {} : { legacyHealth: channelHealth }),
			};
			let attemptCount = 0;

			for (const candidate of candidates) {
				if (isAborted(signal)) throw createAbortError();
				if (channelHealth !== undefined && config.freeCooldownMs > 0) {
					const cooldown = channelHealth.getCooldown(candidate.backend, candidate.channel);
					if (cooldown !== undefined) {
						failures.push({
							label: stepLabel(candidate),
							kind: "cooldown",
							message: `通道正在冷却，剩余约 ${Math.ceil(cooldown.remainingMs / 1000)} 秒；本次未发送网络请求`,
						});
						continue;
					}
				}
				let step: RouteStep = { ...candidate, ...(candidate.channel === "key" ? { apiKey: keys[candidate.backend] } : {}) };
				if (candidate.channel === "key" && typeof step.apiKey !== "string") {
					failures.push({ label: stepLabel(candidate), kind: "missing_key", message: "未配置密钥，已跳过且未发送请求" });
					continue;
				}
				try {
					if (isAborted(signal)) throw createAbortError();
					const { text: rawText, sources: rawSources, attempts } = await searchChannel(
						step,
						query,
						numResults,
						maxResponseBytes,
						quotaContext,
						signal,
					);
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
					quotaManager.recordSuccess(step.backend, quotaChannel(step.channel), step.apiKey);
					channelHealth?.recordSuccess(step.backend, step.channel);
					await flushQuotaState(quotaContext, signal);
					if (isAborted(signal)) throw createAbortError();
					const quotaSnapshot = quotaManager.snapshot();
					if (quotaSnapshot.persistence === "degraded") {
						persistenceWarnings.add(quotaSnapshot.persistenceReason ?? "QUOTA_STATE_IO_UNAVAILABLE");
					}
					// 每条失败在入队时已按本次读取的凭据脱敏并截断，这里直接拼接。
					const fallbackReason = failures.length > 0
						? failures.map((failure) => `${failure.label}[${failure.kind}]: ${failure.message}`).join(" | ")
						: undefined;
					return {
						content: [{ type: "text" as const, text: renderOutcome(safeQuery, outcome, spill) }],
						details: {
							provider: step.backend,
							channel: step.channel,
							accessTier: step.channel === "free" ? "anonymous" : "billable",
							query: safeQuery,
							numResults,
							sourceCount: sources.length,
							sources,
							truncated: outcome.truncated,
							attemptCount,
							quotaPersistence: quotaSnapshot.persistence,
							...(persistenceWarnings.size > 0 ? { quotaWarning: `额度状态写入退化：${[...persistenceWarnings].join(", ")}` } : {}),
							...(fallbackReason !== undefined ? { fallbackReason } : {}),
							...(spill !== undefined ? { fullTextPath: spill.path, fullTextComplete: spill.complete } : {}),
						},
					};
				} catch (error) {
					if (isAborted(signal)) throw createAbortError();
					attemptCount += error instanceof BackendError ? error.attempts : 0;
					failures.push({
						label: stepLabel(step),
						kind: error instanceof BackendError ? error.kind : "unknown",
						// 密钥已在授权时一次解析，这里按已读取凭据脱敏后再截断，避免越过截断边界泄露凭据。
						message: error instanceof QuotaPreflightError ? quotaPreflightMessage(error.reason) : safeDiagnostic(error, secrets),
					});
				}
			}
			const quotaSnapshot = quotaManager.snapshot();
			if (quotaSnapshot.persistence === "degraded") {
				persistenceWarnings.add(quotaSnapshot.persistenceReason ?? "QUOTA_STATE_IO_UNAVAILABLE");
			}
			const warning = persistenceWarnings.size > 0
				? ` | 额度状态持久化警告：${[...persistenceWarnings].join(", ")}`
				: "";
			throw new Error(
				// 每条诊断在写入时已按本次读取的凭据脱敏并截断；这里不再二次截断，避免把脱敏标记挤出窗口。
				`web_search failed — ${failures.map((failure) => `${failure.label}[${failure.kind}]: ${failure.message}`).join(" | ")}${config.allowBillable ? "" : " | 可能计费通道未获授权，未尝试"}${warning}`,
			);
		},
	});
}
