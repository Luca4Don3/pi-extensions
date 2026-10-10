/**
 * Web Search 认证语义层
 *
 * 把「key 从哪来、当前是什么状态、如何安全地配置」收敛到一处，供工具入口与
 * `/web-search-auth` 菜单共用：
 * - 解析顺序固定为「环境变量优先，其次系统密钥库」。
 * - 每次搜索只为可能用到的后端各解析一次，结果只在内存中流转。
 * - 系统密钥库读取失败不阻断匿名搜索，但状态要在菜单里区分
 *   unavailable（密钥库不可用）与 not_configured（可用但没配）。
 * - 所有对外文本（错误、说明）都经 {@link redactSecrets} 处理，key 永不外泄。
 *
 * @module pi-web-search-auth
 */

import {
	SECRET_SERVICE_PREFIX,
	SECRET_TOOL_SERVICE,
	type SecretBackend,
	type SecretStore,
} from "./credentials.js";
import {
	getProviderMetadata,
	hasAnonymousChannel,
	isProviderId,
	PROVIDER_IDS,
	supportsKeyChannel,
} from "./search/registry.js";

/** 后端标识（与存储层共用）。 */
export type Backend = SecretBackend;

/** 凭据来源。 */
export type AuthSource = "env" | "keychain" | "secret-tool";

/** 单个后端的认证状态。 */
export interface BackendStatus {
	backend: Backend;
	/** configured：已配置；not_configured：密钥库可用但无条目；credential_free：零凭据通道，无需密钥；unavailable：密钥库不可用。 */
	state: "configured" | "not_configured" | "credential_free" | "unavailable";
	/** 仅在 configured 时给出凭据来源。 */
	source?: AuthSource;
	/** 仅在 unavailable 时给出不含敏感信息的诊断原因。 */
	reason?: string;
}

/** 认证菜单、凭据解析与搜索能力共用同一注册表。 */
export const BACKENDS: readonly Backend[] = PROVIDER_IDS;
/** 仅可能计费的后端进入凭据解析；纯匿名后端（如 TinyFish keyless）不读取任何密钥。 */
export const KEY_BACKENDS: readonly Backend[] = BACKENDS.filter(supportsKeyChannel);

/** 运行时白名单，避免非法选择进入凭据操作。 */
export function isBackend(value: unknown): value is Backend {
	return isProviderId(value);
}

/** 匿名能力来自注册表，不能以是否配置密钥判断费用。 */
export function hasFreeChannel(backend: Backend): boolean {
	return hasAnonymousChannel(backend);
}

/** 后端对应的环境变量名。 */
export function envVarName(backend: Backend): string {
	return getProviderMetadata(backend).envVar;
}

/** 不读取环境或密钥库的空凭据映射。 */
export function emptyPlanKeys(): Record<Backend, string | undefined> {
	return Object.fromEntries(BACKENDS.map((backend) => [backend, undefined])) as Record<Backend, string | undefined>;
}

/** 读取环境变量中的 key；空白视为未配置。 */
export function envKey(backend: Backend): string | undefined {
	const value = process.env[envVarName(backend)];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function abortError(): DOMException {
	return new DOMException("操作已取消", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

/** 允许上层取消等待，同时消费底层稍后到达的结果或异常。 */
function waitForAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		// 凭据读取可能在构造 Promise 时同步触发取消，仍须消费其迟到的拒绝。
		void promise.catch(() => undefined);
		return Promise.reject(abortError());
	}
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			settle();
		};
		const onAbort = (): void => finish(() => reject(abortError()));
		signal.addEventListener("abort", onAbort, { once: true });
		Promise.resolve(promise).then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
		if (signal.aborted) onAbort();
	});
}

/**
 * 解析单个后端的 key：环境变量优先，其次系统密钥库。
 * 任何读取失败都静默回退为 undefined，保证匿名搜索不被密钥库问题阻断。
 */
export async function resolveBackendKey(
	backend: Backend,
	store: SecretStore,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfAborted(signal);
	const fromEnv = envKey(backend);
	if (fromEnv !== undefined) return fromEnv;
	let result: Awaited<ReturnType<SecretStore["read"]>>;
	try {
		result = await store.read(backend, signal);
	} catch {
		throwIfAborted(signal);
		return undefined;
	}
	throwIfAborted(signal);
	return result.status === "found" ? result.value : undefined;
}

/**
 * 为一次搜索解析路由所需的全部 key：每个可能用到的后端只读一次密钥库。
 * 显式指定后端时只解析该后端，auto 解析全部后端。
 */
export async function resolvePlanKeys(
	provider: "auto" | Backend,
	store: SecretStore,
	signal?: AbortSignal,
): Promise<Record<Backend, string | undefined>> {
	throwIfAborted(signal);
	const needed = provider === "auto" ? KEY_BACKENDS : ([provider] as readonly Backend[]).filter(supportsKeyChannel);
	const entries = await waitForAbort(Promise.all(
		needed.map(async (backend): Promise<[Backend, string | undefined]> => [
			backend,
			await resolveBackendKey(backend, store, signal),
		]),
	), signal);
	throwIfAborted(signal);
	const keys = emptyPlanKeys();
	for (const [backend, key] of entries) keys[backend] = key;
	return keys;
}

/** 查询单个后端的认证状态；不抛错，密钥库失败归入 unavailable。 */
export async function probeBackendStatus(backend: Backend, store: SecretStore): Promise<BackendStatus> {
	// 零凭据通道（如 TinyFish keyless）既不读密钥环境变量也不读密钥库，
	// 否则「查看状态」本身就会变成一次未经授权的凭据访问。
	if (!supportsKeyChannel(backend)) return { backend, state: "credential_free" };
	const fromEnv = envKey(backend);
	if (fromEnv !== undefined) return { backend, state: "configured", source: "env" };
	let result: Awaited<ReturnType<SecretStore["read"]>>;
	try {
		result = await store.read(backend);
	} catch {
		return { backend, state: "unavailable", reason: "系统密钥库读取异常" };
	}
	if (result.status === "found") {
		return { backend, state: "configured", source: store.kind === "none" ? undefined : store.kind };
	}
	if (result.status === "missing") return { backend, state: "not_configured" };
	return { backend, state: "unavailable", reason: result.reason };
}

/**
 * 把可能混入的来源文本中的 key 抹掉。
 * 同时覆盖原文与 URL 编码形式（如 `a+b/c` 与 `a%2Bb%2Fc`），
 * 确保 HTTP / MCP / 网络错误与 fallbackReason 都不会泄露凭据。
 */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
	let safe = text;
	for (const secret of secrets) {
		if (secret === undefined || secret.length === 0) continue;
		safe = safe.split(secret).join("***");
		const encodedForms = new Set([
			encodeURIComponent(secret),
			new URLSearchParams({ key: secret }).toString().slice("key=".length),
			encodeURIComponent(encodeURIComponent(secret)),
		]);
		for (const encoded of encodedForms) {
			if (encoded.length === 0 || encoded === secret) continue;
			// URL 百分号转义的十六进制字母大小写不敏感，但 key 中原始字母大小写仍敏感。
			const regexSpecials = new Set([".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);
			let pattern = "";
			for (let index = 0; index < encoded.length; index++) {
				const character = encoded[index]!;
				const hex = encoded.slice(index + 1, index + 3);
				if (character === "%" && /^[0-9a-f]{2}$/iu.test(hex)) {
					pattern += "%";
					for (const digit of hex) {
						const lower = digit.toLowerCase();
						const upper = digit.toUpperCase();
						pattern += lower === upper ? digit : `[${upper}${lower}]`;
					}
					index += 2;
				} else {
					pattern += regexSpecials.has(character) ? `\\${character}` : character;
				}
			}
			safe = safe.replace(new RegExp(pattern, "gu"), "***");
		}
	}
	return safe;
}

/** 单行诊断文本的长度上限。 */
export const MAX_DIAGNOSTIC_CHARS = 300;

/** 先脱敏、再截断，避免截断把 key 的片段留在文本里。 */
export function safeDiagnostic(error: unknown, secrets: readonly (string | undefined)[] = []): string {
	const raw = error instanceof Error ? error.message : String(error);
	const safe = redactSecrets(raw, secrets);
	return safe.length > MAX_DIAGNOSTIC_CHARS ? `${safe.slice(0, MAX_DIAGNOSTIC_CHARS)}…` : safe;
}

/** 一个后端的配置说明：命令只从 stdin / 交互提示读取 key，绝不放进参数。 */
export interface ConfigGuide {
	backend: Backend;
	kind: SecretStore["kind"];
	/** 供菜单显示的多行说明。 */
	lines: string[];
}

/** 生成单后端的配置说明（安全终端命令）。 */
export function configGuide(backend: Backend, kind: SecretStore["kind"]): ConfigGuide {
	const variable = envVarName(backend);
	if (kind === "keychain") {
		const service = `${SECRET_SERVICE_PREFIX}-${backend}`;
		return {
			backend,
			kind,
			lines: [
				`macOS Keychain（service: ${service}）`,
				"在终端交互模式运行 /web-search-auth，选择「添加或修改密钥」，通过自定义掩码输入保存。",
				"写入使用静态 macos-keychain.swift 适配器与系统 Security Framework，需可用的 Swift 命令行工具。",
				"密钥仅通过 stdin 传递，写入后从系统密钥库重读验证；不进入命令参数、会话或配置文件。",
			],
		};
	}
	if (kind === "secret-tool") {
		return {
			backend,
			kind,
			lines: [
				`Linux Secret Service（service: ${SECRET_TOOL_SERVICE}, provider: ${backend}）`,
				"推荐在终端交互模式运行 /web-search-auth，通过自定义掩码输入保存并重读验证。",
				"也可在终端执行下面的命令，回车后按提示粘贴密钥：",
				`  secret-tool store --label="Pi web search: ${backend}" service ${SECRET_TOOL_SERVICE} provider ${backend}`,
				"注意：不要把 key 写在命令参数里，只通过交互提示输入。",
			],
		};
	}
	return {
		backend,
		kind,
		lines: [
			hasFreeChannel(backend)
				? "当前平台没有系统密钥库，此后端未提供密钥时仍可使用免 key 通道。"
				: "当前平台没有系统密钥库，此后端必须配置密钥，没有免 key 通道。", 
			`如需使用自有 key，请通过外部 secret manager 在启动 Pi 时安全注入 ${variable}；不要把 key 放进 shell 命令或启动文件。`,
			"可使用外部密钥管理工具安全注入环境；Exa / Parallel / Tavily / Firecrawl 另有匿名通道。",
			"配置密钥不代表允许计费；只有显式设置 PI_WEB_SEARCH_ALLOW_BILLABLE=true 才启用认证搜索。",
		],
	};
}
