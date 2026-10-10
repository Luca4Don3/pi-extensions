/** 路由配置与进程内通道冷却状态测试。 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const healthModule = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const routing = await jiti.import(fileURLToPath(new URL("../routing.ts", import.meta.url)));
const { createChannelHealth } = healthModule;

const allKeys = { exa: "e", parallel: "p", tavily: "t", firecrawl: "f", serpapi: "s" };

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
		{ strategy: "free-first", allowBillable: false, freeCooldownMs: 0 },
		health.snapshot().channels,
	);
	assert.deepEqual(status, { strategy: "free-first", allowBillable: false, freeCooldownMs: 0, channels: [] });
	assert.equal("keys" in status, false);
});

test("上游 Retry-After 不得使通道冷却超过 24 小时", () => {
	const health = createChannelHealth({ clock: () => 1000 });
	health.recordFailure("exa", "free", "rate_limited", { retryAfterMs: Number.MAX_SAFE_INTEGER });
	assert.equal(health.getCooldown("exa", "free").remainingMs, 86_400_000);
});

test("默认禁用计费；auto 免费优先顺序及指定 provider 限制", () => {
	const config = routing.readRoutingConfig({});
	assert.deepEqual(config, { strategy: "free-first", allowBillable: false, freeCooldownMs: 1_800_000 });
	assert.deepEqual(routing.buildRoutePlan("auto", allKeys, config), [
		{ backend: "exa", channel: "free" },
		{ backend: "tavily", channel: "free" },
		{ backend: "parallel", channel: "free" },
		{ backend: "firecrawl", channel: "free" },
	]);
	assert.deepEqual(
		routing.buildRoutePlan("tavily", allKeys, config),
		[{ backend: "tavily", channel: "free" }],
	);

	const authorized = routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" });
	assert.deepEqual(routing.buildRoutePlan("auto", allKeys, authorized), [
		{ backend: "exa", channel: "free" },
		{ backend: "tavily", channel: "free" },
		{ backend: "parallel", channel: "free" },
		{ backend: "firecrawl", channel: "free" },
		{ backend: "exa", channel: "key" },
		{ backend: "tavily", channel: "key" },
		{ backend: "parallel", channel: "key" },
		{ backend: "firecrawl", channel: "key" },
		{ backend: "serpapi", channel: "key" },
	]);
	assert.deepEqual(routing.buildRoutePlan("tavily", allKeys, authorized), [
		{ backend: "tavily", channel: "free" },
		{ backend: "tavily", channel: "key" },
	]);
});

test("新旧计费授权变量严格校验，旧变量仅作为显式别名", () => {
	assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }).allowBillable, true);
	assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: "false" }).allowBillable, false);
	assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_PAID: "true" }).allowBillable, true);
	assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_PAID: "false" }).allowBillable, false);
	for (const value of ["true", "false"]) {
		assert.equal(routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: value, PI_WEB_SEARCH_ALLOW_PAID: value }).allowBillable, value === "true");
	}
	assert.throws(
		() => routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_ALLOW_PAID: "false" }),
		/配置冲突/,
	);
	assert.throws(
		() => routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: "false", PI_WEB_SEARCH_ALLOW_PAID: "true" }),
		/配置冲突/,
	);
	assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_BILLABLE: "yes" }), /PI_WEB_SEARCH_ALLOW_BILLABLE/);
	assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_ALLOW_PAID: "yes" }), /PI_WEB_SEARCH_ALLOW_PAID/);
});

test("未授权 key-first 保持匿名兼容；授权 key-first 明确要求迁移 free-first", () => {
	// 未授权时 key-first 只保留匿名兼容；授权后 key-first 会与“免费通道全部优先”冲突，必须在读取配置时报错。
	const keyFirst = routing.readRoutingConfig({ PI_WEB_SEARCH_ROUTING: "key-first" });
	assert.deepEqual(routing.buildRoutePlan("auto", allKeys, keyFirst), [
		{ backend: "exa", channel: "free" },
		{ backend: "tavily", channel: "free" },
		{ backend: "parallel", channel: "free" },
		{ backend: "firecrawl", channel: "free" },
	]);
	assert.throws(() => routing.buildRoutePlan("serpapi", allKeys, keyFirst), /已被 PI_WEB_SEARCH_ALLOW_BILLABLE=false 禁用/);
	assert.throws(
		() => routing.readRoutingConfig({ PI_WEB_SEARCH_ROUTING: "key-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }),
		/free-first|冲突/u,
	);
});

test("显式非法策略报错并限制冷却上限", () => {
	assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_ROUTING: "sometimes" }), /PI_WEB_SEARCH_ROUTING/);
	assert.throws(
		() => routing.buildRoutePlan("auto", allKeys, { strategy: "sometimes", allowBillable: true, freeCooldownMs: 0 }),
		/strategy/,
	);
	for (const value of ["-1", "1.5", "9007199254740992", "86400001", ""]) {
		assert.throws(() => routing.readRoutingConfig({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: value }), /PI_WEB_SEARCH_FREE_COOLDOWN_MS/);
	}
	const zeroOverride = routing.readRoutingConfig({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0" });
	assert.equal(zeroOverride.freeCooldownMs, 0);
	assert.equal(zeroOverride.cooldownOverrideMs, 0);
	const maxOverride = routing.readRoutingConfig({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "86400000" });
	assert.equal(maxOverride.freeCooldownMs, 86_400_000);
	assert.equal(maxOverride.cooldownOverrideMs, 86_400_000);
});
