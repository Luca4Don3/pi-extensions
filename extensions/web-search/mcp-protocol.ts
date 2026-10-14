import { BackendError, messageKind } from "./search-core.js";

/** 只保留单条协议消息内合法的非空文本块，不拼接不同响应。 */
function parsePayload(line: string): string[] | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const envelope = parsed as { error?: unknown; result?: { content?: unknown; isError?: boolean } };
	if (envelope.error !== undefined) {
		const error = envelope.error;
		const detail = typeof error === "string" ? error
			: error !== null && typeof error === "object" ? (error as { message?: unknown }).message : undefined;
		const message = typeof detail === "string" && detail.length > 0 ? detail : "MCP search error";
		throw new BackendError(message, messageKind(message) ?? "protocol_error");
	}
	const content = envelope.result?.content;
	const texts: string[] = [];
	if (Array.isArray(content)) {
		for (const entry of content) {
			if (entry !== null && typeof entry === "object" && entry.type === "text"
				&& typeof entry.text === "string" && entry.text.trim().length > 0) texts.push(entry.text);
		}
	}
	if (envelope.result?.isError === true) {
		const message = texts.length > 0 ? texts.join("\n\n") : "MCP search tool failed";
		throw new BackendError(message, messageKind(message) ?? "protocol_error");
	}
	return texts.length > 0 ? texts : undefined;
}

/** 保留原有终止语义：直接响应或首个可用事件，不合并不同协议消息。 */
export function parseMcpResponse(body: string): string[] | undefined {
	const trimmed = body.trim();
	if (trimmed.startsWith("{")) {
		const direct = parsePayload(trimmed);
		if (direct !== undefined) return direct;
	}
	let buffer: string[] = [];
	const flush = (): string[] | undefined => {
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
		if (line.trim().length === 0) {
			const found = flush();
			if (found !== undefined) return found;
		}
	}
	return flush();
}
