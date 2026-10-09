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

type FetchLike = (input: unknown, init?: Record<string, unknown>) => Promise<Response>;
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

function isAborted(init: Record<string, unknown> | undefined): boolean {
	const signal = init?.signal;
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
		"ECONNRESET",
		"EAI_AGAIN",
		"ENETUNREACH",
		"ENOTFOUND",
		"ETIMEDOUT",
		"UND_ERR_CONNECT_TIMEOUT",
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_SOCKET",
	].includes(code)) {
		return true;
	}
	return error instanceof TypeError && error.message === "fetch failed";
}

function withDispatcher(init: Record<string, unknown> | undefined, dispatcher: Dispatcher): Record<string, unknown> {
	return { ...(init ?? {}), dispatcher };
}

/** 从请求体里读出 model 名（Pi 的请求体是 JSON 字符串）。 */
function readModelFromBody(body: unknown): string | undefined {
	if (typeof body !== "string") return undefined;
	try {
		const parsed = JSON.parse(body) as { model?: unknown };
		return typeof parsed.model === "string" ? parsed.model : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 判断该请求是否属于「必须固定走代理」的模型：GPT / Grok / Muse / Claude。
 *
 * - `/responses`：opencode-go 下当前只有 GPT / Grok / Muse，端点即可判定。
 * - `/messages`：同一端点下还混有 minimax / qwen，必须看请求体里的 model。
 *
 * 这些模型存在地区限制，且会话路由要求出口稳定，所以既不尝试直连、也不回退直连。
 */
export function needsPinnedProxy(input: unknown, init?: Record<string, unknown>): boolean {
	const url = getUrl(input);
	if (url === undefined || !isOpencodeRequest(input)) return false;
	if (url.pathname.endsWith("/responses")) return true;
	if (url.pathname.endsWith("/messages")) {
		const model = readModelFromBody(init?.body);
		return typeof model === "string" && /^claude-/iu.test(model);
	}
	return false;
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
		if (needsPinnedProxy(input, init)) {
			return Reflect.apply(originalFetch, this, [input, withDispatcher(init, proxyAgent)]);
		}

		// 其余模型保持原行为：直连优先，仅连接类失败才回退代理。
		try {
			return await Reflect.apply(originalFetch, this, [input, withDispatcher(init, directAgent)]);
		} catch (error) {
			if (isAborted(init) || !isConnectionFailure(error)) throw error;
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
