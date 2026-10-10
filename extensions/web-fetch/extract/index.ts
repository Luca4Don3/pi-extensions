/**
 * 本地正文提取：HTML → 可读 Markdown，Markdown 与纯文本直通，JSON 取文本字段。
 *
 * 第一版不引入 Readability / jsdom / turndown 这类重型依赖，改用基于规则的轻量提取：
 * - 优先在 `<main>`、`<article>` 或常见正文容器里找内容，找不到再回退到 `<body>`；
 * - 把「保留代码块、标题层级、链接、列表与表格」作为首要目标，避免通用阅读模式
 *   把代码示例整段丢掉。
 * 后续若切换成熟库，只需替换本模块，调用方不受影响。
 */

import { FetchError } from "../errors.js";
import type { FetchMode } from "../params.js";

export interface ExtractionResult {
	readonly title?: string;
	readonly markdown: string;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
	"&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

/** 只解码常见命名实体与十进制/十六进制数字实体；不引入依赖。 */
export function decodeEntities(value: string): string {
	return value
		.replace(/&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip);/giu, (match) => ENTITIES[match.toLowerCase()] ?? match)
		.replace(/&#x([0-9a-f]+);/giu, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/gu, (_match, dec: string) => safeCodePoint(Number.parseInt(dec, 10)));
}

function safeCodePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

/** 去掉注释、脚本、样式与模板节点；这些内容不应进入模型上下文。 */
export function stripNoise(html: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/gu, " ")
		.replace(/<script[\s\S]*?<\/script>/giu, " ")
		.replace(/<style[\s\S]*?<\/style>/giu, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/giu, " ")
		.replace(/<template[\s\S]*?<\/template>/giu, " ");
}

/** 常见正文容器；按优先级返回第一个有内容的命中。 */
const CONTAINER_PATTERNS: RegExp[] = [
	/<main\b[^>]*>([\s\S]*?)<\/main>/iu,
	/<article\b[^>]*>([\s\S]*?)<\/article>/iu,
	/<div\b[^>]*(?:class|id)=["'][^"']*(?:markdown-body|md-content|documentation|docs-content|post-content|article-content|entry-content|content-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu,
	/<body\b[^>]*>([\s\S]*?)<\/body>/iu,
];

export function pickContainer(html: string): string {
	for (const pattern of CONTAINER_PATTERNS) {
		const match = html.match(pattern);
		if (match?.[1] !== undefined && match[1]!.trim().length > 0) return match[1]!;
	}
	return html;
}

/** 取 `<title>` 或 og:title。 */
export function extractTitle(html: string): string | undefined {
	const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/iu);
	if (og?.[1] !== undefined) {
		const text = decodeEntities(og[1].trim());
		return text.length > 0 ? text : undefined;
	}
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
	if (title?.[1] !== undefined) {
		const text = decodeEntities(title[1].trim());
		return text.length > 0 ? text : undefined;
	}
	return undefined;
}

/** 去掉所有标签并解码实体。 */
export function stripTags(html: string): string {
	return decodeEntities(html.replace(/<[^>]+>/gu, " "));
}

/** 块级边界转成换行，避免标题、段落与代码块粘连。 */
export function blockify(html: string): string {
	return html
		.replace(/<br\s*\/?>/giu, "\n")
		.replace(/<\/(?:p|div|section|article|main|li|ul|ol|table|thead|tbody|tr|h[1-6]|pre|blockquote)>/giu, "\n")
		.replace(/<(?:h[1-6]|p|li|tr|pre|blockquote|div|section|ul|ol|dl|dt|dd|figure|figcaption|thead|tbody)\b[^>]*>/giu, "\n");
}

/** `<pre>` 包成围栏代码块，尽量保留代码原样。 */
export function fencedCode(html: string): string {
	return html.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/giu, (_match, inner: string) => {
		const code = stripTags(inner).replace(/\n{3,}/gu, "\n\n").trim();
		if (code.length === 0) return "";
		const language = /(?:language|lang)-([\w+-]+)/iu.exec(inner)?.[1];
		return `\n\`\`\`${language ?? ""}\n${code}\n\`\`\`\n`;
	});
}

/** 行内代码。 */
export function inlineCode(html: string): string {
	return html.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/giu, (_match, inner: string) => `\`${stripTags(inner).replace(/\s+/gu, " ").trim()}\``);
}

/** 链接转 Markdown 链接；非 http(s) 只保留文字。 */
export function links(html: string): string {
	return html.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu, (_match, href: string, inner: string) => {
		const label = stripTags(inner).replace(/\s+/gu, " ").trim();
		if (label.length === 0) return "";
		if (!/^https?:\/\//iu.test(href)) return label;
		return `[${label}](${href})`;
	});
}

/** 标题转 Markdown 标题，层级最多到 6。 */
export function headings(html: string): string {
	return html.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level: string, inner: string) => {
		const text = stripTags(inner).replace(/\s+/gu, " ").trim();
		if (text.length === 0) return "";
		return `\n${"#".repeat(Math.min(6, Number(level)))} ${text}\n`;
	});
}

/** 列表项转 Markdown 列表。 */
export function listItems(html: string): string {
	return html.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/giu, (_match, inner: string) => {
		const text = stripTags(inner).replace(/\s+/gu, " ").trim();
		return text.length === 0 ? "" : `- ${text}`;
	});
}

/** 表格转 Markdown 表格。 */
export function tables(html: string): string {
	return html.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/giu, (_match, inner: string) => {
		const rows: string[][] = [];
		for (const row of inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)) {
			const cells: string[] = [];
			for (const cell of row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/giu)) {
				const text = stripTags(cell[1]!).replace(/\s+/gu, " ").trim();
				if (text.length > 0) cells.push(text);
			}
			if (cells.length > 0) rows.push(cells);
		}
		if (rows.length === 0) return "";
		const header = rows[0]!;
		const body = rows.slice(1);
		const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
		const separator = `| ${header.map(() => "---").join(" | ")} |`;
		return `\n${line(header)}\n${separator}\n${body.map(line).join("\n")}\n`;
	});
}

/** 规整空白：压缩空行、清理行首尾空白。 */
export function tidy(text: string): string {
	return text
		.replace(/\r\n?/gu, "\n")
		.replace(/[ \t\f\v]+/gu, " ")
		.replace(/ *\n */gu, "\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
}

/** HTML 提取结果可能带标题；其余分支只保证正文。 */
type ExtractionBase = { markdown: string; title?: string };

/**
 * HTML → Markdown；保留标题、代码块、链接、列表与表格。
 *
 * 顺序很关键：先把代码块与表格整体取出，再把标题 / 列表 / 链接 / 行内代码转成
 * Markdown，最后才把剩余块级边界换成换行。若一开始就 blockify，`</h1>`、`</table>`
 * 这类闭标签会先被破坏，后面的结构化替换就再也匹配不上。
 */
export function htmlToMarkdown(html: string): ExtractionBase {
	const cleaned = stripNoise(html);
	const container = pickContainer(cleaned);
	const withCode = fencedCode(container);
	const withTables = tables(withCode);
	const withHeadings = headings(withTables);
	const withLists = listItems(withHeadings);
	const withLinks = links(withLists);
	const withInlineCode = inlineCode(withLinks);
	// 最后统一清掉仍未识别的标签（例如 void 元素与 head 残留），此时代码块与表格
	// 已转成 Markdown，不会被误伤。
	const markdown = tidy(stripTags(blockify(withInlineCode)));
	const title = extractTitle(cleaned);
	return { ...(title === undefined ? {} : { title }), markdown };
}

/** Markdown 直通；只做常规空白规整。 */
export function markdownToMarkdown(body: string): ExtractionBase {
	const markdown = tidy(body);
	const heading = body.match(/^\s{0,3}#{1,6}\s+(.+)$/mu);
	return { ...(heading?.[1] === undefined ? {} : { title: heading[1].trim() }), markdown };
}

/** 纯文本直通。 */
export function textToMarkdown(body: string): ExtractionBase {
	return { markdown: tidy(body) };
}

/** JSON：取常见文本字段与 http(s) 链接拼成可读正文，不把原始 JSON 整块灌给模型。 */
export function jsonToMarkdown(body: string): ExtractionBase {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return { markdown: "" };
	}
	const texts: string[] = [];
	const visit = (value: unknown, depth: number): void => {
		if (depth > 6 || texts.length > 400) return;
		if (typeof value === "string") {
			const text = value.trim();
			if (text.length > 0) texts.push(text);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		if (value !== null && typeof value === "object") {
			for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
				if (["url", "href", "link"].includes(key.toLowerCase()) && typeof item === "string" && /^https?:\/\//iu.test(item)) {
					texts.push(`- ${item}`);
					continue;
				}
				visit(item, depth + 1);
			}
		}
	};
	visit(parsed, 0);
	const markdown = tidy(texts.join("\n"));
	const title = typeof (parsed as { title?: unknown } | null)?.title === "string" ? (parsed as { title: string }).title : undefined;
	return { ...(title === undefined ? {} : { title }), markdown };
}

/** 内容类型归一化；忽略参数与大小写差异。 */
function normalizeContentType(contentType: string): { type: string; subtype: string } {
	const [main] = contentType.split(";");
	const parts = (main ?? "").trim().toLowerCase().split("/");
	return { type: parts[0] ?? "", subtype: parts[1] ?? "" };
}

/** 没有内容类型时按内容判断是否 HTML。 */
function looksLikeHtml(body: string): boolean {
	return /^\s*<(?:!doctype html|html|head|body|main|article|div|p)\b/iu.test(body);
}

/**
 * 按内容类型与模式选择提取路径。
 * 内容类型不受支持、或提取结果为空时明确失败，不把空正文当作成功返回。
 */
export function extractContent(body: string, contentType: string, mode: FetchMode, maxChars: number): ExtractionResult {
	const { type, subtype } = normalizeContentType(contentType);
	const isHtml = subtype === "html" || subtype === "xhtml+xml" || (type === "" && looksLikeHtml(body));
	const isMarkdown = subtype === "markdown" || subtype === "x-markdown" || subtype === "md";
	const isJson = subtype === "json" || subtype.endsWith("+json");
	const isText = subtype === "plain" || subtype.startsWith("text/");

	const base = isJson
		? jsonToMarkdown(body)
		: isMarkdown
			? markdownToMarkdown(body)
			: isHtml
				? mode === "text"
					? { markdown: tidy(stripTags(pickContainer(stripNoise(body)))) }
					: htmlToMarkdown(body)
				: isText
					? textToMarkdown(body)
					: undefined;
	if (base === undefined) throw new FetchError("目标内容类型不受支持", "unsupported_content");
	const truncated = base.markdown.length > maxChars;
	const markdown = truncated ? `${base.markdown.slice(0, maxChars)}\n\n（正文已截断）` : base.markdown;
	if (markdown.length === 0) throw new FetchError("未能从响应中提取到正文", "extraction_failed");
	return { ...(base.title === undefined ? {} : { title: base.title }), markdown };
}
