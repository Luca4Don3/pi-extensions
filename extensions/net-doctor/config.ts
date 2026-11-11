/**
 * 策略配置：让注册表里的默认值可以被覆盖。
 *
 * 为什么必须有这一层：本机实测显示没有一条路恒优——
 * 代理曾经 0/5 全部 ECONNRESET，后来又测到 722ms 且落 SJC；
 * 直连 IPv4 稳定但 p50 更高。硬编码任何一种都是在赌时段。
 * 所以默认值只作为"未经测量时的保守选择"，实际以测量结果为准。
 *
 * 配置落在 `~/.pi/agent/net-doctor.json`，不写进 Pi 的 settings.json：
 * 这是扩展私有状态，混进宿主配置会让两边都难演进。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HostRoute, RouteMode } from "./hosts.ts";

/** 配置文件名。 */
export const CONFIG_FILE = "net-doctor.json";

/** 配置文件结构。 */
export interface NetDoctorConfig {
	/** hostname → 覆盖后的路由模式。 */
	routes?: Record<string, RouteMode>;
}

/** 允许写入的模式，用于校验外部输入。 */
const VALID_MODES: readonly RouteMode[] = [
	"direct-v4",
	"direct",
	"proxy",
	"passthrough",
];

/** 判断字符串是否是合法模式。 */
export function isValidMode(value: string): value is RouteMode {
	return (VALID_MODES as readonly string[]).includes(value);
}

/** 配置文件绝对路径。 */
export function configPath(agentDir: string): string {
	return join(agentDir, CONFIG_FILE);
}

/**
 * 读配置。
 *
 * 文件不存在、损坏、字段类型不对，都按"没有覆盖"处理而不是抛错：
 * 配置坏了不应该拦住 Pi 启动，更不应该让策略静默变成未知状态。
 * 无法识别的条目会被丢弃，只保留能校验通过的部分。
 */
export function readConfig(agentDir: string): NetDoctorConfig {
	const file = configPath(agentDir);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object") return {};
		const routes = (parsed as { routes?: unknown }).routes;
		if (routes === null || typeof routes !== "object") return {};
		const clean: Record<string, RouteMode> = {};
		for (const [host, mode] of Object.entries(routes)) {
			if (typeof mode === "string" && isValidMode(mode)) clean[host] = mode;
		}
		return Object.keys(clean).length > 0 ? { routes: clean } : {};
	} catch {
		return {};
	}
}

/** 写配置；返回是否成功，失败由调用方报告给用户。 */
export function writeConfig(agentDir: string, config: NetDoctorConfig): boolean {
	try {
		const file = configPath(agentDir);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
}

/**
 * 把配置覆盖应用到注册表，返回新数组，不改入参。
 *
 * 只覆盖注册表里已存在的 host：配置里出现未知 host 时忽略它，
 * 避免因为拼写错误就悄悄给一个没测量过的域名套上策略。
 */
export function applyOverrides(
	routes: readonly HostRoute[],
	overrides: Record<string, RouteMode> | undefined,
): readonly HostRoute[] {
	if (!overrides || Object.keys(overrides).length === 0) return routes;
	return routes.map((route) => {
		const mode = overrides[route.host];
		return mode === undefined ? route : { ...route, mode };
	});
}

/** 写单条覆盖并返回新配置（读-改-写，不做增量假设）。 */
export function withOverride(
	agentDir: string,
	host: string,
	mode: RouteMode,
): NetDoctorConfig {
	const current = readConfig(agentDir);
	const routes = { ...(current.routes ?? {}), [host]: mode };
	return { routes };
}
