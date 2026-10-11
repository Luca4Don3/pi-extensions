/** 有界、可取消的流式响应正文读取。 */

import { FetchError } from "../errors.js";

function getCharset(response: Response, explicit?: string): string {
	if (explicit !== undefined) return explicit.trim();
	const contentType = response.headers.get("content-type") ?? "";
	const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^;\s]*))/iu.exec(contentType);
	return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "utf-8").trim();
}

function decoderFor(response: Response, charset?: string): TextDecoder {
	try {
		return new TextDecoder(getCharset(response, charset), { fatal: true });
	} catch {
		throw new FetchError("目标声明了不支持的字符集", "unsupported_content");
	}
}

/** 通过函数每次读取动态状态，避免将异步前的状态错误收窄为永远未取消。 */
function isAborted(controller?: AbortController): boolean {
	return controller?.signal.aborted === true;
}

function abortError(signal?: AbortSignal): FetchError {
	const reason = signal?.reason;
	if (reason instanceof FetchError && (reason.kind === "timeout" || reason.kind === "aborted" || reason.kind === "response_too_large")) {
		return reason;
	}
	return new FetchError("操作已取消", "aborted");
}

/** 发起取消但不等待不可信流的 cancel() 完成，并消费迟到拒绝。 */
function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
	try {
		void Promise.resolve(reader.cancel(reason)).catch(() => undefined);
	} catch {
		// 已有 pending read 或锁状态异常时，取消请求本身仍已发出。
	}
}

function cancelUnlockedBody(response: Response): void {
	try {
		const cancellation = response.body?.cancel();
		if (cancellation !== undefined) void Promise.resolve(cancellation).catch(() => undefined);
	} catch {
		// 被其他 reader 锁定时由 AbortController 负责停止底层请求。
	}
}

/** 与 AbortSignal 竞速读取；迟到的 read 拒绝会被消费。 */
function readWithAbort(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal?: AbortSignal,
	onLateRead?: () => void,
): Promise<ReadableStreamReadResult<Uint8Array>> {
	if (signal === undefined) return Promise.resolve().then(() => reader.read());
	if (signal.aborted) {
		cancelReader(reader, signal.reason);
		return Promise.reject(abortError(signal));
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = (): void => {
			cancelReader(reader, signal.reason);
			finish(() => reject(abortError(signal)));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		let pending: Promise<ReadableStreamReadResult<Uint8Array>>;
		try {
			pending = reader.read();
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		Promise.resolve(pending).then(
			(value) => {
				if (settled) onLateRead?.();
				else finish(() => resolve(value));
			},
			(error: unknown) => {
				if (settled) onLateRead?.();
				else finish(() => reject(signal.aborted ? abortError(signal) : error));
			},
		);
	});
}

/**
 * 读取完整正文并按实际字节数限制大小；失败或超限时不返回部分正文。
 * charset 可显式指定，省略时从响应 content-type 读取，未声明则使用 UTF-8。
 */
export async function readResponseTextLimited(
	response: Response,
	maxBytes: number,
	controller?: AbortController,
	charset?: string,
): Promise<string> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes 必须是正整数");
	if (isAborted(controller)) {
		cancelUnlockedBody(response);
		throw abortError(controller?.signal);
	}
	const body = response.body;
	if (body === null || body === undefined) return "";

	let decoder: TextDecoder;
	try {
		decoder = decoderFor(response, charset);
	} catch (error) {
		cancelUnlockedBody(response);
		controller?.abort(error);
		throw error;
	}

	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = body.getReader();
	} catch {
		const error = new FetchError("响应正文不可读取", "network_error");
		cancelUnlockedBody(response);
		controller?.abort(error);
		throw error;
	}

	const parts: string[] = [];
	let total = 0;
	let succeeded = false;
	let released = false;
	const releaseReader = (): void => {
		if (released) return;
		try {
			reader.releaseLock();
			released = true;
		} catch {
			// 存在 pending read 时，迟到完成回调会再次尝试释放。
		}
	};
	try {
		for (;;) {
			if (isAborted(controller)) throw abortError(controller?.signal);
			const { done, value } = await readWithAbort(reader, controller?.signal, releaseReader);
			if (isAborted(controller)) throw abortError(controller?.signal);
			if (done) break;
			if (value === undefined) continue;
			total += value.byteLength;
			if (total > maxBytes) {
				const error = new FetchError("响应体超过上限", "response_too_large");
				controller?.abort(error);
				cancelReader(reader, error);
				throw error;
			}
			try {
				const text = decoder.decode(value, { stream: true });
				if (text.length > 0) parts.push(text);
			} catch {
				throw new FetchError("响应正文无法按声明字符集解码", "unsupported_content");
			}
		}
		if (isAborted(controller)) throw abortError(controller?.signal);
		try {
			const tail = decoder.decode();
			if (tail.length > 0) parts.push(tail);
		} catch {
			throw new FetchError("响应正文无法按声明字符集解码", "unsupported_content");
		}
		if (isAborted(controller)) throw abortError(controller?.signal);
		succeeded = true;
		return parts.join("");
	} catch (error) {
		if (isAborted(controller) && !(error instanceof FetchError && error.kind === "response_too_large")) {
			throw abortError(controller?.signal);
		}
		throw error;
	} finally {
		if (!succeeded) cancelReader(reader, controller?.signal.reason);
		releaseReader();
	}
}
