/** Web Search 路由配置与纯状态接口；不读取、不保存任何密钥。 */

import {
	ANONYMOUS_PROVIDER_ORDER,
	getProviderMetadata,
	hasAnonymousChannel,
	PROVIDER_IDS,
	type ProviderId,
} from "./search/registry.js";

export type RoutingStrategy = "free-first" | "key-first";
export type SearchChannel = "free" | "key";
export type Provider = "auto" | ProviderId;

export interface RoutingConfig {
	strategy: RoutingStrategy;
	allowBillable: boolean;
	freeCooldownMs: number;
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
}

/** 可供认证界面展示的路由状态，刻意不包含任何密钥字段。 */
export interface RoutingStatus {
	strategy: RoutingStrategy;
	allowBillable: boolean;
	freeCooldownMs: number;
	channels: RoutingChannelStatus[];
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

	return { strategy, allowBillable, freeCooldownMs };
}

/** 按配置生成纯路由步骤；`keys` 仅用于判断是否配置，不进入返回状态。 */
export function buildRoutePlan(
	provider: Provider,
	keys: Readonly<Record<ProviderId, string | undefined>>,
	config: RoutingConfig,
): RoutingStep[] {
	if (config.strategy !== "free-first" && config.strategy !== "key-first") {
		throw new Error("strategy 必须为 free-first 或 key-first");
	}
	if (provider !== "auto") getProviderMetadata(provider);

	const selectedAnonymous = provider === "auto"
		? ANONYMOUS_PROVIDER_ORDER
		: hasAnonymousChannel(provider) ? [provider] : [];
	if (!config.allowBillable) {
		if (provider !== "auto" && selectedAnonymous.length === 0) {
			throw new Error(`${provider} 已被 PI_WEB_SEARCH_ALLOW_BILLABLE=false 禁用；当前仅允许匿名通道`);
		}
		return selectedAnonymous.map((backend) => ({ backend, channel: "free" }));
	}

	const hasKey = (backend: ProviderId): boolean => typeof keys[backend] === "string" && keys[backend]!.length > 0;
	const freeStep = (backend: ProviderId): RoutingStep | undefined =>
		hasAnonymousChannel(backend) ? { backend, channel: "free" } : undefined;
	const keyStep = (backend: ProviderId): RoutingStep | undefined =>
		hasKey(backend) ? { backend, channel: "key" } : undefined;

	let steps: RoutingStep[];
	if (provider === "auto" && config.strategy === "free-first") {
		steps = [
			...ANONYMOUS_PROVIDER_ORDER.map(freeStep).filter((step): step is RoutingStep => step !== undefined),
			...PROVIDER_IDS.map(keyStep).filter((step): step is RoutingStep => step !== undefined),
		];
	} else {
		const selected = provider === "auto" ? PROVIDER_IDS : [provider];
		steps = selected.flatMap((backend) => {
			const ordered = config.strategy === "free-first"
				? [freeStep(backend), keyStep(backend)]
				: [keyStep(backend), freeStep(backend)];
			return ordered.filter((step): step is RoutingStep => step !== undefined);
		});
	}

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
): RoutingStatus {
	return {
		strategy: config.strategy,
		allowBillable: config.allowBillable,
		freeCooldownMs: config.freeCooldownMs,
		channels: channels.map((channel) => ({ ...channel })),
	};
}
