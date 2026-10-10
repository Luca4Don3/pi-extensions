/** Web Search 路由配置与纯状态接口；不读取、不保存任何密钥。 */

import {
	ANONYMOUS_PROVIDER_ORDER,
	BILLABLE_PROVIDER_ORDER,
	getProviderMetadata,
	hasAnonymousChannel,
	type ProviderId,
} from "./search/registry.js";
import type { QuotaSnapshot } from "./quota/core.js";

export type RoutingStrategy = "free-first" | "key-first";
export type SearchChannel = "free" | "key";
export type Provider = "auto" | ProviderId;

export interface RoutingConfig {
	strategy: RoutingStrategy;
	allowBillable: boolean;
	freeCooldownMs: number;
	/** 仅显式设置环境变量时存在；undefined 使用额度管理器的分原因退避阶梯。 */
	cooldownOverrideMs?: number;
}

export interface RoutingStep {
	backend: ProviderId;
	channel: SearchChannel;
}

/** 不含凭据内容的冷却通道状态。 */
export interface RoutingChannelStatus {
	backend: ProviderId;
	channel: SearchChannel;
	coolingDown: boolean;
	until: number;
	remainingMs: number;
	reason: string;
	nextProbeAt?: number;
}

/** 可供认证界面展示的路由状态，刻意不包含任何密钥字段。 */
export interface RoutingStatus {
	strategy: RoutingStrategy;
	allowBillable: boolean;
	freeCooldownMs: number;
	channels: RoutingChannelStatus[];
	quota?: {
		persistence: QuotaSnapshot["persistence"];
		persistenceReason?: string;
		cooldowns: RoutingChannelStatus[];
	};
}

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/** 读取并校验路由环境变量；显式非法值不会静默回退。 */
export function readRoutingConfig(env: Readonly<Record<string, string | undefined>> = process.env): RoutingConfig {
	const strategyValue = env.PI_WEB_SEARCH_ROUTING;
	let strategy: RoutingStrategy = "free-first";
	if (strategyValue !== undefined) {
		const value = strategyValue.trim();
		if (value !== "free-first" && value !== "key-first") {
			throw new Error("PI_WEB_SEARCH_ROUTING 必须为 free-first 或 key-first");
		}
		strategy = value;
	}

	const newBillableValue = env.PI_WEB_SEARCH_ALLOW_BILLABLE;
	const legacyPaidValue = env.PI_WEB_SEARCH_ALLOW_PAID;
	const parsePermission = (name: string, raw: string | undefined): boolean | undefined => {
		if (raw === undefined) return undefined;
		const value = raw.trim();
		if (value !== "true" && value !== "false") throw new Error(`${name} 必须为 true 或 false`);
		return value === "true";
	};
	const newBillable = parsePermission("PI_WEB_SEARCH_ALLOW_BILLABLE", newBillableValue);
	const legacyPaid = parsePermission("PI_WEB_SEARCH_ALLOW_PAID", legacyPaidValue);
	if (newBillable !== undefined && legacyPaid !== undefined && newBillable !== legacyPaid) {
		throw new Error("PI_WEB_SEARCH_ALLOW_BILLABLE 与 PI_WEB_SEARCH_ALLOW_PAID 配置冲突");
	}
	const allowBillable = newBillable ?? legacyPaid ?? false;
	if (allowBillable && strategy === "key-first") {
		throw new Error("PI_WEB_SEARCH_ROUTING=key-first 与 PI_WEB_SEARCH_ALLOW_BILLABLE=true 冲突；请改用 free-first");
	}

	const cooldownValue = env.PI_WEB_SEARCH_FREE_COOLDOWN_MS;
	let freeCooldownMs = 1_800_000;
	if (cooldownValue !== undefined) {
		const value = cooldownValue.trim();
		const parsed = Number(value);
		if (
			value.length === 0 ||
			!Number.isSafeInteger(parsed) ||
			parsed < 0 ||
			parsed > MAX_COOLDOWN_MS
		) {
			throw new Error("PI_WEB_SEARCH_FREE_COOLDOWN_MS 必须为 0 到 86400000 之间的安全整数");
		}
		freeCooldownMs = parsed;
	}

	return {
		strategy,
		allowBillable,
		freeCooldownMs,
		...(cooldownValue === undefined ? {} : { cooldownOverrideMs: freeCooldownMs }),
	};
}

/** 构造无需读取凭据的候选顺序；所有匿名后端先尝试，再按独立付费顺序延迟解析 Key。 */
export function buildRouteCandidates(provider: Provider, config: RoutingConfig): RoutingStep[] {
	if (config.strategy !== "free-first" && config.strategy !== "key-first") {
		throw new Error("strategy 必须为 free-first 或 key-first");
	}
	if (provider !== "auto") getProviderMetadata(provider);
	if (config.allowBillable && config.strategy === "key-first") {
		throw new Error("PI_WEB_SEARCH_ROUTING=key-first 与 PI_WEB_SEARCH_ALLOW_BILLABLE=true 冲突；请改用 free-first");
	}

	const anonymous = provider === "auto"
		? ANONYMOUS_PROVIDER_ORDER
		: hasAnonymousChannel(provider) ? [provider] : [];
	if (!config.allowBillable && provider !== "auto" && anonymous.length === 0) {
		throw new Error(`${provider} 已被 PI_WEB_SEARCH_ALLOW_BILLABLE=false 禁用；当前仅允许匿名通道`);
	}
	const billable = config.allowBillable
		? provider === "auto" ? BILLABLE_PROVIDER_ORDER : [provider]
		: [];
	return [
		...anonymous.map((backend) => ({ backend, channel: "free" as const })),
		...billable.map((backend) => ({ backend, channel: "key" as const })),
	];
}

/** 按配置生成纯路由步骤；旧 `keys` 参数只作筛选，不读取或返回凭据。 */
export function buildRoutePlan(
	provider: Provider,
	keys: Readonly<Record<ProviderId, string | undefined>>,
	config: RoutingConfig,
): RoutingStep[] {
	const candidates = buildRouteCandidates(provider, config);
	const steps = candidates.filter((step) => step.channel === "free" ||
		(typeof keys[step.backend] === "string" && keys[step.backend]!.length > 0));
	if (steps.length === 0) {
		if (provider === "auto") throw new Error("未配置可用的搜索通道");
		throw new Error(`${provider} 未配置密钥：请设置环境变量 ${getProviderMetadata(provider).envVar} 或使用 /web-search-auth 配置`);
	}
	return steps;
}

/** 组装供状态界面使用的数据，不携带密钥配置或凭据内容。 */
export function getRoutingStatus(
	config: RoutingConfig = readRoutingConfig(),
	channels: readonly RoutingChannelStatus[] = [],
	quotaSnapshot?: QuotaSnapshot,
): RoutingStatus {
	return {
		strategy: config.strategy,
		allowBillable: config.allowBillable,
		freeCooldownMs: config.freeCooldownMs,
		channels: channels.map((channel) => ({ ...channel })),
		...(quotaSnapshot === undefined ? {} : {
			quota: {
				persistence: quotaSnapshot.persistence,
				...(quotaSnapshot.persistenceReason === undefined ? {} : { persistenceReason: quotaSnapshot.persistenceReason }),
				cooldowns: quotaSnapshot.cooldowns.map((cooldown) => ({
					backend: cooldown.backend,
					channel: cooldown.channel === "anonymous" ? "free" : "key",
					coolingDown: true,
					until: cooldown.until,
					remainingMs: cooldown.remainingMs,
					reason: cooldown.reason,
					...(cooldown.nextProbeAt === undefined ? {} : { nextProbeAt: cooldown.nextProbeAt }),
				})),
			},
		}),
	};
}
