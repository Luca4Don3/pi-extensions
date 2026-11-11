/**
 * net-doctor — 按 host 施加链路策略，并提供只读诊断。
 *
 * 两件事，边界清楚：
 *   1. 策略（写）：只改注册表里 `mode !== "passthrough"` 的 host 的连接出口。
 *      不碰 DNS、不碰 hosts 文件、不需要提权、不重试。
 *   2. 诊断（只读）：测三条路径的总时长，输出对照表，不改任何状态。
 *
 * 为什么不是"优选 IP + 改 hosts"：本机实测把 hosts 指向 Cloudflare 的
 * 优选地址反而 5/5 全部 CONNECT_TIMEOUT，而强制 IPv4 直连是 5/5 成功。
 * 根因是 IPv6 路径质量与 `autoSelectFamily` 的 2s 回退，不是边缘机房选错。
 *
 * 策略为什么可配：代理与直连的优劣会随线路时段翻转（实测代理曾 0/5 失败，
 * 也曾比直连快一倍），所以默认值只是"未经测量时的保守选择"。
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	applyOverrides,
	configPath,
	isValidMode,
	readConfig,
	withOverride,
	writeConfig,
} from "./config.ts";
import {
	createDirectAgent,
	createDirectV4Agent,
	createProxyAgent,
	loadUndici,
	resolveProxyUrl,
	type DispatcherLike,
	type UndiciLike,
} from "./dispatchers.ts";
import { isActiveRoute, matchRoute, ROUTES, type HostRoute } from "./hosts.ts";
import { probeAll, probeOnce, type ProbeMode } from "./probe.ts";
import { formatReport, summarize, type HostReport } from "./report.ts";
import { installRouter, type RouteDispatchers } from "./router.ts";

/** 诊断覆盖的三条路径，顺序与报告列一致。 */
const PROBE_MODES: readonly ProbeMode[] = ["direct", "direct-v4", "proxy"];

/** 并发上限。TLS 同时开太多会互相抢带宽，测出来的数字就不代表单条线路。 */
const PROBE_CONCURRENCY = 6;

/** 诊断用的一次性 dispatcher：用完即关，保证测的是冷连接。 */
function createProbeDispatcher(
	undici: UndiciLike,
	mode: ProbeMode,
	proxyUrl: string,
): DispatcherLike {
	if (mode === "direct-v4") return createDirectV4Agent(undici);
	if (mode === "direct") return createDirectAgent(undici);
	return createProxyAgent(undici, proxyUrl);
}

/** 探针 URL：CF 用 trace 才能拿到 colo，其余退回根路径。 */
function probeUrl(route: HostRoute): string {
	return `https://${route.host}${route.probePath ?? "/"}`;
}

/** 命令帮助。 */
const USAGE = [
	"用法：",
	"  /net-doctor                 测量全部端点（直连默认 / 直连 IPv4 / 代理）",
	"  /net-doctor <过滤串>        只测匹配的 host 或 provider",
	"  /net-doctor set <host> <mode>  覆盖策略并立即生效",
	"  /net-doctor reset           清除全部覆盖，回到注册表默认值",
	"",
	"mode 取值：direct-v4 | direct | proxy | passthrough",
].join("\n");

export default async function netDoctor(pi: ExtensionAPI): Promise<void> {
	const proxyUrl = resolveProxyUrl();
	const agentDir = getAgentDir();

	/** 当前生效的路由表（注册表 + 用户覆盖）。 */
	let routes: readonly HostRoute[] = applyOverrides(
		ROUTES,
		readConfig(agentDir).routes,
	);

	/** 当前配置的指纹，用于判断是否需要重新应用覆盖。 */
	let routesKey = JSON.stringify(readConfig(agentDir).routes ?? {});

	let undici: UndiciLike | undefined;
	let dispatchers: RouteDispatchers | undefined;
	let installError: string | undefined;

	try {
		undici = loadUndici();
		// 长生命周期的 dispatcher：这里是真实生产路径，连接复用是期望行为。
		// 只构造一次；后续策略变更只更新路由表，不重建 Agent（否则连接池会泄漏）。
		dispatchers = {
			"direct-v4": createDirectV4Agent(undici),
			direct: createDirectAgent(undici),
			proxy: createProxyAgent(undici, proxyUrl),
		};
		installRouter(undici, dispatchers, routes);
	} catch (error) {
		// 不静默：策略没装上必须留下明确痕迹，否则用户会以为优化已生效。
		installError = error instanceof Error ? error.message : String(error);
		console.error(`[net-doctor] 链路策略未安装：${installError}`);
	}

	pi.registerCommand("net-doctor", {
		description:
			"测量各 provider 端点（直连默认 / 直连 IPv4 / 代理），并可覆盖链路策略",
		handler: async (args, ctx) => {
			if (installError !== undefined) {
				ctx.ui.notify(
					`net-doctor 策略未生效：${installError}\n诊断仍可使用，但注册表里的策略不会改变实际请求。`,
					"warning",
				);
			}

			if (undici === undefined) {
				ctx.ui.notify("net-doctor：undici 不可用，无法测量。", "error");
				return;
			}

			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0]?.toLowerCase() ?? "";

			// 外部编辑配置文件后无需重启：每次命令都重新读，按内容判断是否变化。
			const config = readConfig(agentDir);
			const key = JSON.stringify(config.routes ?? {});
			if (key !== routesKey) {
				routesKey = key;
				routes = applyOverrides(ROUTES, config.routes);
				if (dispatchers !== undefined) installRouter(undici, dispatchers, routes);
			}

			if (sub === "help" || sub === "-h" || sub === "--help") {
				ctx.ui.notify(USAGE, "info");
				return;
			}

			if (sub === "set") {
				const host = tokens[1]?.toLowerCase();
				const mode = tokens[2]?.toLowerCase();
				if (host === undefined || mode === undefined) {
					ctx.ui.notify(`缺少参数。\n\n${USAGE}`, "warning");
					return;
				}
				if (matchRoute(host, ROUTES) === undefined) {
					ctx.ui.notify(
						`未知 host：${host}\n可选：${ROUTES.map((route) => route.host).join(", ")}`,
						"warning",
					);
					return;
				}
				if (!isValidMode(mode)) {
					ctx.ui.notify(`非法 mode：${mode}\n\n${USAGE}`, "warning");
					return;
				}
				const nextConfig = withOverride(agentDir, host, mode);
				if (!writeConfig(agentDir, nextConfig)) {
					ctx.ui.notify(`写入配置失败：${configPath(agentDir)}`, "error");
					return;
				}
				routes = applyOverrides(ROUTES, nextConfig.routes);
				routesKey = JSON.stringify(nextConfig.routes ?? {});
				if (dispatchers !== undefined) installRouter(undici, dispatchers, routes);
				ctx.ui.notify(
					`已设置 ${host} → ${mode}（立即生效，已写入 ${configPath(agentDir)}）`,
					"info",
				);
				return;
			}

			if (sub === "reset") {
				if (!writeConfig(agentDir, {})) {
					ctx.ui.notify(`写入配置失败：${configPath(agentDir)}`, "error");
					return;
				}
				routes = ROUTES;
				routesKey = "{}";
				if (dispatchers !== undefined) installRouter(undici, dispatchers, routes);
				ctx.ui.notify("已清除全部覆盖，回到注册表默认策略。", "info");
				return;
			}

			const filter = sub;
			const targets =
				filter === ""
					? routes
					: routes.filter(
							(route) =>
								route.host.includes(filter) || route.provider === filter,
						);
			if (targets.length === 0) {
				ctx.ui.notify(
					`没有匹配 "${filter}" 的端点。\n可选：${routes.map((route) => route.host).join(", ")}`,
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				`net-doctor：正在测量 ${targets.length} 个端点 × ${PROBE_MODES.length} 条路径…`,
				"info",
			);

			const reports = await probeAll<HostRoute, HostReport>(
				targets,
				PROBE_CONCURRENCY,
				async (route) => {
					const outcomes: HostReport["outcomes"] = {};
					for (const mode of PROBE_MODES) {
						const dispatcher = createProbeDispatcher(undici, mode, proxyUrl);
						try {
							outcomes[mode] = await probeOnce(
								undici,
								probeUrl(route),
								dispatcher,
								mode,
							);
						} finally {
							await dispatcher.close().catch(() => {
								// 关闭失败不影响已经拿到的测量结果。
							});
						}
					}
					return { route, outcomes };
				},
			);

			const table = formatReport(reports, PROBE_MODES);
			const notes = summarize(reports);
			const activeCount = routes.filter(isActiveRoute).length;
			const footer = [
				"",
				`代理：${proxyUrl}`,
				`生效策略：${activeCount} 条 / 共 ${routes.length} 条`,
				`配置文件：${configPath(agentDir)}`,
				...notes,
			].join("\n");

			ctx.ui.notify(`${table}\n${footer}`, "info");
		},
	});
}
