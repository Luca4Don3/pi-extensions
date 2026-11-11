/**
 * undici 的最小面与加载。
 *
 * 为什么要自己解析 undici：Pi 把 undici 打在自己的安装目录里，
 * 扩展进程的模块解析起点不是 Pi 的安装位置。`bin/pi` 通常是 nvm 的软链，
 * 所以必须先 realpath 再 require，否则拿到的是另一个（或找不到）。
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

/** dispatcher 只需要能关闭。 */
export interface DispatcherLike {
	close(): Promise<void>;
}

/** undici 的 request 返回值里我们只用到状态码与正文。 */
export interface UndiciResponseLike {
	statusCode: number;
	body: { text(): Promise<string> };
}

/** undici 的最小可用面。 */
export interface UndiciLike {
	Agent: new (options?: Record<string, unknown>) => DispatcherLike;
	ProxyAgent: new (uri: string) => DispatcherLike;
	request(
		url: string,
		options: Record<string, unknown>,
	): Promise<UndiciResponseLike>;
}

/** 默认代理端口，与 opencode-fallback 保持一致，便于用户只配置一处。 */
export const DEFAULT_PROXY_URL = "http://127.0.0.1:7897";

/**
 * 解析应使用的代理地址。
 *
 * 优先级：`PI_NET_DOCTOR_PROXY` > `HTTPS_PROXY` > 默认值。
 * 显式环境变量优先，是因为诊断时经常需要临时指向另一个节点做对照。
 */
export function resolveProxyUrl(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_NET_DOCTOR_PROXY?.trim();
	if (explicit) return explicit;
	const inherited = env.HTTPS_PROXY?.trim() || env.https_proxy?.trim();
	if (inherited) return inherited;
	return DEFAULT_PROXY_URL;
}

/** 连接参数：所有 agent 共用，避免各处超时口径不一致。 */
const CONNECT_TIMEOUT_MS = 8_000;

/**
 * 直连并强制 IPv4。
 *
 * `family: 4` 是关键：本机实测 IPv6 路径有约 40% 的 SYN 超时，
 * 而 `autoSelectFamily` 默认要先等 2s 才回退，于是每次新连接都可能白等 2s。
 * 强制 IPv4 后 p50 从 2815ms 降到 718ms，且落点稳定。
 * `autoSelectFamily: false` 与 `family: 4` 同时给，是为了不留下任何"再试一次 v6"的余地。
 */
export function createDirectV4Agent(undici: UndiciLike): DispatcherLike {
	return new undici.Agent({
		connect: {
			family: 4,
			autoSelectFamily: false,
			timeout: CONNECT_TIMEOUT_MS,
		},
	});
}

/** 直连，地址族交给系统（用于对照：这就是 Pi 的默认行为）。 */
export function createDirectAgent(undici: UndiciLike): DispatcherLike {
	return new undici.Agent({
		connect: {
			timeout: CONNECT_TIMEOUT_MS,
			autoSelectFamilyAttemptTimeout: 2_000,
		},
	});
}

/** 走代理。 */
export function createProxyAgent(
	undici: UndiciLike,
	proxyUrl: string,
): DispatcherLike {
	return new undici.ProxyAgent(proxyUrl);
}

/**
 * 定位 Pi 自带的那份 undici。
 *
 * 返回 `UndiciLike` 前不做字段校验：调用方一旦真的用错，会在请求时显式失败，
 * 而不是在启动时因为某个可选字段缺失就静默降级。
 */
export function loadUndici(
	candidates: readonly (string | undefined)[] = [
		process.argv[1],
		process.execPath,
		// 兜底：若本包以后把 undici 声明为直接依赖，可从包根解析。
		new URL("../../package.json", import.meta.url).pathname,
	],
	realpath: (path: string) => string = defaultRealpath,
): UndiciLike {
	const errors: string[] = [];
	for (const entry of candidates) {
		if (!entry) continue;
		let base = entry;
		try {
			base = realpath(entry);
		} catch {
			// 软链解析失败就用原路径试一次，不中断。
		}
		try {
			const require = createRequire(base);
			return require("undici") as UndiciLike;
		} catch (error) {
			errors.push(String((error as Error).message).slice(0, 80));
		}
	}
	throw new Error(
		`net-doctor: 无法定位 Pi 自带的 undici（Pi 是否缺少依赖？）：${errors.join(" | ") || "无候选路径"}`,
	);
}

function defaultRealpath(path: string): string {
	return realpathSync(path);
}
