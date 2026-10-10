/** 路由配置与进程内通道冷却状态测试。 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const healthModule = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const routing = await jiti.import(fileURLToPath(new URL("../routing.ts", import.meta.url)));
const { createChannelHealth } = healthModule;

test("冷却按 backend+channel 隔离，并在时钟到期后清理", () => {
	let now = 10_000;
	const health = createChannelHealth({ cooldownMs: 1_000, clock: () => now });
	health.recordFailure("exa", "free", "quota_exhausted");
	assert.equal(health.getCooldown("exa", "free").remainingMs, 1_000);
	assert.equal(health.getCooldown("exa", "key"), undefined);
	assert.equal(health.getCooldown("parallel", "free"), undefined);
	assert.equal(health.snapshot().channels.length, 1);

	health.recordFailure("parallel", "free", "rate_limited", { retryAfterMs: 2_000 });
	assert.equal(health.getCooldown("parallel", "free").remainingMs, 2_000);
	health.recordSuccess("exa", "free");
	assert.equal(health.getCooldown("exa", "free"), undefined);
	assert.equal(health.getCooldown("parallel", "free").remainingMs, 2_000);

	now += 2_000;
	assert.equal(health.getCooldown("parallel", "free"), undefined);
	assert.deepEqual(health.snapshot().channels, []);
});

test("冷却可禁用，快照不包含密钥字段", () => {
	const health = createChannelHealth({ cooldownMs: 0, clock: () => 0 });
	health.recordFailure("exa", "free", "quota_exhausted");
	assert.deepEqual(health.snapshot().channels, []);
	const status = routing.getRoutingStatus(
		{ strategy: "free-first", allowPaid: false, freeCooldownMs: 0 },
		health.snapshot().channels,
	);
	assert.deepEqual(status, { strategy: "free-first", allowPaid: false, freeCooldownMs: 0, channels: [] });
	assert.equal("keys" in status, false);
});

test("上游 Retry-After 不得使通道冷却超过 24 小时", () => {
	const health = createChannelHealth({ clock: () => 1000 });
	health.recordFailure("exa", "free", "rate_limited", { retryAfterMs: Number.MAX_SAFE_INTEGER });
	assert.equal(health.getCooldown("exa", "free").remainingMs, 86_400_000);
});

test("默认免费优先、显式 provider 与 key-first 路由顺序", () => {
	const keys = { exa: "e", parallel: "p", tavily: "t", serpapi: "s" };
	const config = routing.readRoutingConfig({});
	assert.deepEqual(config, { strategy: "free-first", allowPaid: true, freeCooldownMs: 1_800_000 });
	assert.deepEqual(
		routing.buildRoutePlan("auto", keys, config),
		[
			{ backend: "exa", channel: "free" },
			{ backend: "parallel", channel: "free" },
			{ backend: "exa", channel: "key" },
			{ backend: "parallel", channel: "key" },
			{ backend: "tavily", channel: "key" },
			{ backend: "serpapi", channel: "key" },
		],
	);
	assert.deepEqual(
		routing.buildRoutePlan("exa", keys, config),
		[{ backend: "exa", channel: "free" }, { backend: "exa", channel: "key" }],
	);
	const keyFirst = routing.readRoutingConfig({ PI_WEB_SEARCH_ROUTING: "key-first" });
	assert.deepEqual(
		routing.buildRoutePlan("auto", keys, keyFirst).slice(0, 4),
		[
			{ backend: "exa", channel: "key" },
			{ backend: "exa", channel: "free" },
			{ backend: "parallel", channel: "key" },
			{ backend: "parallel", channel: "free" },
		],
	);
	assert.deepEqual(
		routing.buildRoutePlan("tavily", keys, config),
		[{ backend: "tavily", channel: "key" }],
	);
});

test("付费禁用只提供免费通道，并清楚拒绝无免费通道的 provider", () => {
	const config = routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_PAID: "false" });
	assert.deepEqual(
		routing.buildRoutePlan("auto", { exa: "e", parallel: "p", tavily: "t", serpapi: "s" }, config),
		[{ backend: "exa", channel: "free" }, { backend: "parallel", channel: "free" }],
	);
	assert.deepEqual(routing.buildRoutePlan("exa", { exa: "e", parallel: undefined, tavily: undefined, serpapi: undefined }, config), [
		{ backend: "exa", channel: "free" },
	]);
	assert.throws(
		() => routing.buildRoutePlan("tavily", { exa: undefined, parallel: undefined, tavily: "t", serpapi: undefined }, config),
		/已被 PI_WEB_SEARCH_ALLOW_PAID=false 禁用/,
	);
});

test("显式非法路由配置报错并限制冷却上限", () => {
	assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_ROUTING: "sometimes" }), /PI_WEB_SEARCH_ROUTING/);
	assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_PAID: "yes" }), /PI_WEB_SEARCH_ALLOW_PAID/);
	for (const value of ["-1", "1.5", "9007199254740992", "86400001", ""]) {
		assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: value }), /PI_WEB_SEARCH_FREE_COOLDOWN_MS/);
	}
	assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0" }).freeCooldownMs, 0);
	assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "86400000" }).freeCooldownMs, 86_400_000);
});
