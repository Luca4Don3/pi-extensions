/**
 * 链路测量：只读，不改变任何运行状态。
 *
 * 刻意只测**总时长**（含 DNS、TCP、TLS、TTFB），不做分段：
 * 分段要靠 `node:https` 的事件时序，而走代理必须用 undici 的 CONNECT 隧道，
 * 两条路径的观测口径一旦不一致，报告里的数字就没法横向比较。
 * 统一用 undici 测同一口径，换来的是"这三条路谁更快"可以放心比较。
 */

import type { DispatcherLike, UndiciLike } from "./dispatchers.ts";

/** 参与对照的路径。名称会直接出现在报告表头。 */
export type ProbeMode = "direct" | "direct-v4" | "proxy";

/** 一次测量的结果。 */
export interface ProbeOutcome {
	readonly mode: ProbeMode;
	readonly ok: boolean;
	readonly ms: number;
	readonly status?: number;
	/** Cloudflare 边缘机房代码，只有 CF 前置且探针路径正确时才有。 */
	readonly colo?: string;
	/** 失败形态：错误码或 `timeout`。 */
	readonly error?: string;
}

/** 默认单次超时。跨太平洋的最坏情况也在这之内。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 6_000;

/** 从 `/cdn-cgi/trace` 的正文里取 `colo`。 */
export function parseColo(body: string): string | undefined {
	const match = /^colo=(.+)$/m.exec(body);
	const value = match?.[1]?.trim();
	return value ? value : undefined;
}

/**
 * 测一次。
 *
 * 所有失败都折叠成 `{ ok: false, error }` 而不是抛出：
 * 诊断的目的就是把失败变成数据，让调用方一次拿到完整的对照表。
 */
export async function probeOnce(
	undici: UndiciLike,
	url: string,
	dispatcher: DispatcherLike,
	mode: ProbeMode,
	timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
	const started = Date.now();
	try {
		const response = await undici.request(url, {
			method: "GET",
			dispatcher,
			signal: AbortSignal.timeout(timeoutMs),
			headers: { "user-agent": "pi-net-doctor" },
		});
		const body = await response.body.text();
		return {
			mode,
			ok: true,
			ms: Date.now() - started,
			status: response.statusCode,
			colo: parseColo(body),
		};
	} catch (error) {
		const anyError = error as { name?: string; code?: string; cause?: { code?: string } };
		const code =
			anyError.name === "AbortError" || anyError.name === "TimeoutError"
				? "timeout"
				: (anyError.code ?? anyError.cause?.code ?? anyError.name ?? "error");
		return { mode, ok: false, ms: Date.now() - started, error: String(code) };
	}
}

/**
 * 有限并发地跑一组测量。
 *
 * `limit` 保持较小：同时开太多 TLS 会互相抢带宽，
 * 测出来的数字就不再代表单条线路的真实水平。
 */
export async function probeAll<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T);
		}
	});
	await Promise.all(runners);
	return results;
}

/** 把失败折叠成报告里的一个短记号。 */
export function formatOutcome(outcome: ProbeOutcome): string {
	if (!outcome.ok) return `✗ ${outcome.error ?? "error"}`;
	const suffix = outcome.colo ? ` ${outcome.colo}` : "";
	return `${outcome.ms}ms${suffix}`;
}
