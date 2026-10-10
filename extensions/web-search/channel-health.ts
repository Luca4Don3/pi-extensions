/** 按后端与认证通道隔离的进程内冷却状态。 */

import { BACKENDS, type Backend } from "./auth.js";
import type { RoutingChannelStatus, SearchChannel } from "./routing.js";

export type ChannelHealthReason = "quota_exhausted" | "rate_limited";

export interface ChannelHealthOptions {
	/** 默认冷却毫秒数；允许 0 禁用，最大 24 小时。 */
	cooldownMs?: number;
	/** 单调测试时钟，返回毫秒时间戳。 */
	clock?: () => number;
}

export interface ChannelHealthFailureOptions {
	/** 本次配置的冷却时间；未提供时使用创建实例时的默认值。 */
	cooldownMs?: number;
	/** Retry-After 原始解析毫秒数，优先于默认冷却时长。 */
	retryAfterMs?: number;
}

export interface ChannelHealthSnapshot {
	cooldownMs: number;
	channels: RoutingChannelStatus[];
}

export interface ChannelHealth {
	readonly cooldownMs: number;
	getCooldown(backend: Backend, channel: SearchChannel): RoutingChannelStatus | undefined;
	recordFailure(
		backend: Backend,
		channel: SearchChannel,
		reason: ChannelHealthReason,
		options?: ChannelHealthFailureOptions,
	): RoutingChannelStatus | undefined;
	recordSuccess(backend: Backend, channel: SearchChannel): void;
	snapshot(): ChannelHealthSnapshot;
}

const DEFAULT_COOLDOWN_MS = 1_800_000;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function validateCooldown(value: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COOLDOWN_MS) {
		throw new Error("通道冷却时长必须为 0 到 86400000 之间的安全整数");
	}
}

function stateKey(backend: Backend, channel: SearchChannel): string {
	return `${backend}:${channel}`;
}

/** 创建独立的内存状态；不同实例不会共享冷却记录。 */
export function createChannelHealth(options: ChannelHealthOptions = {}): ChannelHealth {
	const defaultCooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	validateCooldown(defaultCooldownMs);
	const clock = options.clock ?? Date.now;
	const entries = new Map<string, RoutingChannelStatus>();

	const getCooldown = (backend: Backend, channel: SearchChannel): RoutingChannelStatus | undefined => {
		const key = stateKey(backend, channel);
		const entry = entries.get(key);
		if (entry === undefined) return undefined;
		const now = clock();
		if (entry.until <= now) {
			entries.delete(key);
			return undefined;
		}
		return { ...entry, remainingMs: entry.until - now };
	};

	return {
		cooldownMs: defaultCooldownMs,
		getCooldown,
		recordFailure(backend, channel, reason, failureOptions = {}) {
			const configuredMs = failureOptions.cooldownMs ?? defaultCooldownMs;
			validateCooldown(configuredMs);
			const duration = failureOptions.retryAfterMs ?? configuredMs;
			if (!Number.isSafeInteger(duration) || duration < 0) {
				throw new Error("Retry-After 冷却时长必须为非负安全整数");
			}
			const key = stateKey(backend, channel);
			if (configuredMs === 0 || duration === 0) {
				entries.delete(key);
				return undefined;
			}
			const now = clock();
			const until = Math.min(Number.MAX_SAFE_INTEGER, now + Math.min(duration, MAX_COOLDOWN_MS));
			const entry: RoutingChannelStatus = {
				backend,
				channel,
				coolingDown: true,
				until,
				remainingMs: Math.max(0, until - now),
				reason,
			};
			entries.set(key, entry);
			return { ...entry };
		},
		recordSuccess(backend, channel) {
			entries.delete(stateKey(backend, channel));
		},
		snapshot() {
			const channels: RoutingChannelStatus[] = [];
			for (const backend of BACKENDS) {
				for (const channel of ["free", "key"] as const) {
					const entry = getCooldown(backend, channel);
					if (entry !== undefined) channels.push(entry);
				}
			}
			return { cooldownMs: defaultCooldownMs, channels };
		},
	};
}
