/** Web Search 路由配置与纯状态接口；不读取、不保存任何密钥。 */

import { BACKENDS, envVarName, hasFreeChannel, type Backend } from "./auth.js";

export type RoutingStrategy = "free-first" | "key-first";
export type SearchChannel = "free" | "key";
export type Provider = "auto" | Backend;

export interface RoutingConfig {
	strategy: RoutingStrategy;
	allowPaid: boolean;
	freeCooldownMs: number;
}

export interface RoutingStep {
	backend: Backend;
	channel: SearchChannel;
}

/** 不含凭据内容的冷却通道状态。 */
export interface RoutingChannelStatus {
	backend: Backend;
	channel: SearchChannel;
	coolingDown: boolean;
	until: number;
	remainingMs: number;
	reason: string;
}

/** 可供认证界面展示的路由状态，刻意不包含任何密钥字段。 */
export interface RoutingStatus {
	strategy: RoutingStrategy;
	allowPaid: boolean;
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

	const allowPaidValue = env.PI_WEB_SEARCH_ALLOW_PAID;
	let allowPaid = true;
	if (allowPaidValue !== undefined) {
		const value = allowPaidValue.trim();
		if (value !== "true" && value !== "false") {
			throw new Error("PI_WEB_SEARCH_ALLOW_PAID 必须为 true 或 false");
		}
		allowPaid = value === "true";
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

	return { strategy, allowPaid, freeCooldownMs };
}

/** 按配置生成纯路由步骤；`keys` 仅用于判断是否配置，不进入返回状态。 */
export function buildRoutePlan(
	provider: Provider,
	keys: Readonly<Record<Backend, string | undefined>>,
	config: RoutingConfig,
): RoutingStep[] {
	const selected = provider === "auto" ? [...BACKENDS] : [provider];
	if (!config.allowPaid) {
		if (provider !== "auto" && !hasFreeChannel(provider)) {
			throw new Error(`${provider} 已被 PI_WEB_SEARCH_ALLOW_PAID=false 禁用；当前仅允许免费通道`);
		}
		const freeSteps = selected
			.filter(hasFreeChannel)
			.map((backend) => ({ backend, channel: "free" as const }));
		if (freeSteps.length === 0) {
			throw new Error("PI_WEB_SEARCH_ALLOW_PAID=false 已禁用所有可用的付费通道，且没有免费通道");
		}
		return freeSteps;
	}

	const hasKey = (backend: Backend): boolean => typeof keys[backend] === "string" && keys[backend]!.length > 0;
	const freeStep = (backend: Backend): RoutingStep | undefined =>
		hasFreeChannel(backend) ? { backend, channel: "free" } : undefined;
	const keyStep = (backend: Backend): RoutingStep | undefined =>
		hasKey(backend) ? { backend, channel: "key" } : undefined;

	let steps: RoutingStep[];
	if (provider === "auto" && config.strategy === "free-first") {
		steps = [
			...selected.map(freeStep).filter((step): step is RoutingStep => step !== undefined),
			...selected.map(keyStep).filter((step): step is RoutingStep => step !== undefined),
		];
	} else {
		steps = selected.flatMap((backend) => {
			const ordered = config.strategy === "free-first" ? [freeStep(backend), keyStep(backend)] : [keyStep(backend), freeStep(backend)];
			return ordered.filter((step): step is RoutingStep => step !== undefined);
		});
	}

	if (steps.length === 0) {
		throw new Error(`${provider} 未配置密钥：请设置环境变量 ${envVarName(provider as Backend)} 或使用 /web-search-auth 配置`);
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
		allowPaid: config.allowPaid,
		freeCooldownMs: config.freeCooldownMs,
		channels: channels.map((channel) => ({ ...channel })),
	};
}
