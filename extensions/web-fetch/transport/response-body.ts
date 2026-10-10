/**
 * 有界流式响应读取。
 *
 * 与 web-search 的同名模块刻意保持独立实现：两个扩展可分别安装、分别升级，
 * 不互相 import，避免一边改动破坏另一边。这里统计的是实际交付并解压后的字节数，
 * 不信任 `Content-Length`。
 */

import { FetchError } from "../errors.js";

/** 增量 UTF-8 解码器；跨数据块的中文字符不会被切开。 */
function createIncrementalDecoder(): { decode(chunk: Uint8Array): string } {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	return { decode: (chunk) => decoder.decode(chunk, { stream: true }) };
}

/** 取消底层响应体；迟到拒绝必须被消费，避免成为未处理异常。 */
async function cancelBody(response: Response): Promise<void> {
	try {
		const cancel = response.body?.cancel();
		if (cancel !== undefined) await Promise.resolve(cancel);
	} catch {
		// 清理失败不能改变已经确定的分类结果。
	}
}

/**
 * 读取响应正文，累计实际字节数；超过上限立即取消底层请求并失败，
 * 不返回任何部分内容。取消与超时会透传，不会被包装成别的分类。
 */
export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	controller?: AbortController,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes 必须是正整数");
	// 取消可能发生在拿到响应之后、开始读取之前；此时必须立即失败，不能继续读。
	if (controller?.signal.aborted === true) throw new FetchError("操作已取消", "aborted");
	const body = response.body;
	if (body === null || body === undefined) return "";
	const reader = body.getReader();
	const parts: string[] = [];
	const { decode } = createIncrementalDecoder();
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				await cancelBody(response);
				controller?.abort();
				throw new FetchError("响应体超过上限", "response_too_large");
			}
			const text = decode(value);
			if (text.length > 0) parts.push(text);
		}
		const tail = decode(new Uint8Array());
		if (tail.length > 0) parts.push(tail);
		return parts.join("");
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// 流已结束或已取消时释放锁失败可以忽略。
		}
	}
}
