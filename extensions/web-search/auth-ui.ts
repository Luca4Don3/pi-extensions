/**
 * `/web-search-auth` 命令的交互菜单
 *
 * - 状态：区分凭据来源、路由策略、付费开关与独立通道冷却。
 * - 添加 / 修改：仅在终端模式中使用自绘掩码组件，二次确认后写入系统密钥库。
 * - 删除：二次确认后只删除系统密钥库条目，环境变量不受影响。
 * - 不支持安全输入或系统密钥库时明确失败，不退化为明文输入或明文文件。
 *
 * @module pi-web-search-auth-ui
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BACKENDS,
	KEY_BACKENDS,
	configGuide,
	envVarName,
	hasFreeChannel,
	isBackend,
	type Backend,
	type BackendStatus,
	probeBackendStatus,
	safeDiagnostic,
} from "./auth.js";
import { isValidSecretValue, type SecretStore } from "./credentials.js";
import { MaskedInput } from "./masked-input.js";
import { getRoutingStatus, type RoutingStatus } from "./routing.js";

/** 认证命令名。 */
export const AUTH_COMMAND = "web-search-auth";

/** 菜单选项文案。 */
const OPTION_STATUS = "查看状态";
const OPTION_GUIDE = "查看配置说明";
const OPTION_WRITE = "添加或修改密钥";
const OPTION_ROUTING = "查看路由与冷却状态";
const OPTION_DELETE = "删除系统密钥库中的密钥";

/** 搜索与认证菜单共用同一实例的状态，仅返回无凭据的数据。 */
export type RoutingStatusReader = () => RoutingStatus;

/** 注册 `/web-search-auth` 命令。 */
export function registerAuthCommand(
	pi: ExtensionAPI,
	store: SecretStore,
	readStatus: RoutingStatusReader = () => getRoutingStatus(),
): void {
	pi.registerCommand(AUTH_COMMAND, {
		description: "安全管理搜索密钥，查看路由与通道冷却状态",
		handler: async (_args, ctx) => {
			await runAuthMenu(ctx, store, readStatus);
		},
	});
}

/** 打一条带类型的通知。 */
function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(message, type);
}

/** 单条状态文案；不包含 key 内容。 */
function statusLine(status: BackendStatus, store: SecretStore): string {
	const name = status.backend;
	if (status.state === "configured") {
		if (status.source === "env") return `${name}：已配置（环境变量 ${envVarName(status.backend)}，优先于系统密钥库）`;
		const label = store.kind === "secret-tool" ? "Linux Secret Service" : "macOS Keychain";
		return `${name}：已配置（${label}）`;
	}
	if (status.state === "not_configured") {
		return hasFreeChannel(status.backend)
			? `${name}：未配置（具备免 key 通道，冷却状态单独查看）`
			: `${name}：未配置（需要密钥，没有免 key 通道）`;
	}
	return `${name}：系统密钥库不可用（${status.reason ?? "未知原因"}）`;
}

/** 紧凑摘要，放进 select 标题。 */
function summarize(statuses: BackendStatus[]): string {
	return statuses
		.map((status) => {
			if (status.state === "configured") return `${status.backend}=已配置`;
			if (status.state === "not_configured") return `${status.backend}=未配置`;
			return `${status.backend}=不可用`;
		})
		.join(" · ");
}

/** 报告所有后端的当前状态（合并通知，避免连续通知互相覆盖）。 */
async function reportStatus(
	ctx: ExtensionCommandContext,
	store: SecretStore,
	probed?: BackendStatus[],
): Promise<void> {
	const statuses = probed ?? (await Promise.all(BACKENDS.map((backend) => probeBackendStatus(backend, store))));
	const lines = statuses.map((status) => statusLine(status, store));
	lines.push("Exa / Tavily / Parallel / Firecrawl 具备匿名通道，TinyFish 仅有零凭据 keyless 匿名通道；SerpApi 需要密钥和显式计费授权。");
	const hasUnavailable = statuses.some((status) => status.state === "unavailable");
	notify(ctx, lines.join("\n"), hasUnavailable ? "warning" : "info");
}

/** 展示安全配置说明（合并为单条通知）。 */
async function showGuides(ctx: ExtensionCommandContext, store: SecretStore): Promise<void> {
	const sections = KEY_BACKENDS.map((backend) => configGuide(backend, store.kind).lines.join("\n"));
	sections.push(`环境变量同样有效且优先：${KEY_BACKENDS.map(envVarName).join(" / ")}。`);
	sections.push("四家服务支持匿名搜索；TinyFish 仅有零凭据 keyless 匿名通道，无需也不读取密钥；SerpApi 需要密钥。配置密钥不代表允许计费，默认禁止认证搜索。");
	sections.push("只有显式设置 PI_WEB_SEARCH_ALLOW_BILLABLE=true 才授权可能收费的通道；旧开关 PI_WEB_SEARCH_ALLOW_PAID 为兼容别名，两者冲突会报错。");
	notify(ctx, sections.join("\n\n"));
}

/** 删除某个后端在系统密钥库中的条目。 */
async function deleteStoredKey(ctx: ExtensionCommandContext, store: SecretStore): Promise<void> {
	if (store.kind === "none") {
		notify(ctx, "当前平台没有系统密钥库，无需删除；如通过环境变量注入，请在对应的外部 secret manager 中撤销。", "warning");
		return;
	}
	const selected = await ctx.ui.select("选择要删除的后端", [...KEY_BACKENDS]);
	// 运行时验证选择值：非白名单（取消、自定义输入等）一律视为取消，绝不误删。
	if (!isBackend(selected)) {
		notify(ctx, "已取消，未删除任何凭据。");
		return;
	}
	const backend: Backend = selected;
	const env = envVarName(backend);
	const confirmed = await ctx.ui.confirm(
		`删除 ${backend} 的密钥？`,
		`将从系统密钥库中永久删除 ${backend} 的条目；环境变量 ${env}（如有）不受影响。`,
	);
	if (!confirmed) {
		notify(ctx, "已取消，未删除任何凭据。");
		return;
	}
	try {
		const result = await store.clear(backend);
		if (result.status === "deleted") notify(ctx, `已删除系统密钥库中的 ${backend} 密钥。`);
		else if (result.status === "missing") notify(ctx, `系统密钥库中没有保存 ${backend} 密钥，无需删除。`, "warning");
		else notify(ctx, `删除 ${backend} 失败：${result.reason}。可手动执行删除命令，见「查看配置说明」。`, "error");
	} catch (error) {
		notify(ctx, `删除 ${backend} 失败：${safeDiagnostic(error)}。`, "error");
	}
}

/** 路由状态与认证状态分开读取；不暴露密钥，也不修改冷却。 */
function reportRouting(ctx: ExtensionCommandContext, readStatus: RoutingStatusReader): void {
	try {
		const status = readStatus();
		const lines = [
			`路由：${status.strategy === "free-first" ? "匿名优先" : "密钥优先（仅未授权兼容模式）"}；密钥通道：${status.allowBillable ? "已明确授权（可能产生费用）" : "已禁用"}。`,
			`冷却兼容配置值：${status.freeCooldownMs / 1000} 秒；未显式覆盖时按限流与额度耗尽分别退避。`,
		];
		if (status.quota === undefined || status.quota.persistence === "not_initialized") {
			lines.push("额度状态尚未载入；查看此菜单不会触发磁盘读取或真实额度查询。");
		} else if (status.quota.persistence === "persistent") {
			lines.push("额度状态：本地私有存储可用，仅展示本实例已载入的冷却快照。");
		} else if (status.quota.persistence === "memory_only") {
			lines.push("额度状态：仅保存在本进程内存，重启后不保留。");
		} else {
			lines.push(`额度状态：持久化退化为内存；原因：${status.quota.persistenceReason ?? "QUOTA_STATE_IO_UNAVAILABLE"}。`);
		}
		const quotaCooldowns = status.quota?.cooldowns ?? [];
		if (status.channels.length === 0 && quotaCooldowns.length === 0) lines.push("当前没有正在冷却的通道。");
		for (const channel of [...status.channels, ...quotaCooldowns]) {
			const reason = channel.reason === "rate_limited" ? "限流" : channel.reason === "quota_exhausted" ? "额度耗尽" : "冷却";
			const nextProbe = channel.nextProbeAt === undefined ? "" : `；建议下次探测时间 ${new Date(channel.nextProbeAt).toLocaleString()}（不代表额度恢复）`;
			lines.push(`${channel.backend}（${channel.channel === "free" ? "匿名" : "密钥"}通道，${reason}）：冷却剩余约 ${Math.ceil(channel.remainingMs / 1000)} 秒${nextProbe}。`);
		}
		notify(ctx, lines.join("\n"));
	} catch {
		notify(ctx, "路由配置无效，请检查 PI_WEB_SEARCH_ROUTING、PI_WEB_SEARCH_ALLOW_BILLABLE、兼容开关 PI_WEB_SEARCH_ALLOW_PAID 与 PI_WEB_SEARCH_FREE_COOLDOWN_MS。", "error");
	}
}

/** 密钥只流经掩码组件与系统密钥库；取消、无安全输入或无密钥库均不写入。 */
async function writeStoredKey(ctx: ExtensionCommandContext, store: SecretStore): Promise<void> {
	if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
		notify(ctx, "当前模式不支持安全掩码输入；请在终端交互模式中运行 /web-search-auth，不会使用明文输入。", "warning");
		return;
	}
	if (store.kind === "none") {
		notify(ctx, "当前平台没有支持的系统密钥库，不能保存密钥；不会退化为明文文件。", "warning");
		return;
	}
	const selected = await ctx.ui.select("选择要添加或修改密钥的后端", [...KEY_BACKENDS]);
	if (!isBackend(selected)) {
		notify(ctx, "已取消，未写入任何凭据。");
		return;
	}
	const confirmed = await ctx.ui.confirm(
		`写入或替换 ${selected} 的系统密钥库条目？`,
		`将保存此后端的密钥，如已存在则替换；环境变量 ${envVarName(selected)} 仍优先且不会被修改。`,
	);
	if (!confirmed) {
		notify(ctx, "已取消，未写入任何凭据。");
		return;
	}
	let value: string | undefined;
	try {
		value = await ctx.ui.custom<string | undefined>((tui, _theme, _keybindings, done) =>
			new MaskedInput(`输入 ${selected} 的密钥（仅显示掩码）`, done, () => tui.requestRender()),
		);
		if (value === undefined) {
			notify(ctx, "已取消，未写入任何凭据。");
			return;
		}
		if (!isValidSecretValue(value)) {
			notify(ctx, "密钥输入无效或超长，未写入任何凭据。", "error");
			return;
		}
		const result = await store.write(selected, value);
		if (result.status === "written") {
			notify(ctx, `已保存 ${selected} 的系统密钥库条目，并通过重读验证；如已配置 ${envVarName(selected)}，仍以环境变量为准。`);
		} else {
			notify(ctx, `保存 ${selected} 失败：${safeDiagnostic(result.reason, [value])}。未验证成功，请查看密钥库状态。`, "error");
		}
	} catch {
		// 输入组件、第三方注入的存储实现都可能在错误中回显密钥，故不传播原始错误。
		notify(ctx, `保存 ${selected} 失败：安全输入或系统密钥库不可用。未验证成功。`, "error");
	} finally {
		value = undefined;
	}
}

/** `/web-search-auth` 主流程。 */
async function runAuthMenu(ctx: ExtensionCommandContext, store: SecretStore, readStatus: RoutingStatusReader): Promise<void> {
	if (!ctx.hasUI) {
		// JSON / print 模式没有 UI，notify / select 都不可见：这里保持安全 no-op，
		// 不假装通知成功；凭据状态可通过 web_search 的 details 观察。
		return;
	}
	// 菜单标题需要状态摘要，这里只 probe 一次，并传给「查看状态」复用。
	const statuses = await Promise.all(BACKENDS.map((backend) => probeBackendStatus(backend, store)));
	const choice = await ctx.ui.select(`Web Search 认证（${summarize(statuses)}）`, [
		OPTION_STATUS,
		OPTION_WRITE,
		OPTION_ROUTING,
		OPTION_GUIDE,
		OPTION_DELETE,
	]);
	// 运行时验证选择值：非白名单（取消、自定义输入等）一律视为取消。
	if (![OPTION_STATUS, OPTION_WRITE, OPTION_ROUTING, OPTION_GUIDE, OPTION_DELETE].includes(choice ?? "")) {
		notify(ctx, "已取消。");
		return;
	}
	if (choice === OPTION_STATUS) return reportStatus(ctx, store, statuses);
	if (choice === OPTION_WRITE) return writeStoredKey(ctx, store);
	if (choice === OPTION_ROUTING) return reportRouting(ctx, readStatus);
	if (choice === OPTION_GUIDE) return showGuides(ctx, store);
	return deleteStoredKey(ctx, store);
}
