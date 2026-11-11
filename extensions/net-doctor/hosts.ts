/**
 * 厂商链路注册表。
 *
 * 这里是**数据**，不是代码分支：新增一个厂商等于加一行，不需要新的 if。
 * 这正是"普遍适配各厂商"的正确形态——适配成本是一行配置，而不是一份实现。
 *
 * 分类依据是"边缘可观测性"，不是厂商重要性：
 *
 *   cloudflare —— 域名前置在 Cloudflare 上，有 `/cdn-cgi/trace` 可以读到 `colo`
 *                 （边缘机房身份）。只有这一类能做"优选 IP"，也只有这一类能被验证。
 *   opaque     —— 没有等价的边缘身份端点，只能测延迟，不能用 IP 优选
 *                 （写 hosts 也无法验证收益）。
 *
 * 依据是 2026-11-11 在本机的实测：
 *   open-design.ai / opencode.ai / openrouter.ai 均为 CF 前置（真实解析落在 CF 网段且有 cf-ray）
 *   chatgpt.com / api.openai.com / api.x.ai 均解析到不属于对应厂商的地址空间
 *   （分别属 DreamHost 与 Facebook 段），是本地 DNS 污染，只能靠代理端解析。
 *   具体地址不入库：写死一份会过期的快照，比不写更糟。
 */

/** 边缘可观测性分类。 */
export type EdgeKind = "cloudflare" | "opaque";

/**
 * 路由模式。
 *
 * `direct-v4` 是本机实测的最优解：强制 IPv4 后 p50 718ms、5/5 成功、
 * 落点稳定在 SJC；而 Pi 默认的 `autoSelectFamily` 先试 IPv6，
 * 在 IPv6 质量差的线路上要等满 2s 才回退，p50 高达 2815ms。
 */
export type RouteMode =
  /** 直连并强制 IPv4。 */
  | "direct-v4"
  /** 直连，地址族交给系统决定。 */
  | "direct"
  /** 固定走本地代理。 */
  | "proxy"
  /** 不干预：由其他扩展或 Pi 默认 dispatcher 处理。 */
  | "passthrough";

/** 一条 host 链路策略。 */
export interface HostRoute {
	/** 精确 hostname，不含端口与路径。 */
	readonly host: string;
	/** 所属 provider id，用于报告分组。 */
	readonly provider: string;
	readonly edge: EdgeKind;
	readonly mode: RouteMode;
	/** 诊断探针路径；CF host 用 `/cdn-cgi/trace` 才能拿到 colo。 */
	readonly probePath?: string;
	/** 给人看的取舍说明，出现在诊断报告里。 */
	readonly note?: string;
}

/**
 * 注册表。
 *
 * 只有 `amr-link.open-design.ai` 与 `open-design.ai` 被切到 `direct-v4`，
 * 因为这是本次唯一经过实测验证的改动（2815ms → 718ms）。
 * 其余 host 一律 `passthrough`：未经测量就改写，等于用猜测替换现状。
 */
export const ROUTES: readonly HostRoute[] = [
	{
		host: "amr-link.open-design.ai",
		provider: "opendesign",
		edge: "cloudflare",
		mode: "direct-v4",
		probePath: "/cdn-cgi/trace",
		note: "推理与模型目录端点。直连 IPv4 实测 718ms/5-of-5，落点 SJC；默认配置 2815ms。",
	},
	{
		host: "open-design.ai",
		provider: "opendesign",
		edge: "cloudflare",
		mode: "direct-v4",
		probePath: "/cdn-cgi/trace",
		note: "站点域名，与 API 同源策略。",
	},
	{
		host: "opencode.ai",
		provider: "opencode-go",
		edge: "cloudflare",
		mode: "passthrough",
		probePath: "/cdn-cgi/trace",
		note: "由 opencode-fallback 扩展接管（含按模型固定代理），此处不重复干预。",
	},
	{
		host: "openrouter.ai",
		provider: "openrouter",
		edge: "cloudflare",
		mode: "passthrough",
		probePath: "/cdn-cgi/trace",
		note: "未接入，仅纳入诊断。",
	},
	{
		host: "api.anthropic.com",
		provider: "anthropic",
		edge: "opaque",
		mode: "passthrough",
		note: "有 cf-ray 但使用自有地址段，无法读 colo，只能测延迟。",
	},
	{
		host: "api.openai.com",
		provider: "openai",
		edge: "opaque",
		mode: "passthrough",
		note: "本机 DNS 污染：解析到不属于 OpenAI 的地址段（Facebook 段），必须依赖代理端解析。",
	},
	{
		host: "chatgpt.com",
		provider: "openai-codex",
		edge: "opaque",
		mode: "passthrough",
		note: "本机 DNS 污染：解析到不属于 OpenAI 的地址段（DreamHost 段）。",
	},
	{
		host: "api.x.ai",
		provider: "xai",
		edge: "opaque",
		mode: "passthrough",
		note: "本机 DNS 污染：解析到不属于 xAI 的地址段（Facebook 段）。",
	},
	{
		host: "generativelanguage.googleapis.com",
		provider: "google",
		edge: "opaque",
		mode: "passthrough",
		note: "解析正常，仅诊断。",
	},
];

/** 归一化 hostname：小写并去掉末尾的点。 */
export function normalizeHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * 精确匹配注册表。
 *
 * 刻意**不做**后缀通配：子域可以属于完全不同的 provider，
 * 把 `*.open-design.ai` 一律套用同一策略会把未验证的域名一起改掉。
 */
export function matchRoute(
	hostname: string,
	routes: readonly HostRoute[] = ROUTES,
): HostRoute | undefined {
	const target = normalizeHostname(hostname);
	return routes.find((route) => route.host === target);
}

/** 需要实际改写 dispatcher 的路由（即排除 passthrough）。 */
export function isActiveRoute(route: HostRoute): boolean {
	return route.mode !== "passthrough";
}
