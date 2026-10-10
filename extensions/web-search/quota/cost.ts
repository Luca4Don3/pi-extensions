/** 只估算本轮证实的 web search 费用；不对未来 fetch 或其他后端猜价。 */
import type { QuotaBackend } from "./state-store.js";

export type QuotaOperation = "search" | "fetch";

/** search：Tavily basic 固定 1；Firecrawl sources:web 每开始 10 条 2 积分。 */
export function estimateSearchCost(
	backend: QuotaBackend,
	maxResults: number,
	operation: QuotaOperation = "search",
): number | undefined {
	if (operation !== "search" || !Number.isSafeInteger(maxResults) || maxResults < 1) return undefined;
	if (backend === "tavily") return 1;
	if (backend === "firecrawl") {
		const cost = 2 * Math.ceil(maxResults / 10);
		return Number.isSafeInteger(cost) ? cost : undefined;
	}
	return undefined;
}
