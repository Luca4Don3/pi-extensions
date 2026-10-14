import type { Message } from "@earendil-works/pi-ai";

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const texts = msg.content.filter((part) => part?.type === "text" && typeof part.text === "string");
		if (texts.length) return texts.map((part) => (part as { text: string }).text).join("");
	}
	return "";
}
