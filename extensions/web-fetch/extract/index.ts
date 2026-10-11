/**
 * 本地正文提取：HTML → 可读 Markdown，Markdown 与纯文本直通，JSON 取文本字段。
 * 使用轻量规则处理静态 HTML，不执行脚本，也不引入重型解析依赖。
 */

import { FetchError } from "../errors.js";
import type { FetchMode } from "../params.js";

export interface ExtractionResult {
	readonly title?: string;
	readonly markdown: string;
	readonly truncated: boolean;
}

const ENTITIES: Record<string, string> = {
	"&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'",
	"&nbsp;": " ", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
};

/** 只解码常见命名实体与数字实体一次；不递归解码。 */
export function decodeEntities(value: string): string {
	return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip);|&#x([0-9a-f]+);|&#(\d+);/giu, (match, hex?: string, dec?: string) => {
		if (hex !== undefined) return safeCodePoint(Number.parseInt(hex, 16));
		if (dec !== undefined) return safeCodePoint(Number.parseInt(dec, 10));
		return ENTITIES[match.toLowerCase()] ?? match;
	});
}

function safeCodePoint(value: number): string {
	if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
	try {
		return String.fromCodePoint(value);
	} catch {
		return "";
	}
}

interface ElementRange {
	readonly start: number;
	readonly contentStart: number;
	readonly contentEnd: number;
	readonly end: number;
	readonly attributes: string;
}

interface TagToken {
	readonly start: number;
	readonly end: number;
	readonly closing: boolean;
	readonly selfClosing: boolean;
	readonly attributes: string;
}

function tagEnd(html: string, from: number): number {
	let quote = "";
	for (let index = from; index < html.length; index++) {
		const character = html[index]!;
		if (quote !== "") {
			if (character === quote) quote = "";
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (character === ">") {
			return index + 1;
		}
	}
	return -1;
}

/** 从左至右找下一个指定标签；遇到未结束的标签时停止，避免反复回扫坏 HTML。 */
function findTagToken(html: string, tag: string, from: number): TagToken | undefined {
	let cursor = from;
	while (true) {
		const start = html.indexOf("<", cursor);
		if (start < 0) return undefined;
		const closing = html[start + 1] === "/";
		const nameStart = start + (closing ? 2 : 1);
		const nameEnd = nameStart + tag.length;
		if (html.slice(nameStart, nameEnd).toLowerCase() !== tag.toLowerCase()) {
			cursor = start + 1;
			continue;
		}
		const boundary = html[nameEnd];
		if (boundary !== undefined && boundary !== " " && boundary !== "\t" && boundary !== "\n" && boundary !== "\r" && boundary !== "\f" && boundary !== "/" && boundary !== ">") {
			cursor = start + 1;
			continue;
		}
		const end = tagEnd(html, nameEnd);
		if (end < 0) return undefined;
		const attributes = closing ? "" : html.slice(nameEnd, end - 1);
		return { start, end, closing, selfClosing: !closing && attributes.trimEnd().endsWith("/"), attributes };
	}
}

function findClosingTag(html: string, tag: string, from: number): TagToken | undefined {
	let cursor = from;
	for (let token = findTagToken(html, tag, cursor); token !== undefined; token = findTagToken(html, tag, cursor)) {
		cursor = token.end;
		if (token.closing) return token;
	}
	return undefined;
}

/** 单次栈扫描同名标签；嵌套配对正确，未闭合标签不会导致候选逐个重扫全文。 */
function findElementRange(html: string, tag: string, from = 0, accept?: (attributes: string) => boolean): ElementRange | undefined {
	const stack: Array<{ start: number; contentStart: number; attributes: string; accepted: boolean }> = [];
	let best: ElementRange | undefined;
	let earliestAcceptedStart: number | undefined;
	let cursor = from;
	for (let token = findTagToken(html, tag, cursor); token !== undefined; token = findTagToken(html, tag, cursor)) {
		cursor = token.end;
		if (token.closing) {
			const open = stack.pop();
			if (open?.start === earliestAcceptedStart) earliestAcceptedStart = undefined;
			if (open?.accepted) {
				const range = { start: open.start, contentStart: open.contentStart, contentEnd: token.start, end: token.end, attributes: open.attributes };
				if (best === undefined || range.start < best.start) best = range;
			}
		} else if (!token.selfClosing) {
			const accepted = accept === undefined || accept(token.attributes);
			stack.push({ start: token.start, contentStart: token.end, attributes: token.attributes, accepted });
			if (accepted && earliestAcceptedStart === undefined) earliestAcceptedStart = token.start;
		}
		if (best !== undefined && (earliestAcceptedStart === undefined || earliestAcceptedStart >= best.start)) return best;
	}
	return best;
}

function removeElements(html: string, tags: readonly string[]): string {
	for (const tag of tags) {
		const parts: string[] = [];
		let cursor = 0;
		while (cursor < html.length) {
			const range = findElementRange(html, tag, cursor);
			if (range === undefined) break;
			parts.push(html.slice(cursor, range.start), " ");
			cursor = range.end;
		}
		if (cursor === 0) continue;
		parts.push(html.slice(cursor));
		html = parts.join("");
	}
	return html;
}

function stripComments(html: string): string {
	const parts: string[] = [];
	let cursor = 0;
	while (true) {
		const start = html.indexOf("<!--", cursor);
		if (start < 0) break;
		const end = html.indexOf("-->", start + 4);
		if (end < 0) {
			parts.push(html.slice(cursor, start), " ");
			return parts.join("");
		}
		parts.push(html.slice(cursor, start), " ");
		cursor = end + 3;
	}
	if (cursor === 0) return html;
	parts.push(html.slice(cursor));
	return parts.join("");
}

function removeRawElements(html: string, tag: string): string {
	const parts: string[] = [];
	let cursor = 0;
	let scan = 0;
	while (scan < html.length) {
		const opening = findTagToken(html, tag, scan);
		if (opening === undefined) break;
		scan = opening.end;
		if (opening.closing) continue;
		if (opening.selfClosing) {
			parts.push(html.slice(cursor, opening.start), " ");
			cursor = opening.end;
			continue;
		}
		const closing = findClosingTag(html, tag, opening.end);
		if (closing === undefined) {
			parts.push(html.slice(cursor, opening.start), " ");
			return parts.join("");
		}
		parts.push(html.slice(cursor, opening.start), " ");
		cursor = closing.end;
		scan = cursor;
	}
	if (cursor === 0) return html;
	parts.push(html.slice(cursor));
	return parts.join("");
}

/** 逐个剔除活动内容；未闭合脚本等按安全策略丢弃至输入末尾。 */
export function stripNoise(html: string): string {
	let cleaned = stripComments(html);
	for (const tag of ["script", "style", "noscript", "template"]) cleaned = removeRawElements(cleaned, tag);
	return removeElements(cleaned, ["nav", "aside", "footer", "header"]);
}

const CONTENT_DIV = /(?:markdown-body|md-content|documentation|docs-content|post-content|article-content|entry-content|content-body)/iu;

/** 依次选择 main、article、常见文档容器与 body；同名嵌套元素会完整配对。 */
export function pickContainer(html: string): string {
	const candidates: Array<{ tag: string; accept?: (attributes: string) => boolean }> = [
		{ tag: "main" },
		{ tag: "article" },
		{ tag: "div", accept: (attributes) => CONTENT_DIV.test(attributes) },
		{ tag: "body" },
	];
	for (const candidate of candidates) {
		let from = 0;
		while (from < html.length) {
			const range = findElementRange(html, candidate.tag, from, candidate.accept);
			if (range === undefined) break;
			const content = html.slice(range.contentStart, range.contentEnd);
			if (content.trim().length > 0) return content;
			from = range.end;
		}
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
	const title = findElementRange(html, "title");
	if (title !== undefined) {
		const text = decodeEntities(html.slice(title.contentStart, title.contentEnd).trim());
		return text.length > 0 ? text : undefined;
	}
	return undefined;
}

/** 标签只扫描一次；未结束的标签不反复回扫剩余内容。 */
function replaceMarkup(html: string, replace: (tag: string) => string): string {
	const parts: string[] = [];
	let cursor = 0;
	for (;;) {
		const start = html.indexOf("<", cursor);
		if (start < 0) break;
		const end = tagEnd(html, start + 1);
		if (end < 0) break;
		parts.push(html.slice(cursor, start), replace(html.slice(start, end)));
		cursor = end;
	}
	parts.push(html.slice(cursor));
	return parts.join("");
}

function stripMarkupRaw(html: string): string {
	return replaceMarkup(html, () => " ");
}

/** 去掉标签并解码实体一次。 */
export function stripTags(html: string): string {
	return decodeEntities(stripMarkupRaw(html));
}

/** 块级边界转成换行，避免标题、段落、列表与表格内容粘连。 */
export function blockify(html: string): string {
	return replaceMarkup(html, (tag) => {
		const name = /^<\/?([a-z][\w:-]*)\b/iu.exec(tag)?.[1]?.toLowerCase();
		return name !== undefined && /^(?:br|p|div|section|article|main|li|ul|ol|table|thead|tbody|tr|h[1-6]|pre|blockquote|dl|dt|dd|figure|figcaption|header|footer)$/u.test(name) ? "\n" : tag;
	});
}

function codeText(html: string): string {
	const text = replaceMarkup(html, (tag) => /^<br\b/iu.test(tag) ? "\n" : "");
	return decodeEntities(text);
}

function chooseFence(code: string): string {
	const runs = code.match(/`+/gu) ?? [];
	const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
	return "`".repeat(Math.max(3, longest + 1));
}

function fencedValue(code: string, language = ""): string {
	const fence = chooseFence(code);
	return `${fence}${language}\n${code}${code.endsWith("\n") ? "" : "\n"}${fence}`;
}

function inlineValue(code: string): string {
	const runs = code.match(/`+/gu) ?? [];
	const delimiter = "`".repeat(Math.max(1, runs.reduce((max, run) => Math.max(max, run.length), 0) + 1));
	const pad = code.startsWith("`") || code.endsWith("`") || (code.startsWith(" ") && code.endsWith(" "));
	return `${delimiter}${pad ? " " : ""}${code}${pad ? " " : ""}${delimiter}`;
}

interface CodeTokens {
	readonly html: string;
	readonly values: ReadonlyMap<string, string>;
}

function replacePairedElements(html: string, tag: string, replace: (inner: string, attributes: string) => string): string {
	const parts: string[] = [];
	let copied = 0;
	let scan = 0;
	while (scan < html.length) {
		const opening = findTagToken(html, tag, scan);
		if (opening === undefined) break;
		scan = opening.end;
		if (opening.closing || opening.selfClosing) continue;
		const closing = findClosingTag(html, tag, opening.end);
		if (closing === undefined) break;
		parts.push(html.slice(copied, opening.start), replace(html.slice(opening.end, closing.start), opening.attributes));
		copied = closing.end;
		scan = copied;
	}
	parts.push(html.slice(copied));
	return parts.join("");
}

function isolateCode(html: string, source: string, asText = false): CodeTokens {
	let prefix = "\uE000webfetch-code";
	while (source.includes(prefix)) prefix += "_";
	const values = new Map<string, string>();
	let next = 0;
	const token = (value: string, block: boolean): string => {
		const key = `${prefix}-${next++}\uE001`;
		values.set(key, value);
		return block ? `\n${key}\n` : key;
	};
	let result = replacePairedElements(html, "pre", (inner, attributes) => {
		const value = codeText(inner);
		if (asText) return token(value, true);
		const language = /(?:language|lang)-([\w+-]+)/iu.exec(`${attributes} ${inner}`)?.[1] ?? "";
		return token(fencedValue(value, language), true);
	});
	if (!asText) {
		result = replacePairedElements(result, "code", (inner) => token(inlineValue(codeText(inner)), false));
	}
	return { html: result, values };
}

function restoreTokens(text: string, values: ReadonlyMap<string, string>): string {
	const first = values.keys().next().value;
	if (first === undefined) return text;
	const prefix = first.slice(0, first.lastIndexOf("-") + 1);
	const tokenPattern = new RegExp(`${prefix}\\d+\\uE001`, "gu");
	return text.replace(tokenPattern, (token) => values.get(token) ?? token);
}

/** `<pre>` 转为 Markdown 围栏代码块，保留代码中的空白与实体解码结果。 */
export function fencedCode(html: string): string {
	return replacePairedElements(html, "pre", (inner, attributes) => {
		const code = codeText(inner);
		const language = /(?:language|lang)-([\w+-]+)/iu.exec(`${attributes} ${inner}`)?.[1] ?? "";
		return `\n${fencedValue(code, language)}\n`;
	});
}

/** 转换 HTML 行内代码，保留代码自身空格、制表符与空行。 */
export function inlineCode(html: string): string {
	return replacePairedElements(html, "code", (inner) => inlineValue(codeText(inner)));
}

function safeHref(href: string, baseUrl?: URL): string | undefined {
	const decoded = decodeEntities(href.trim()).replace(/\s/gu, (character) => encodeURIComponent(character));
	try {
		const url = baseUrl === undefined ? new URL(decoded) : new URL(decoded, baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		return url.toString().replace(/[()]/gu, (character) => character === "(" ? "%28" : "%29");
	} catch {
		return undefined;
	}
}

function escapeMarkdownLabel(label: string): string {
	return label.replace(/[\\[\]`]/gu, (character) => `\\${character}`);
}

function protectForFinalDecode(value: string): string {
	return value.replace(/[&<>]/gu, (character) => character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;");
}

function convertLinks(html: string, baseUrl?: URL, deferFinalDecode = false): string {
	return replacePairedElements(html, "a", (inner, attributes) => {
		const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attributes);
		const rawLabel = stripMarkupRaw(inner).replace(/\s+/gu, " ").trim();
		const label = escapeMarkdownLabel(decodeEntities(rawLabel));
		if (label.length === 0) return "";
		const href = hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3];
		const safe = href === undefined ? undefined : safeHref(href, baseUrl);
		const outputLabel = deferFinalDecode ? protectForFinalDecode(label) : label;
		if (safe === undefined) return outputLabel;
		const outputHref = deferFinalDecode ? protectForFinalDecode(safe) : safe;
		return `[${outputLabel}](${outputHref})`;
	});
}

/** 将链接转为 Markdown；仅允许 http(s)，可选地解析相对地址。 */
export function links(html: string, baseUrl?: URL): string {
	return convertLinks(html, baseUrl);
}

function inlineText(html: string): string {
	return stripMarkupRaw(html).replace(/\s+/gu, " ").trim();
}

/** 标题转 Markdown 标题，层级最多到 6。 */
export function headings(html: string): string {
	for (let level = 1; level <= 6; level++) {
		html = replacePairedElements(html, `h${level}`, (inner) => {
			const text = inlineText(inner);
			return text.length === 0 ? "" : `\n${"#".repeat(level)} ${text}\n`;
		});
	}
	return html;
}

/** 列表项转 Markdown 列表。 */
export function listItems(html: string): string {
	return replacePairedElements(html, "li", (inner) => {
		const text = inlineText(inner);
		return text.length === 0 ? "" : `\n- ${text}\n`;
	});
}

/** 表格转 Markdown 表格，保留单元格内的行内链接与代码。 */
export function tables(html: string): string {
	return replacePairedElements(html, "table", (inner) => {
		const rows: string[][] = [];
		replacePairedElements(inner, "tr", (row) => {
			const cells: string[] = [];
			let cursor = 0;
			let th = findTagToken(row, "th", cursor);
			let td = findTagToken(row, "td", cursor);
			for (;;) {
				const opening = th === undefined ? td : td === undefined || th.start < td.start ? th : td;
				if (opening === undefined) break;
				const tag = opening === th ? "th" : "td";
				cursor = opening.end;
				if (!opening.closing && !opening.selfClosing) {
					const closing = findClosingTag(row, tag, cursor);
					if (closing === undefined) break;
					cells.push(inlineText(row.slice(opening.end, closing.start)));
					cursor = closing.end;
				}
				if (th !== undefined && th.start < cursor) th = findTagToken(row, "th", cursor);
				if (td !== undefined && td.start < cursor) td = findTagToken(row, "td", cursor);
			}
			if (cells.some((cell) => cell.length > 0)) rows.push(cells);
			return "";
		});
		if (rows.length === 0) return "";
		// 不按最宽行补齐全部行，避免稀疏畸形表格扩张为行数乘最大列数。
		const normalized = rows.map((row) => row.map((cell) => cell.replace(/\|/gu, "\\|")));
		const width = normalized[0]!.length;
		const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
		const separator = `| ${Array.from({ length: width }, () => "---").join(" | ")} |`;
		return `\n${line(normalized[0]!)}\n${separator}\n${normalized.slice(1).map(line).join("\n")}\n`;
	});
}

/** 仅供 HTML/JSON 整理使用；直读 Markdown 与纯文本不会经过此空白压缩。 */
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

/** HTML → Markdown；代码先隔离，经过其他转换后再恢复，避免解码的 `<T>` 被当作标签。 */
export function htmlToMarkdown(html: string, baseUrl?: URL): ExtractionBase {
	const cleaned = stripNoise(html);
	const title = extractTitle(cleaned);
	const isolated = isolateCode(pickContainer(cleaned), cleaned);
	const withLinks = convertLinks(isolated.html, baseUrl, true);
	const withTables = tables(withLinks);
	const withHeadings = headings(withTables);
	const withLists = listItems(withHeadings);
	const markdown = restoreTokens(tidy(decodeEntities(stripMarkupRaw(blockify(withLists)))), isolated.values);
	return { ...(title === undefined ? {} : { title }), markdown };
}

function htmlToText(html: string): string {
	const cleaned = stripNoise(html);
	const isolated = isolateCode(pickContainer(cleaned), cleaned, true);
	const flattened = decodeEntities(stripMarkupRaw(blockify(isolated.html)));
	return restoreTokens(tidy(flattened), isolated.values);
}

/** Markdown 直读不规整空白，避免损坏代码缩进、制表符与空行。 */
export function markdownToMarkdown(body: string): ExtractionBase {
	const markdown = body;
	const heading = body.match(/^\s{0,3}#{1,6}\s+(.+)$/mu);
	return { ...(heading?.[1] === undefined ? {} : { title: heading[1].trim() }), markdown };
}

/** 纯文本直读不规整空白，保留缩进、制表符、尖括号与空行。 */
export function textToMarkdown(body: string): ExtractionBase {
	return { markdown: body };
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

function safeSlice(value: string, maxLength: number): string {
	let end = Math.max(0, Math.min(value.length, maxLength));
	if (end > 0 && end < value.length) {
		const current = value.charCodeAt(end);
		const previous = value.charCodeAt(end - 1);
		if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) end--;
	}
	return value.slice(0, end);
}

interface OpenFence {
	readonly marker: string;
	readonly start: number;
}

function openFenceAtEnd(text: string): OpenFence | undefined {
	let open: OpenFence | undefined;
	let lineStart = 0;
	for (const line of text.split("\n")) {
		const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence !== null) {
			const marker = fence[1]!;
			if (open === undefined) {
				if (!(marker[0] === "`" && fence[2]!.includes("`"))) open = { marker, start: lineStart };
			} else if (marker[0] === open.marker[0] && marker.length >= open.marker.length && /^[ \t]*$/u.test(fence[2]!)) {
				open = undefined;
			}
		}
		lineStart += line.length + 1;
	}
	return open;
}

function truncationNotice(maxChars: number): string {
	const full = "\n\n（正文已截断）";
	if (maxChars >= full.length) return full;
	if (maxChars >= 3) return "截断…";
	return maxChars > 0 ? "…" : "";
}

function truncateMarkdown(markdown: string, maxChars: number): string {
	const limit = Math.max(0, maxChars);
	const notice = truncationNotice(limit);
	let prefix = safeSlice(markdown, limit - notice.length);
	for (let attempt = 0; attempt < 8; attempt++) {
		const open = openFenceAtEnd(prefix);
		if (open === undefined) return `${prefix}${notice}`;
		const closing = `${prefix.endsWith("\n") ? "" : "\n"}${open.marker}`;
		if (prefix.length + closing.length + notice.length <= limit) return `${prefix}${closing}${notice}`;
		const nextLength = limit - closing.length - notice.length;
		if (nextLength <= open.start) {
			prefix = safeSlice(markdown, open.start);
			return `${safeSlice(prefix, limit - notice.length)}${notice}`;
		}
		prefix = safeSlice(markdown, nextLength);
	}
	return `${safeSlice(markdown, limit - notice.length)}${notice}`;
}

/**
 * 按内容类型与模式选择提取路径。可选 baseUrl 只用于本地链接绝对化，不会触发请求。
 * 只有内容长度严格大于 maxChars 时才设置 truncated。
 */
export function extractContent(body: string, contentType: string, mode: FetchMode, maxChars: number, baseUrl?: URL): ExtractionResult {
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
					? { markdown: htmlToText(body) }
					: htmlToMarkdown(body, baseUrl)
				: isText
					? textToMarkdown(body)
					: undefined;
	if (base === undefined) throw new FetchError("目标内容类型不受支持", "unsupported_content");
	if (base.markdown.trim().length === 0) throw new FetchError("未能从响应中提取到正文", "extraction_failed");
	const truncated = base.markdown.length > maxChars;
	const markdown = truncated ? truncateMarkdown(base.markdown, maxChars) : base.markdown;
	return { ...(base.title === undefined ? {} : { title: base.title }), markdown, truncated };
}
