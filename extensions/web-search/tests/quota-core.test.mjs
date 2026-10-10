/** 额度管理器离线测试：只用 fake lookup/fetch 与内存状态，不读配置目录或真实密钥。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import(fileURLToPath(new URL("../quota/core.ts", import.meta.url)));
const usage = await jiti.import(fileURLToPath(new URL("../quota/usage.ts", import.meta.url)));
const costs = await jiti.import(fileURLToPath(new URL("../quota/cost.ts", import.meta.url)));
const { createQuotaManager } = core;
async function initializedManager(options = {}) {
	const manager = createQuotaManager(options);
	await manager.initialize();
	return manager;
}
const SECRET = "FAKE_QUOTA_KEY_MUST_NOT_ESCAPE";
const account = (planUsage = 10, planLimit = 10, paygoUsage = 0, paygoLimit = 0) => ({
	plan_usage: planUsage, plan_limit: planLimit, paygo_usage: paygoUsage, paygo_limit: paygoLimit,
});
const tavilyPayload = (keyUsage = 0, keyLimit = 100, accountRow = account()) => ({ key: { usage: keyUsage, limit: keyLimit }, account: accountRow });
const known = (remaining) => ({ state: "known", remaining, eligibility: "not_verified" });
const input = (overrides = {}) => ({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, ...overrides });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function withFetch(implementation, fn) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = (url, init) => {
		calls.push({ url: String(url), init });
		return implementation(String(url), init, calls.length);
	};
	try { return await fn(calls); } finally { globalThis.fetch = original; }
}

function response(body, status = 200, headers) {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("额度成本严格匹配已证实的 Tavily basic 与 Firecrawl web 搜索", () => {
	assert.equal(costs.estimateSearchCost("tavily", 20), 1);
	assert.equal(costs.estimateSearchCost("firecrawl", 1), 2);
	assert.equal(costs.estimateSearchCost("firecrawl", 10), 2);
	assert.equal(costs.estimateSearchCost("firecrawl", 11), 4);
	assert.equal(costs.estimateSearchCost("exa", 3), undefined);
	assert.equal(costs.estimateSearchCost("tavily", 3, "fetch"), undefined);
	assert.equal(costs.estimateSearchCost("firecrawl", 0), undefined);
});

test("Tavily 严格解析字段名、paid 计划为零时仍计入 paygo", () => {
	assert.deepEqual(usage.parseTavilyUsage(tavilyPayload(90, 100, account(100, 100, 3, 10))), known(7));
	assert.deepEqual(usage.parseTavilyUsage(tavilyPayload(20, 100, account(2, 5, 3, 10))), known(10));
	assert.equal(usage.parseTavilyUsage({ key: { usage: 0, limit: null }, account: account(4, 10, 3, 10) }).remaining, 13);
	assert.equal(usage.parseTavilyUsage({ key: { usage: 9, limit: 10 }, account: account(9, 10, 0, 0) }).remaining, 1);
	for (const malformed of [
		{ key: { usage: 0 }, account: account() },
		{ key: { usage: 0, limit: null }, account: { plan_usage: 0, plan_limit: 0 } },
		{ key: { usage: -1, limit: 10 }, account: account() },
		{ key: { usage: 0, limit: "unlimited" }, account: account() },
		{ key: { usage: 0, limit: Number.MAX_SAFE_INTEGER + 1 }, account: account() },
	]) assert.deepEqual(usage.parseTavilyUsage(malformed), { state: "unknown", reason: "invalid_response" });
	assert.equal(usage.parseTavilyUsage(tavilyPayload(0, null, account())).state, "known");
	assert.equal(usage.parseTavilyUsage(tavilyPayload(0, null, account(0, 10, 0, 0))).remaining, 10);
	assert.equal(usage.parseTavilyUsage(tavilyPayload(0, null, account(0, Number.MAX_SAFE_INTEGER, 0, Number.MAX_SAFE_INTEGER))).state, "unknown", "余额求和溢出必须未知");
});

test("Firecrawl 仅接受 success=true 与非负安全整数余额；账期不推导免费或重置", () => {
	assert.deepEqual(usage.parseFirecrawlUsage({ success: true, data: { remainingCredits: 0, planCredits: 500, billingPeriodEnd: "2099-01-01" } }), known(0));
	assert.deepEqual(usage.parseFirecrawlUsage({ success: true, data: { remainingCredits: 12.5, planCredits: 500 } }), { state: "unknown", reason: "invalid_response" });
	assert.deepEqual(usage.parseFirecrawlUsage({ success: true, data: { remainingCredits: -1 } }), { state: "unknown", reason: "invalid_response" });
	assert.deepEqual(usage.parseFirecrawlUsage({ success: false, data: { remainingCredits: 99 } }), { state: "unknown", reason: "invalid_response" });
});

test("真实查询只允许显式授权 Key，Tavily/Firecrawl 使用固定 GET URL 与 Bearer", async () => {
	const manager = createQuotaManager();
	assert.deepEqual(await manager.lookupBalance(input({ allowBillable: false })), { state: "unknown", reason: "authorization_required" });
	await withFetch((url) => response(url.endsWith("/usage") ? tavilyPayload() : { success: true, data: { remainingCredits: 3 } }), async (calls) => {
		const tavily = await manager.lookupBalance(input());
		const firecrawl = await manager.lookupBalance(input({ backend: "firecrawl", credential: "FAKE_FIRE_KEY" }));
		assert.equal(tavily.state, "known");
		assert.equal(tavily.eligibility, "not_verified");
		assert.equal(firecrawl.remaining, 3);
		assert.deepEqual(calls.map(({ url }) => url), ["https://api.tavily.com/usage", "https://api.firecrawl.dev/v2/team/credit-usage"]);
		for (const call of calls) {
			assert.equal(call.init.method, "GET");
			assert.equal(call.init.headers.accept, "application/json");
		}
		assert.equal(calls[0].init.headers.authorization, `Bearer ${SECRET}`);
		assert.equal(calls[1].init.headers.authorization, "Bearer FAKE_FIRE_KEY");
	});
});

test("查询正文只走有界读取器，不调用 response.text/json", async () => {
	const manager = createQuotaManager();
	await withFetch(() => {
		const result = response(tavilyPayload());
		result.text = () => { throw new Error("不得调用 text"); };
		result.json = () => { throw new Error("不得调用 json"); };
		return result;
	}, async () => assert.equal((await manager.lookupBalance(input())).state, "known"));
});

test("余额缓存五分钟，到期后重新查询；真实免费资格始终 not_verified", async () => {
	let now = 1_000;
	let calls = 0;
	const manager = createQuotaManager({ clock: () => now, lookup: async () => (calls++, known(4)) });
	assert.equal((await manager.lookupBalance(input())).remaining, 4);
	assert.equal((await manager.lookupBalance(input())).cached, true);
	assert.equal(calls, 1);
	now += 299_999;
	assert.equal((await manager.lookupBalance(input())).cached, true);
	now += 1;
	assert.equal((await manager.lookupBalance(input())).cached, false);
	assert.equal(calls, 2);
	assert.equal((await manager.lookupBalance(input())).eligibility, "not_verified");
});

test("失败结果短缓存三十秒且诊断固定、不暴露 lookup 原始错误", async () => {
	let now = 5_000;
	let calls = 0;
	const manager = createQuotaManager({ clock: () => now, lookup: async () => (calls++, { state: "unknown", reason: "invalid_response" }) });
	assert.deepEqual(await manager.lookupBalance(input()), { state: "unknown", reason: "invalid_response", cached: false });
	assert.equal((await manager.lookupBalance(input())).cached, true);
	assert.equal(calls, 1);
	now += 30_000;
	assert.equal((await manager.lookupBalance(input())).cached, false);
	assert.equal(calls, 2);
	const rejected = createQuotaManager({ lookup: async () => { throw new Error(`raw ${SECRET}`); } });
	const safe = await rejected.lookupBalance(input());
	assert.deepEqual(safe, { state: "unknown", reason: "lookup_failed", cached: false });
	assert.ok(!JSON.stringify(safe).includes(SECRET));
});

test("同凭据 singleflight 共享刷新；取消一个等待者不取消其他等待者", async () => {
	let resolveLookup;
	let calls = 0;
	let underlyingSignal;
	const manager = createQuotaManager({ lookup: async (request) => {
		calls++;
		underlyingSignal = request.signal;
		return new Promise((resolve) => { resolveLookup = resolve; });
	} });
	const cancelled = new AbortController();
	const first = manager.lookupBalance(input({ signal: cancelled.signal }));
	const second = manager.lookupBalance(input());
	await tick();
	assert.equal(calls, 1);
	cancelled.abort();
	await assert.rejects(first, (error) => error.name === "AbortError");
	assert.equal(underlyingSignal.aborted, false);
	resolveLookup(known(8));
	assert.equal((await second).remaining, 8);
	assert.equal(calls, 1);
});

test("最后等待者取消会中止底层、不缓存取消为耗尽，迟到拒绝被消费", async () => {
	let rejectLookup;
	let underlyingSignal;
	let calls = 0;
	const manager = createQuotaManager({ lookup: async (request) => {
		calls++;
		underlyingSignal = request.signal;
		if (calls > 1) return known(1);
		return new Promise((_resolve, reject) => { rejectLookup = reject; });
	} });
	const controller = new AbortController();
	const pending = manager.lookupBalance(input({ signal: controller.signal }));
	await tick();
	controller.abort();
	await assert.rejects(pending, (error) => error.name === "AbortError");
	assert.equal(underlyingSignal.aborted, true);
	rejectLookup(new Error(`late ${SECRET}`));
	await tick();
	const next = manager.lookupBalance(input());
	await tick();
	assert.equal(calls, 2, "取消结果不得进入失败缓存");
	assert.equal(underlyingSignal.aborted, false);
	assert.equal((await next).remaining, 1);
});

test("usage fetch 的总 deadline 含挂起 fetch，迟到 rejection 安全消费", async () => {
	const manager = createQuotaManager({ deadlineMs: 25 });
	let rejectFetch;
	await withFetch(() => new Promise((_resolve, reject) => { rejectFetch = reject; }), async () => {
		const started = Date.now();
		const result = await manager.lookupBalance(input());
		assert.equal(result.reason, "timeout");
		assert.ok(Date.now() - started < 500);
		rejectFetch(new Error(`late ${SECRET}`));
		await tick();
	});
});

test("usage stream 超过解压后上限时及时取消，返回未知且只发一个 GET", async () => {
	const manager = createQuotaManager({ deadlineMs: 1_000, maxResponseBytes: 8 });
	await withFetch(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("123456789")); } })), async (calls) => {
		const result = await manager.lookupBalance(input());
		assert.deepEqual(result, { state: "unknown", reason: "invalid_response", cached: false });
		assert.equal(calls.length, 1);
	});
});

test("HTTP 429 Retry-After 记录 key 查询冷却并限制 24 小时，不重复探测", async () => {
	let now = 10_000;
	let calls = 0;
	const manager = createQuotaManager({ clock: () => now, lookup: async () => {
		calls++;
		return { state: "unknown", reason: "rate_limited", retryAfterMs: 99 * 60 * 60 * 1000 };
	} });
	assert.equal((await manager.lookupBalance(input())).reason, "rate_limited");
	assert.equal(manager.getCooldown("tavily", "key", SECRET).remainingMs, 86_400_000);
	const blocked = await manager.lookupBalance(input());
	assert.equal(blocked.reason, "rate_limited");
	assert.equal(calls, 1);
	assert.equal(manager.snapshot().cooldowns[0].channel, "key");
});

test("真实 usage HTTP 429 解析 Retry-After，隐藏上游错误正文", async () => {
	let now = 1_000;
	const manager = createQuotaManager({ clock: () => now });
	await withFetch(() => new Response(`UPSTREAM_RAW_${SECRET}`, { status: 429, headers: { "retry-after": "90" } }), async (calls) => {
		const result = await manager.lookupBalance(input());
		assert.equal(result.reason, "rate_limited");
		assert.ok(!JSON.stringify(result).includes(SECRET));
		assert.equal(calls[0].init.signal.aborted, true);
		assert.equal(manager.getCooldown("tavily", "key", SECRET).remainingMs, 90_000);
		assert.equal(calls.length, 1);
	});
	now += 30_000;
	assert.equal((await manager.lookupBalance(input())).reason, "rate_limited");
});

test("真实 HTTP 429 取消正文并中止请求，不等待或读取无界错误体", async () => {
	const manager = createQuotaManager();
	let cancelled = 0;
	await withFetch(() => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 429, headers: { "retry-after": "1" } }), async (calls) => {
		assert.equal((await manager.lookupBalance(input())).reason, "rate_limited");
		assert.equal(cancelled, 1);
		assert.equal(calls[0].init.signal.aborted, true);
	});
});

test("挂起的 usage stream 也受总 deadline 约束并取消 reader", async () => {
	const manager = createQuotaManager({ deadlineMs: 25 });
	let cancelled = 0;
	await withFetch(() => new Response(new ReadableStream({ pull: () => new Promise(() => undefined), cancel: () => { cancelled++; } })), async (calls) => {
		const started = Date.now();
		const result = await manager.lookupBalance(input());
		assert.equal(result.reason, "timeout");
		assert.ok(Date.now() - started < 500);
		assert.equal(cancelled, 1);
		assert.equal(calls.length, 1);
	});
});

test("rate 与 quota 阶梯历史跨冷却到期保留，成功才清零", async () => {
	let now = 0;
	const manager = await initializedManager({ clock: () => now });
	const rate = [60_000, 120_000, 300_000, 600_000, 1_800_000];
	for (const duration of rate) {
		const state = manager.recordFailure("exa", "anonymous", "rate_limited");
		assert.equal(state.remainingMs, duration);
		assert.equal(manager.getCooldown("exa", "anonymous").remainingMs, duration);
		now += duration;
		assert.equal(manager.getCooldown("exa", "anonymous"), undefined, "到期后才允许 probe，不视为余额恢复");
	}
	const quota = [1_800_000, 3_600_000, 7_200_000, 14_400_000];
	for (const duration of quota) {
		const state = manager.recordFailure("firecrawl", "key", "quota_exhausted", { credential: "FAKE_FC" });
		assert.equal(state.remainingMs, duration);
		assert.equal(state.nextProbeAt, now + duration);
		now += duration;
		assert.equal(manager.getCooldown("firecrawl", "key", "FAKE_FC"), undefined);
	}
	assert.equal(manager.recordFailure("firecrawl", "key", "quota_exhausted", { credential: "FAKE_FC" }).remainingMs, 14_400_000);
	manager.recordSuccess("firecrawl", "key", "FAKE_FC");
	assert.equal(manager.getCooldown("firecrawl", "key", "FAKE_FC"), undefined);
	assert.equal(manager.recordFailure("firecrawl", "key", "quota_exhausted", { credential: "FAKE_FC" }).failureCount, 1);
});

test("Retry-After 优先固定冷却但最大 24h；显式 cooldownMs=0 全局禁用", async () => {
	let now = 2_000;
	const manager = await initializedManager({ clock: () => now, cooldownMs: 0 });
	assert.equal(manager.recordFailure("tavily", "key", "rate_limited", { credential: SECRET, retryAfterMs: 90_000 }), undefined);
	assert.equal(manager.getCooldown("tavily", "key", SECRET), undefined);
	const enabled = await initializedManager({ clock: () => now });
	assert.equal(enabled.recordFailure("tavily", "key", "rate_limited", { credential: SECRET, cooldownMs: 5_000, retryAfterMs: 8_000 }).remainingMs, 8_000);
	assert.equal(enabled.recordFailure("tavily", "key", "rate_limited", { credential: SECRET, retryAfterMs: Number.MAX_SAFE_INTEGER }).remainingMs, 86_400_000);
});

test("匿名/key 与 credential 轮换 scope 隔离，snapshot 不输出任何指纹", async () => {
	const manager = await initializedManager({ clock: () => 1_000 });
	manager.recordFailure("tavily", "anonymous", "rate_limited");
	manager.recordFailure("tavily", "key", "rate_limited", { credential: SECRET });
	manager.recordFailure("tavily", "key", "quota_exhausted", { credential: "ROTATED_FAKE_KEY" });
	assert.equal(manager.getCooldown("tavily", "anonymous").failureCount, 1);
	assert.equal(manager.getCooldown("tavily", "key", SECRET).failureCount, 1);
	assert.equal(manager.getCooldown("tavily", "key", "ROTATED_FAKE_KEY").reason, "quota_exhausted");
	assert.ok(!JSON.stringify(manager.snapshot()).includes(SECRET));
	assert.ok(!JSON.stringify(manager.snapshot()).includes("ROTATED_FAKE_KEY"));
	assert.ok(!JSON.stringify(manager.snapshot()).match(/[a-f0-9]{64}/u));
});

test("重启只恢复冷却，不恢复内存余额；HMAC state 不写入 key", async () => {
	const memory = await jiti.import(fileURLToPath(new URL("../quota/state-store.ts", import.meta.url)));
	const store = memory.createMemoryQuotaStateStore();
	let now = 50_000;
	const first = createQuotaManager({ clock: () => now, stateStore: store, lookup: async () => known(2) });
	await first.initialize();
	assert.equal((await first.lookupBalance(input({ backend: "firecrawl" }))).remaining, 2);
	first.recordFailure("firecrawl", "key", "rate_limited", { credential: SECRET });
	await first.flush();
	const second = createQuotaManager({ clock: () => now, stateStore: store, lookup: async () => { throw new Error("不应重查"); } });
	await second.initialize();
	assert.equal(second.getCooldown("firecrawl", "key", SECRET).reason, "rate_limited");
	assert.equal(second.reserve({ backend: "firecrawl", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }).reason, "unknown_balance");
	assert.ok(!JSON.stringify(await store.load()).includes(SECRET));
});

test("额度不足拒绝；dispatch 前可释放，dispatch 后保守扣费且可信 actualCost 可校正", async () => {
	const manager = createQuotaManager({ lookup: async () => known(3) });
	await manager.lookupBalance(input({ backend: "firecrawl" }));
	const first = manager.reserve({ backend: "firecrawl", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 10 });
	assert.equal(first.status, "reserved");
	assert.equal(first.cost, 2);
	assert.deepEqual(manager.reserve({ backend: "firecrawl", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }), { status: "denied", reason: "insufficient_credits", available: 1 });
	assert.equal(first.reservation.release(), true);
	const reused = manager.reserve({ backend: "firecrawl", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 10 });
	assert.equal(reused.status, "reserved");
	assert.equal(reused.reservation.dispatch(), true);
	assert.equal(reused.reservation.release(), false);
	assert.equal(reused.reservation.settle(1), true);
	assert.equal(manager.reserve({ backend: "firecrawl", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }).status, "reserved");
});

test("dispatch 后即使未获成功也保守消费估算额度", async () => {
	const manager = createQuotaManager({ lookup: async () => known(1) });
	await manager.lookupBalance(input());
	const reserved = manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 });
	assert.equal(reserved.status, "reserved");
	reserved.reservation.dispatch();
	reserved.reservation.settle();
	assert.deepEqual(manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }), { status: "denied", reason: "insufficient_credits", available: 0 });
});

test("余额刷新时保留 inflight reservation 与 debits，避免重复花同一份余额", async () => {
	let now = 0;
	let lookups = 0;
	const manager = createQuotaManager({ clock: () => now, lookup: async () => (lookups++, known(lookups === 1 ? 5 : 4)) });
	await manager.lookupBalance(input());
	const reserved = manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 });
	assert.equal(reserved.status, "reserved");
	now += 300_000;
	assert.equal((await manager.lookupBalance(input())).remaining, 4);
	assert.equal(manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }).status, "reserved");
	assert.equal(reserved.reservation.dispatch(), true);
	reserved.reservation.settle();
	assert.equal(manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }).status, "reserved");
});

test("初始化前同步 HMAC 接口抛固定诊断；注入内存存储不误报持久化", async () => {
	const storeModule = await jiti.import(fileURLToPath(new URL("../quota/state-store.ts", import.meta.url)));
	const manager = createQuotaManager({ stateStore: storeModule.createMemoryQuotaStateStore() });
	assert.equal(manager.snapshot().persistence, "not_initialized");
	const diagnostic = { message: "QUOTA_MANAGER_NOT_INITIALIZED" };
	assert.throws(() => manager.recordFailure("exa", "anonymous", "rate_limited"), diagnostic);
	assert.throws(() => manager.getCooldown("exa", "anonymous"), diagnostic);
	assert.throws(() => manager.recordSuccess("exa", "anonymous"), diagnostic);
	assert.throws(() => manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }), diagnostic);
	await manager.initialize();
	assert.equal(manager.snapshot().persistence, "memory_only");
});

test("未知自定义存储在 save 确认前保守标记内存状态", async () => {
	const store = { async load() { return { status: "missing" }; }, async save() { return { status: "saved" }; } };
	const manager = createQuotaManager({ stateStore: store });
	await manager.initialize();
	assert.equal(manager.snapshot().persistence, "memory_only");
	assert.equal((await manager.flush()).status, "persisted");
	assert.equal(manager.snapshot().persistence, "persistent");
});

test("injected null known 余额按非法响应拒绝，不可作为无限额度", async () => {
	const manager = createQuotaManager({ lookup: async () => ({ state: "known", remaining: null, eligibility: "not_verified" }) });
	assert.deepEqual(await manager.lookupBalance(input()), { state: "unknown", reason: "invalid_response", cached: false });
	assert.deepEqual(manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }), { status: "denied", reason: "unknown_balance" });
});

test("额度耗尽在冷却查询前失效正余额并阻止已预留请求 dispatch", async () => {
	const manager = await initializedManager({ lookup: async () => known(4) });
	await manager.lookupBalance(input());
	const held = manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 });
	assert.equal(held.status, "reserved");
	manager.recordFailure("tavily", "key", "quota_exhausted", { credential: SECRET });
	assert.deepEqual(await manager.lookupBalance(input()), { state: "unknown", reason: "lookup_failed" });
	assert.deepEqual(manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }), { status: "denied", reason: "unknown_balance" });
	assert.equal(held.reservation.dispatch(), false);
	assert.equal(held.reservation.release(), true);
});

test("禁用冷却仍清除额度快照；耗尽前建立的租约不能 dispatch", async () => {
	let lookups = 0;
	const manager = await initializedManager({ cooldownMs: 0, lookup: async () => (lookups++, known(2)) });
	await manager.lookupBalance(input());
	const held = manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 });
	manager.recordFailure("tavily", "key", "quota_exhausted", { credential: SECRET });
	assert.equal(manager.getCooldown("tavily", "key", SECRET), undefined);
	assert.equal((await manager.lookupBalance(input())).remaining, 2, "禁用冷却后只能使用新的探测结果");
	assert.equal(lookups, 2);
	assert.equal(held.reservation.dispatch(), false, "失败 epoch 必须使旧租约失效");
});

test("耗尽声明与旧查询并发时，迟到的旧快照不恢复可用余额", async () => {
	let resolveLookup;
	const manager = await initializedManager({ lookup: async () => new Promise((resolve) => { resolveLookup = resolve; }) });
	const pending = manager.lookupBalance(input());
	await tick();
	manager.recordFailure("tavily", "key", "quota_exhausted", { credential: SECRET });
	resolveLookup(known(9));
	assert.deepEqual(await pending, { state: "unknown", reason: "lookup_failed", cached: false });
	assert.equal(manager.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }).reason, "unknown_balance");
});

test("超时胜出后迟到 Response body 会取消清理", async () => {
	const manager = createQuotaManager({ deadlineMs: 20 });
	let resolveFetch;
	let cancelled = 0;
	await withFetch(() => new Promise((resolve) => { resolveFetch = resolve; }), async () => {
		assert.equal((await manager.lookupBalance(input())).reason, "timeout");
		const delayed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("late")); }, cancel() { cancelled++; } }));
		resolveFetch(delayed);
		await tick();
		assert.equal(cancelled, 1);
	});
});

test("外部取消与已到达 Response 竞态时仍取消未读正文", async () => {
	const manager = createQuotaManager({ deadlineMs: 1_000 });
	let resolveFetch;
	let cancelled = 0;
	const controller = new AbortController();
	await withFetch(() => new Promise((resolve) => { resolveFetch = resolve; }), async () => {
		const pending = manager.lookupBalance(input({ signal: controller.signal }));
		await tick();
		resolveFetch(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode("late")); }, cancel() { cancelled++; } })));
		controller.abort();
		await assert.rejects(pending, (error) => error.name === "AbortError");
		await tick();
		assert.equal(cancelled, 1);
	});
});
