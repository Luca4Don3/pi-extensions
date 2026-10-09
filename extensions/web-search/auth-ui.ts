/**
 * `/web-search-auth` 命令的交互菜单
 *
 * 只使用 Pi 自带的 select / confirm / notify：
 * - 状态：分别报告四个后端的配置与凭据来源，区分「未配置」与「密钥库不可用」。
 * - 配置说明：输出安全的终端命令（key 只从交互提示读取，绝不放命令参数）。
 * - 删除：二次确认后只删除系统密钥库中的条目，并给出成功 / 未找到 / 失败诊断。
 *
 * 该菜单不接收任何 key 输入：key 的写入由用户在终端用平台自带命令完成，
 * 因此这里没有普通输入框，也没有自定义掩码组件。
 *
 * @module pi-web-search-auth-ui
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BACKENDS,
	configGuide,
	envVarName,
	hasFreeChannel,
	isBackend,
	type Backend,
	type BackendStatus,
	probeBackendStatus,
	safeDiagnostic,
} from "./auth.js";
import type { SecretStore } from "./credentials.js";

/** 认证命令名。 */
export const AUTH_COMMAND = "web-search-auth";

/** 菜单选项文案。 */
const OPTION_STATUS = "查看状态";
const OPTION_GUIDE = "查看配置说明";
const OPTION_DELETE = "删除系统密钥库中的密钥";

/** 注册 `/web-search-auth` 命令。 */
export function registerAuthCommand(pi: ExtensionAPI, store: SecretStore): void {
	pi.registerCommand(AUTH_COMMAND, {
		description: "查看 / 配置 Exa、Parallel、Tavily、SerpApi 的密钥（环境变量或系统密钥库）",
		handler: async (_args, ctx) => {
			await runAuthMenu(ctx, store);
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
			? `${name}：未配置（免 key 通道仍可用）`
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
	lines.push("Exa / Parallel 的免 key 通道仍可用；Tavily / SerpApi 必须通过环境变量或系统密钥库配置密钥。");
	const hasUnavailable = statuses.some((status) => status.state === "unavailable");
	notify(ctx, lines.join("\n"), hasUnavailable ? "warning" : "info");
}

/** 展示安全配置说明（合并为单条通知）。 */
async function showGuides(ctx: ExtensionCommandContext, store: SecretStore): Promise<void> {
	const sections = BACKENDS.map((backend) => configGuide(backend, store.kind).lines.join("\n"));
	sections.push(`环境变量同样有效且优先：${BACKENDS.map(envVarName).join(" / ")}。`);
	sections.push("Tavily / SerpApi 必须配置密钥，没有免 key 通道。");
	notify(ctx, sections.join("\n\n"));
}

/** 删除某个后端在系统密钥库中的条目。 */
async function deleteStoredKey(ctx: ExtensionCommandContext, store: SecretStore): Promise<void> {
	if (store.kind === "none") {
		notify(ctx, "当前平台没有系统密钥库，无需删除；如通过环境变量注入，请在对应的外部 secret manager 中撤销。", "warning");
		return;
	}
	const selected = await ctx.ui.select("选择要删除的后端", [...BACKENDS]);
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

/** `/web-search-auth` 主流程：状态 / 配置说明 / 删除。 */
async function runAuthMenu(ctx: ExtensionCommandContext, store: SecretStore): Promise<void> {
	if (!ctx.hasUI) {
		// JSON / print 模式没有 UI，notify / select 都不可见：这里保持安全 no-op，
		// 不假装通知成功；凭据状态可通过 web_search 的 details 观察。
		return;
	}
	// 菜单标题需要状态摘要，这里只 probe 一次，并传给「查看状态」复用。
	const statuses = await Promise.all(BACKENDS.map((backend) => probeBackendStatus(backend, store)));
	const choice = await ctx.ui.select(`Web Search 认证（${summarize(statuses)}）`, [
		OPTION_STATUS,
		OPTION_GUIDE,
		OPTION_DELETE,
	]);
	// 运行时验证选择值：非白名单（取消、自定义输入等）一律视为取消。
	if (choice !== OPTION_STATUS && choice !== OPTION_GUIDE && choice !== OPTION_DELETE) {
		notify(ctx, "已取消。");
		return;
	}
	if (choice === OPTION_STATUS) return reportStatus(ctx, store, statuses);
	if (choice === OPTION_GUIDE) return showGuides(ctx, store);
	return deleteStoredKey(ctx, store);
}
