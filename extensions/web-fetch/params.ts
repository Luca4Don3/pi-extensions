/** web_fetch 工具的模型可见参数表。 */
import { Type } from "typebox";
import { DEFAULT_MAX_CHARS, MAX_CHARS_LIMIT } from "./config.js";

/** 内容提取模式：auto 自动判断，article 走正文提取，text 只取纯文本。 */
export const FETCH_MODES = ["auto", "article", "text"] as const;
export type FetchMode = (typeof FETCH_MODES)[number];

export const WebFetchParams = Type.Object({
	url: Type.String({
		description:
			"The absolute http(s) URL to read. Only public addresses are reachable; private, loopback and cloud metadata addresses are refused.",
	}),
	mode: Type.Optional(
		Type.Union(FETCH_MODES.map((mode) => Type.Literal(mode)), {
			description: `How to extract the body. Defaults to auto.`,
		}),
	),
	maxChars: Type.Optional(
		Type.Integer({
			description: `Maximum characters of body text returned to the model. Defaults to ${DEFAULT_MAX_CHARS}.`,
			minimum: 1,
			maximum: MAX_CHARS_LIMIT,
		}),
	),
});

/** 工具返回给程序消费的结构化结果。 */
export interface WebFetchDetails {
	requestedUrl: string;
	finalUrl?: string;
	title?: string;
	contentType?: string;
	provider?: "direct" | "jina";
	statusCode?: number;
	extractedChars?: number;
	truncated?: boolean;
	redirectCount?: number;
	durationMs?: number;
	errorKind?: string;
}
