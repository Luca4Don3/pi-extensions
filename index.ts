/**
 * Pi Web Search 扩展
 *
 * 通过 JSON-RPC 2.0 直连 Exa / Parallel 的远程 MCP 端点，为 Pi 提供原生
 * `web_search` 工具。两个端点默认免 key（与 opencode 客户端的直连方式一致），
 * 完全不依赖 opencode、DSH 或任何额外服务端进程：只要 Pi 能联网就能用。
 *
 * 设计要点：
 * - 25 秒单请求预算，与 opencode 的 websearch 工具一致；外部取消信号会被转发。
 * - 响应体既可能是直接 JSON，也可能是 SSE（`data: ` 行），两种都解析。
 * - auto 模式先试 Exa，失败自动回退 Parallel。
 * - 模型可见正文截断到 MAX_TEXT_CHARS，结构化来源同时进 details。
 *
 * @module pi-web-search
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Exa 远程 MCP 端点（可选 key 以查询参数附加）。 */
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
/** Parallel 远程 MCP 端点（可选 key 以 Bearer 头附加）。 */
const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
/** 单请求预算，与 opencode 的 websearch 工具一致。 */
const TIMEOUT_MS = 25_000;
/** 默认返回条数。 */
const DEFAULT_NUM_RESULTS = 8;
/** 模型可见正文上限，超出部分被截断并显式告知模型。 */
const MAX_TEXT_CHARS = 24_000;
/** 归属标识，便于端点侧识别调用方。 */
const USER_AGENT = "pi-web-search/0.1.0";

/** 后端选择：auto 表示按顺序尝试。 */
type Provider = "auto" | "exa" | "parallel";
/** 具体后端。 */
type Backend = "exa" | "parallel";

/** 归一化后的来源条目。 */
export interface WebSource {
	url: string;
	title?: string;
	snippet?: string;
	publishedAt?: string;
}

/** 一次搜索的完整结果。 */
interface SearchOutcome {
	backend: Backend;
	text: string;
	sources: WebSource[];
	truncated: boolean;
}

/** 工具参数表。 */
const WebSearchParams = Type.Object({
	query: Type.String({
		description:
			"The query. Describe the page you want in natural language instead of stacking keywords, e.g. 'a blog post comparing React and Vue performance'.",
	}),
	maxResults: Type.Optional(
		Type.Number({
			description: `Number of results to return. Defaults to ${DEFAULT_NUM_RESULTS}.`,
			minimum: 1,
			maximum: 20,
		}),
	),
	provider: Type.Optional(
		Type.Union([Type.Literal("auto"), Type.Literal("exa"), Type.Literal("parallel")], {
			description: "Search backend. auto (default) tries Exa first and falls back to Parallel.",
		}),
	),
});

/** URL 以空白或闭合标点结束。 */
const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/gu;
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
	result?: { content?: { type?: string; text?: string }[] };
	error?: { code?: number; message?: string } | string;
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
			if (candidate.length > 0 && !ELLIPSIS_RE.test(candidate)) snippet = candidate.slice(0, 200);
		}
	}
	if (url === undefined || !URL.canParse(url)) return undefined;
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
	for (let i = 0; i < lines.length; i++) {
		for (const match of lines[i].matchAll(URL_RE)) {
			const url = match[0].replace(/[.,;:!?)\]]+$/u, "");
			if (seen.has(url) || !URL.canParse(url)) continue;
			seen.add(url);
			const prev = i > 0 ? lines[i - 1] : undefined;
			const next = i + 1 < lines.length ? lines[i + 1] : undefined;
			const isUrlLine = (line: string | undefined): boolean =>
				line === undefined || /^(?:url|link|source):/iu.test(line) || URL_RE.test(line);
			const title = prev !== undefined && !isUrlLine(prev) ? prev.replace(ZWSP_RE, "").trim() : undefined;
			const snippet = next !== undefined && !isUrlLine(next) ? next.slice(0, 200) : undefined;
			sources.push({
				url,
				...(title !== undefined && title.length > 0 ? { title } : {}),
				...(snippet !== undefined ? { snippet } : {}),
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
		if (url === undefined || url.length === 0 || seen.has(url) || !URL.canParse(url)) continue;
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
			...(excerpt !== undefined ? { snippet: excerpt.trim().slice(0, 200) } : {}),
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

/** 解析一个 JSON 载荷：JSON-RPC 错误成员抛错，否则返回首个非空 text 内容。 */
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
		throw new Error(typeof detail === "string" && detail.length > 0 ? detail : "MCP search error");
	}
	const content = envelope.result?.content;
	if (!Array.isArray(content)) return undefined;
	const item = content.find((entry) => typeof entry?.text === "string" && entry.text.length > 0);
	return item?.text;
}

/** 解析 MCP HTTP 响应体：先按直接 JSON，再按 SSE 的 `data: ` 帧。 */
function parseMcpResponse(body: string): string | undefined {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		const direct = parsePayload(trimmed);
		if (direct !== undefined) return direct;
	}
	for (const line of trimmed.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = parsePayload(line.slice("data: ".length));
		if (data !== undefined) return data;
	}
	return undefined;
}

/** Exa 端点，带可选 key（与 opencode 一致，以查询参数附加）。 */
function exaEndpoint(): string {
	const key = process.env.EXA_API_KEY;
	return typeof key === "string" && key.length > 0
		? `${EXA_MCP_URL}?exaApiKey=${encodeURIComponent(key)}`
		: EXA_MCP_URL;
}

/** 构造一次后端调用，返回正文与结构化来源。 */
async function searchBackend(
	backend: Backend,
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ text: string; sources: WebSource[] }> {
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
	if (backend === "parallel") {
		const key = process.env.PARALLEL_API_KEY;
		if (typeof key === "string" && key.length > 0) headers.authorization = `Bearer ${key}`;
	}

	// 一个控制器同时承担调用方取消与超时预算：预算耗尽算后端错误，调用方取消按取消处理。
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, TIMEOUT_MS);
	const onAbort = (): void => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await fetch(backend === "exa" ? exaEndpoint() : PARALLEL_MCP_URL, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		if (!response.ok) {
			let detail = "";
			try {
				const parsed = (await response.json()) as { error?: { message?: string } | string; message?: string };
				const raw = typeof parsed?.error === "object" ? parsed.error?.message : (parsed?.error ?? parsed?.message);
				if (typeof raw === "string") detail = `: ${raw}`;
			} catch {
				// 状态码已经足够定位问题，非 JSON 响应体不覆盖它。
			}
			throw new Error(`${backend} HTTP ${response.status}${detail}`);
		}
		const text = parseMcpResponse(await response.text());
		if (text === undefined) throw new Error(`${backend} returned no usable results`);
		return { text, sources: extractSources(text) };
	} catch (error) {
		if (signal?.aborted === true) throw new Error("web_search aborted");
		if (timedOut) throw new Error(`${backend} timed out after ${TIMEOUT_MS / 1000}s`);
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** 按 provider 参数决定尝试顺序。 */
function backendOrder(provider: Provider): Backend[] {
	if (provider === "exa" || provider === "parallel") return [provider];
	return ["exa", "parallel"];
}

/** 正文超限时把完整内容落到临时文件，模型仍可按需 read。 */
async function spillFullText(text: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-web-search-"));
	const file = join(directory, "results.txt");
	await writeFile(file, text, "utf8");
	return file;
}

/** 渲染模型可见正文：Exa 已是大模型友好文本，Parallel 的 JSON 转成 Markdown。 */
function renderOutcome(query: string, outcome: SearchOutcome, fullTextPath?: string): string {
	const label = outcome.backend === "exa" ? "Exa" : "Parallel";
	const heading = `[${label}] search: ${query}`;
	if (outcome.backend === "exa") {
		if (outcome.text.length <= MAX_TEXT_CHARS) return `${heading}\n\n${outcome.text}`;
		const note = fullTextPath !== undefined ? `; full text: ${fullTextPath}` : "";
		return `${heading}\n\n${outcome.text.slice(0, MAX_TEXT_CHARS)}\n\n[content truncated to ${MAX_TEXT_CHARS} chars${note}]`;
	}
	if (outcome.sources.length === 0) return `${heading}\n\n${outcome.text.slice(0, MAX_TEXT_CHARS)}`;
	const list = outcome.sources
		.map((source, index) => {
			const title = source.title ?? source.url;
			const meta = source.publishedAt !== undefined ? ` (${source.publishedAt})` : "";
			const snippet = source.snippet !== undefined ? `\n   ${source.snippet}` : "";
			return `${index + 1}. [${title}](${source.url})${meta}${snippet}`;
		})
		.join("\n");
	return `${heading}\n\n${list}`;
}

/** 注册 `web_search` 工具。 */
export default function piWebSearch(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via the Exa / Parallel remote MCP endpoints. Returns citable page content and source URLs for current events, documentation, and facts beyond the training data.",
		parameters: WebSearchParams,
		annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
		async execute(_toolCallId, params, signal) {
			const query = params.query.trim();
			if (query.length === 0) throw new Error("query must not be empty");

			const numResults = params.maxResults ?? DEFAULT_NUM_RESULTS;
			const failures: string[] = [];
			for (const backend of backendOrder(params.provider ?? "auto")) {
				try {
					const { text, sources: rawSources } = await searchBackend(backend, query, numResults, signal);
					// Exa 自身遵守 numResults；Parallel 不受该参数约束，这里统一截断到请求条数。
					const sources = rawSources.slice(0, numResults);
					const outcome: SearchOutcome = {
						backend,
						text,
						sources,
						truncated: text.length > MAX_TEXT_CHARS,
					};
					// 超限正文落盘，模型仍可按需 read 完整内容（沿用 Pi 对大结果的惯例）。
					const fullTextPath = outcome.truncated ? await spillFullText(text) : undefined;
					return {
						content: [{ type: "text" as const, text: renderOutcome(query, outcome, fullTextPath) }],
						details: {
							provider: backend,
							query,
							numResults,
							sourceCount: sources.length,
							sources,
							truncated: outcome.truncated,
							...(fullTextPath !== undefined ? { fullTextPath } : {}),
						},
					};
				} catch (error) {
					if (signal?.aborted === true) throw error;
					failures.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			throw new Error(`web_search failed — ${failures.join(" | ")}`);
		},
	});
}
