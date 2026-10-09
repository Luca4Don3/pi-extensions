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

/** 后端标识（与存储层共用）。 */
export type Backend = SecretBackend;

/** 凭据来源。 */
export type AuthSource = "env" | "keychain" | "secret-tool";

/** 单个后端的认证状态。 */
export interface BackendStatus {
	backend: Backend;
	/** configured：已配置；not_configured：密钥库可用但无条目；unavailable：密钥库不可用。 */
	state: "configured" | "not_configured" | "unavailable";
	/** 仅在 configured 时给出凭据来源。 */
	source?: AuthSource;
	/** 仅在 unavailable 时给出不含敏感信息的诊断原因。 */
	reason?: string;
}

/** 两个后端，固定顺序。 */
export const BACKENDS: readonly Backend[] = ["exa", "parallel"];

/** 后端对应的环境变量名。 */
export function envVarName(backend: Backend): string {
	return backend === "exa" ? "EXA_API_KEY" : "PARALLEL_API_KEY";
}

/** 读取环境变量中的 key；空白视为未配置。 */
export function envKey(backend: Backend): string | undefined {
	const value = process.env[envVarName(backend)];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * 解析单个后端的 key：环境变量优先，其次系统密钥库。
 * 任何读取失败都静默回退为 undefined，保证匿名搜索不被密钥库问题阻断。
 */
export async function resolveBackendKey(backend: Backend, store: SecretStore): Promise<string | undefined> {
	const fromEnv = envKey(backend);
	if (fromEnv !== undefined) return fromEnv;
	try {
		const result = await store.read(backend);
		return result.status === "found" ? result.value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 为一次搜索解析路由所需的全部 key：每个可能用到的后端只读一次密钥库。
 * provider=exa 只解 exa，provider=parallel 只解 parallel，auto 两个都解。
 */
export async function resolvePlanKeys(
	provider: "auto" | Backend,
	store: SecretStore,
): Promise<Record<Backend, string | undefined>> {
	const needed = provider === "auto" ? BACKENDS : ([provider] as readonly Backend[]);
	const entries = await Promise.all(
		needed.map(async (backend): Promise<[Backend, string | undefined]> => [
			backend,
			await resolveBackendKey(backend, store),
		]),
	);
	const keys = { exa: undefined, parallel: undefined } as Record<Backend, string | undefined>;
	for (const [backend, key] of entries) keys[backend] = key;
	return keys;
}

/** 查询单个后端的认证状态；不抛错，密钥库失败归入 unavailable。 */
export async function probeBackendStatus(backend: Backend, store: SecretStore): Promise<BackendStatus> {
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
				"在终端执行下面的命令，回车后按系统提示粘贴 key：",
				`  security add-generic-password -U -a "$USER" -s "${service}" -w`,
				"注意：-w 后不要跟任何参数，否则 key 会进入 shell 历史与进程列表。",
			],
		};
	}
	if (kind === "secret-tool") {
		return {
			backend,
			kind,
			lines: [
				`Linux Secret Service（service: ${SECRET_TOOL_SERVICE}, provider: ${backend}）`,
				"在终端执行下面的命令，回车后按提示粘贴 key：",
				`  secret-tool store --label="Pi web search: ${backend}" service ${SECRET_TOOL_SERVICE} provider ${backend}`,
				"注意：不要把 key 写在命令参数里，只通过交互提示输入。",
			],
		};
	}
	return {
		backend,
		kind,
		lines: [
			"当前平台没有系统密钥库，web_search 未提供 key 时会自动走免 key 通道。",
			`如需使用自有 key，请通过外部 secret manager 在启动 Pi 时安全注入 ${variable}；不要把 key 放进 shell 命令或启动文件。`,
			"例如可使用 1Password CLI、Vault 等外部密钥管理工具；也可继续使用免 key 通道。",
		],
	};
}
