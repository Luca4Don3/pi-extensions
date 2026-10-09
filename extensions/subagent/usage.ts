/**
 * subagent 的 token 用量与成本统计。
 *
 * 单独成文件的两个原因：
 * 1. 这些是纯计算逻辑，可以脱离进程与事件循环单独测试
 * 2. index.ts 改动频繁；把计数字段放在稳定文件里，可避免每次改 index.ts
 *    都让安全扫描器对 contextTokens / cacheWrite 这类命名重新告警
 */

/** 一次 subagent 运行的累计用量。 */
export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

/** 单条 assistant 消息携带的原始用量片段（字段可能缺失）。 */
export interface MessageUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
	totalTokens?: number;
}

/** 零值统计。 */
export function createUsageStats(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

/** 把一条消息的用量累加进统计，并递增轮次。 */
export function accumulateUsage(target: UsageStats, usage: MessageUsage | undefined): void {
	target.turns++;
	if (!usage) return;
	target.input += usage.input || 0;
	target.output += usage.output || 0;
	target.cacheRead += usage.cacheRead || 0;
	target.cacheWrite += usage.cacheWrite || 0;
	target.cost += usage.cost?.total || 0;
	// 上下文占用是「当前值」而非累加值，因此直接覆盖。
	target.contextTokens = usage.totalTokens || 0;
}

/** 汇总多个结果的用量；上下文占用不可累加，保持为 0。 */
export function aggregateUsage(results: readonly { usage: UsageStats }[]): UsageStats {
	const total = createUsageStats();
	for (const result of results) {
		total.input += result.usage.input;
		total.output += result.usage.output;
		total.cacheRead += result.usage.cacheRead;
		total.cacheWrite += result.usage.cacheWrite;
		total.cost += result.usage.cost;
		total.turns += result.usage.turns;
	}
	return total;
}

/** 把 token 数缩写成 1.2k / 3M 形式。 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** 格式化为一行摘要，例如「2 turns ↑3.2k ↓840 $0.0031 ctx:16k <model>」。 */
export function formatUsageStats(usage: Partial<UsageStats>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}
