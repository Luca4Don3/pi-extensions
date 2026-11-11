/**
 * 报告格式化。
 *
 * 输出目标是"一眼看出哪条路是错的"，所以只保留三列数字：
 * Pi 现在的默认行为、本次策略、以及代理。
 * 三者放在一起，用户不需要理解 undici 也能判断该不该开策略。
 */

import type { HostRoute } from "./hosts.ts";
import {
	formatOutcome,
	type ProbeMode,
	type ProbeOutcome,
} from "./probe.ts";

/** 一个端点的全部测量结果。 */
export interface HostReport {
	readonly route: HostRoute;
	readonly outcomes: Partial<Record<ProbeMode, ProbeOutcome>>;
}

/** 表头顺序即列顺序。 */
const MODES: readonly ProbeMode[] = ["direct", "direct-v4", "proxy"];
const LABELS: Record<ProbeMode, string> = {
	direct: "直连默认",
	"direct-v4": "直连v4",
	proxy: "代理",
};

/** 终端显示宽度：CJK 与全角字符占两格，否则表头对不齐。 */
export function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) ||
			(code >= 0x2e80 && code <= 0xa4cf) ||
			(code >= 0xac00 && code <= 0xd7a3) ||
			(code >= 0xf900 && code <= 0xfaff) ||
			(code >= 0xfe30 && code <= 0xfe6f) ||
			(code >= 0xff00 && code <= 0xff60) ||
			(code >= 0xffe0 && code <= 0xffe6);
		width += wide ? 2 : 1;
	}
	return width;
}

/** 按显示宽度右侧补空格。 */
export function padDisplay(text: string, target: number): string {
	const gap = target - displayWidth(text);
	return gap > 0 ? text + " ".repeat(gap) : text;
}

/** 该端点的策略是否已经在改变行为。 */
function policyLabel(route: HostRoute): string {
	return route.mode === "passthrough" ? "—" : route.mode;
}

/**
 * 生成对照表。
 *
 * 只列参与本次测量的路径：代理未配置时 `proxy` 列不会出现，
 * 而不是显示一列假的失败。
 */
export function formatReport(
	reports: readonly HostReport[],
	availableModes: readonly ProbeMode[] = MODES,
): string {
	const modes = MODES.filter((mode) => availableModes.includes(mode));
	const hostWidth = Math.max(
		4,
		...reports.map((report) => displayWidth(report.route.host)),
	);
	const providerWidth = Math.max(
		8,
		...reports.map((report) => displayWidth(report.route.provider)),
	);

	const header = [
		padDisplay("host", hostWidth),
		padDisplay("provider", providerWidth),
		...modes.map((mode) => padDisplay(LABELS[mode], 14)),
		padDisplay("策略", 10),
	].join("  ");

	const lines = reports.map((report) => {
		const cells = modes.map((mode) => {
			const outcome = report.outcomes[mode];
			return padDisplay(outcome ? formatOutcome(outcome) : "-", 14);
		});
		return [
			padDisplay(report.route.host, hostWidth),
			padDisplay(report.route.provider, providerWidth),
			...cells,
			padDisplay(policyLabel(report.route), 10),
		].join("  ");
	});

	return [header, "-".repeat(displayWidth(header)), ...lines].join("\n");
}

/**
 * 从测量结果里提取需要用户注意的结论。
 *
 * 只陈述差异，不替用户做决定：策略是否保留由用户自己判断，
 * 这里只把"策略没有带来收益"或"策略当前失效"明确说出来，
 * 避免出现"以为开了优化其实没有"的静默失败。
 */
export function summarize(reports: readonly HostReport[]): string[] {
	const notes: string[] = [];
	for (const { route, outcomes } of reports) {
		if (route.mode === "passthrough") continue;
		const active = outcomes[route.mode];
		if (!active) continue;
		if (!active.ok) {
			notes.push(
				`⚠ ${route.host}：策略 ${route.mode} 本次测量失败（${active.error ?? "error"}），请求会直接失败，建议关闭该策略。`,
			);
			continue;
		}
		const baseline = outcomes.direct;
		if (baseline?.ok && route.mode !== "direct") {
			const ratio = active.ms / baseline.ms;
			if (ratio < 0.7) {
				notes.push(
					`✓ ${route.host}：${route.mode} 比默认快 ${Math.round((1 - ratio) * 100)}%（${baseline.ms}ms → ${active.ms}ms）。`,
				);
			} else if (ratio > 1.2) {
				notes.push(
					`⚠ ${route.host}：${route.mode} 反而比默认慢 ${Math.round((ratio - 1) * 100)}%，本次建议回退。`,
				);
			}
		}
		if (baseline && !baseline.ok && active.ok) {
			notes.push(`✓ ${route.host}：默认路径本次失败，策略路径可用。`);
		}
	}
	return notes;
}
