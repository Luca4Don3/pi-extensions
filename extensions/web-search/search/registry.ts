/** 搜索 provider 的纯元数据目录；不依赖认证、凭据或运行时状态。 */

export const PROVIDER_IDS = ["exa", "parallel", "tavily", "firecrawl", "serpapi"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
export type AccessTier = "anonymous" | "free-key" | "billable";

export const ANONYMOUS_PROVIDER_ORDER = ["exa", "tavily", "parallel", "firecrawl"] as const;
export const BILLABLE_PROVIDER_ORDER = ["exa", "tavily", "parallel", "firecrawl", "serpapi"] as const;

export const PROVIDERS: Readonly<
	Record<
		ProviderId,
		{
			readonly id: ProviderId;
			readonly label: string;
			readonly protocol: "mcp" | "rest";
			readonly envVar: string;
			readonly supportedTiers: readonly AccessTier[];
		}
	>
> = {
	exa: { id: "exa", label: "Exa", protocol: "mcp", envVar: "EXA_API_KEY", supportedTiers: ["anonymous", "billable"] },
	parallel: { id: "parallel", label: "Parallel", protocol: "mcp", envVar: "PARALLEL_API_KEY", supportedTiers: ["anonymous", "billable"] },
	tavily: { id: "tavily", label: "Tavily", protocol: "rest", envVar: "TAVILY_API_KEY", supportedTiers: ["anonymous", "billable"] },
	firecrawl: { id: "firecrawl", label: "Firecrawl", protocol: "rest", envVar: "FIRECRAWL_API_KEY", supportedTiers: ["anonymous", "billable"] },
	serpapi: { id: "serpapi", label: "SerpApi", protocol: "rest", envVar: "SERPAPI_API_KEY", supportedTiers: ["billable"] },
};

/** 判断输入是否为目录中登记的 provider。 */
export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(PROVIDERS, value);
}

/** 查询 provider 元数据；无效输入只给出固定诊断，不回显输入值。 */
export function getProviderMetadata(provider: unknown): (typeof PROVIDERS)[ProviderId] {
	if (!isProviderId(provider)) throw new Error("未知的搜索 provider");
	return PROVIDERS[provider];
}

/** 查表判断 provider 是否支持匿名通道。 */
export function hasAnonymousChannel(provider: unknown): boolean {
	return getProviderMetadata(provider).supportedTiers.includes("anonymous");
}
