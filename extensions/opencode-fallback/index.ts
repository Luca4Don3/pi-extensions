import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const OPENCODE_HOST = "opencode.ai";
/** 默认代理地址，指向本机常见的 HTTP 代理端口；可用 PI_OPENCODE_PROXY 覆盖。 */
const DEFAULT_OPENCODE_PROXY = "http://127.0.0.1:7897";

/** 解析应使用的代理地址：环境变量优先，否则用默认值。 */
export function resolveProxyUrl(): string {
	const raw = process.env.PI_OPENCODE_PROXY;
	return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : DEFAULT_OPENCODE_PROXY;
}
const FALLBACK_STATE = Symbol.for("pi.opencode-direct-fallback");

type FetchLike = (input: Parameters<typeof globalThis.fetch>[0], init?: Record<string, unknown>) => Promise<Response>;
type Dispatcher = object;

interface UndiciModule {
	Agent: new (options?: Record<string, unknown>) => Dispatcher;
	ProxyAgent: new (proxy: string) => Dispatcher;
}

interface FallbackState {
	originalFetch: typeof globalThis.fetch;
	directAgent: Dispatcher;
	proxyAgent: Dispatcher;
}

function getUrl(input: unknown): URL | undefined {
	try {
		if (typeof input === "string" || input instanceof URL) {
			return new URL(String(input));
		}
		if (input && typeof input === "object" && "url" in input) {
			return new URL(String((input as { url: unknown }).url));
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function isOpencodeRequest(input: unknown): boolean {
	const hostname = getUrl(input)?.hostname.toLowerCase().replace(/\.$/, "");
	return hostname === OPENCODE_HOST || hostname?.endsWith(`.${OPENCODE_HOST}`) === true;
}

function isAborted(input: unknown, init: Record<string, unknown> | undefined): boolean {
	const signal = init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal;
	return Boolean(signal && typeof signal === "object" && "aborted" in signal && signal.aborted);
}

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = error as { code?: unknown; cause?: { code?: unknown } };
	if (typeof value.code === "string") return value.code;
	if (typeof value.cause?.code === "string") return value.cause.code;
	return undefined;
}

export function isConnectionFailure(error: unknown): boolean {
	const code = errorCode(error);
	if (code && [
		"ECONNREFUSED",
		"EAI_AGAIN",
		"ENETUNREACH",
		"ENOTFOUND",
		"UND_ERR_CONNECT_TIMEOUT",
	].includes(code)) {
		return true;
	}
	return false;
}

function withDispatcher(init: Record<string, unknown> | undefined, dispatcher: Dispatcher): Record<string, unknown> {
	return { ...(init ?? {}), dispatcher };
}

export const ROUTING_BODY_MAX_BYTES = 1024 * 1024;
export const ROUTING_BODY_TIMEOUT_MS = 250;

/** 只解码有严格大小上限的常见正文；未知类型保持保守路由。 */
function readModelFromBody(body: unknown): string | undefined {
	let text: string;
	if (typeof body === "string") {
		if (body.length > ROUTING_BODY_MAX_BYTES || Buffer.byteLength(body) > ROUTING_BODY_MAX_BYTES) {
			throw new Error("opencode-fallback: routing body too large");
		}
		text = body;
	} else if (body instanceof Uint8Array) {
		if (body.byteLength > ROUTING_BODY_MAX_BYTES) throw new Error("opencode-fallback: routing body too large");
		text = new TextDecoder().decode(body);
	} else {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as { model?: unknown } | null;
		return typeof parsed?.model === "string" ? parsed.model : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 判断该请求是否属于「必须固定走代理」的模型：GPT / Grok / Muse / Claude。
 *
 * - `/responses`：opencode-go 下当前只有 GPT / Grok / Muse，端点即可判定。
 * - `/messages`：仅已识别的 minimax / qwen 允许直连，其余及未知模型固定代理。
 *
 * 这些模型存在地区限制，且会话路由要求出口稳定，所以既不尝试直连、也不回退直连。
 */
export function needsPinnedProxy(input: unknown, init?: Record<string, unknown>): boolean {
	const url = getUrl(input);
	if (url === undefined || !isOpencodeRequest(input)) return false;
	if (url.pathname.endsWith("/responses")) return true;
	if (url.pathname.endsWith("/messages")) {
		const model = readModelFromBody(init?.body);
		return typeof model !== "string" || !/^(minimax-|qwen)/iu.test(model);
	}
	return false;
}

/** 副本读取受独立期限和累计字节上限约束；取消不等待底层流配合。 */
async function needsPinnedProxyWithRequest(input: unknown, init?: Record<string, unknown>): Promise<boolean> {
	if (!getUrl(input)?.pathname.endsWith("/messages")) return needsPinnedProxy(input, init);
	const signal = (init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal) as AbortSignal | null | undefined;
	signal?.throwIfAborted();
	let body = init?.body;
	let stream: ReadableStream<Uint8Array> | null = null;
	let originalBody: ReadableStream<Uint8Array> | null = null;
	if (body == null && input instanceof Request) {
		stream = input.clone().body;
		originalBody = input.body;
	} else if (body instanceof Blob) {
		if (body.size > ROUTING_BODY_MAX_BYTES) throw new Error("opencode-fallback: routing body too large");
		stream = body.stream();
	}
	if (!stream) return needsPinnedProxy(input, { ...init, body });
	const reader = stream.getReader();
	const deadline = Date.now() + ROUTING_BODY_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	const stopped = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error("opencode-fallback: routing body timeout")), ROUTING_BODY_TIMEOUT_MS);
		onAbort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
	try {
		const chunks: Uint8Array[] = [];
		let size = 0;
		let reads = 0;
		while (true) {
			// 同时限制分块数，避免空分块或极碎分块累积等待回调。
			if (++reads > 16_384) throw new Error("opencode-fallback: routing body too fragmented");
			signal?.throwIfAborted();
			if (Date.now() >= deadline) throw new Error("opencode-fallback: routing body timeout");
			const result = await Promise.race([reader.read(), stopped]);
			if (result.done) break;
			size += result.value.byteLength;
			if (size > ROUTING_BODY_MAX_BYTES) throw new Error("opencode-fallback: routing body too large");
			if (result.value.byteLength) chunks.push(result.value);
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		body = bytes;
		return needsPinnedProxy(input, { ...init, body });
	} catch (error) {
		// 路由失败时同时关闭原分支，释放生产器；成功时保留正文供发送。
		// 取消可能永不完成或迟到拒绝，不能等待，也不能覆盖路由异常。
		try { void originalBody?.cancel().catch(() => {}); } catch { /* 保留原路由异常。 */ }
		throw error;
	} finally {
		clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
		// 副本的取消可能等待原分支，不能无界等待，也不能遗漏迟到拒绝。
		try { void reader.cancel().catch(() => {}); } catch { /* 取消失败不覆盖原错误。 */ }
	}
}

export function createOpencodeFallbackFetch(
	originalFetch: FetchLike,
	directAgent: Dispatcher,
	proxyAgent: Dispatcher,
): FetchLike {
	return async function (this: unknown, input: unknown, init?: Record<string, unknown>): Promise<Response> {
		if (!isOpencodeRequest(input)) {
			return Reflect.apply(originalFetch, this, [input, init]);
		}

		// GPT / Grok / Muse / Claude：固定走代理，不尝试直连，避免出口漂移。
		if (await needsPinnedProxyWithRequest(input, init)) {
			return Reflect.apply(originalFetch, this, [input, withDispatcher(init, proxyAgent)]);
		}

		// 非安全方法绝不重放；底层错误无法证明模型请求尚未发出。
		const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const reusable = init?.body == null && (!(input instanceof Request) || (!input.body && !input.bodyUsed));
		const canRetry = ["GET", "HEAD", "OPTIONS"].includes(method) && reusable;
		try {
			return await Reflect.apply(originalFetch, this, [input, withDispatcher(init, directAgent)]);
		} catch (error) {
			if (!canRetry || isAborted(input, init) || (error instanceof Error && error.name === "AbortError") || !isConnectionFailure(error)) throw error;
			return Reflect.apply(originalFetch, this, [input, withDispatcher(init, proxyAgent)]);
		}
	};
}

function loadUndici(): UndiciModule {
	// bin/pi is a symlink (e.g. nvm); module resolution must start from the
	// real location of pi's installation, where its own undici dependency lives.
	const candidates = [process.argv[1], process.execPath];
	for (const entry of candidates) {
		if (!entry) continue;
		let base = entry;
		try {
			base = realpathSync(entry);
		} catch {
			// keep entry as-is
		}
		try {
			return createRequire(base)("undici") as UndiciModule;
		} catch {
			// try next candidate
		}
	}
	throw new Error("opencode-direct-fallback: cannot locate undici (is pi installed with its dependencies?)");
}

function installFallback(): void {
	const globalState = globalThis as unknown as Record<PropertyKey, unknown>;
	if (globalState[FALLBACK_STATE]) return;

	const undici = loadUndici();
	const directAgent = new undici.Agent({
		connect: { timeout: 10_000 },
	});
	const proxyAgent = new undici.ProxyAgent(resolveProxyUrl());
	const originalFetch = globalThis.fetch;
	const wrappedFetch = createOpencodeFallbackFetch(originalFetch.bind(globalThis), directAgent, proxyAgent);
	globalThis.fetch = wrappedFetch as typeof globalThis.fetch;
	globalState[FALLBACK_STATE] = { originalFetch, directAgent, proxyAgent } satisfies FallbackState;
}

export default function opencodeDirectFallback(_pi: ExtensionAPI): void {
	installFallback();
}
