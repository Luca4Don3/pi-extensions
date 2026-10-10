import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const { createQuotaManager } = await jiti.import(fileURLToPath(new URL("../quota/core.ts", import.meta.url)));
const { createPrivateQuotaStateStore } = await jiti.import(fileURLToPath(new URL("../quota/state-store.ts", import.meta.url)));
const { PROVIDER_IDS, PROVIDERS } = await jiti.import(fileURLToPath(new URL("../search/registry.ts", import.meta.url)));
const KEY_ENVS = Object.fromEntries(PROVIDER_IDS.map((id) => [id, PROVIDERS[id].envVar]));
const PRIVATE_TEST_ROOT = fileURLToPath(new URL("../../../.temp/quota-validation/", import.meta.url));
const fakeKey = (provider) => `FAKE_QUOTA_ROUTING_${provider.toUpperCase()}`;
const tavilyBody = (remaining) => ({
	key: { usage: 0, limit: remaining },
	account: { plan_usage: 0, plan_limit: remaining, paygo_usage: 0, paygo_limit: 0 },
});
const firecrawlBody = (remainingCredits) => ({ success: true, data: { remainingCredits, planCredits: 100 } });
const mcpBody = (text = "Title: 文档\nURL: https://example.com/doc") => JSON.stringify({ result: { content: [{ type: "text", text }] } });
const tavilySearchBody = JSON.stringify({ results: [{ url: "https://example.com/doc", title: "文档", content: "内容" }] });
const firecrawlSearchBody = JSON.stringify({ success: true, data: { web: [{ url: "https://example.com/doc", title: "文档", description: "内容" }] } });

function createStore(keys = {}, reads = []) {
	return {
		kind: "none",
		async read(provider) {
			reads.push(provider);
			return keys[provider] ? { status: "found", value: keys[provider] } : { status: "missing" };
		},
		async write() { return { status: "unavailable", reason: "fake" }; },
		async clear() { return { status: "missing" }; },
	};
}

function setup({ store = createStore(), quotaManager, channelHealth } = {}) {
	let tool;
	plugin({ registerTool: (entry) => { tool = entry; }, registerCommand: () => {} }, {
		credentialStore: store,
		...(quotaManager ? { quotaManager } : {}),
		...(channelHealth ? { channelHealth } : {}),
	});
	return tool;
}

async function withEnv(vars, fn) {
	const original = process.env;
	const reads = Object.fromEntries(Object.values(KEY_ENVS).map((name) => [name, 0]));
	const values = {
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_TIMEOUT_MS: "1500",
		PI_WEB_SEARCH_ALLOW_BILLABLE: "false",
		...Object.fromEntries(Object.values(KEY_ENVS).map((name) => [name, undefined])),
		...vars,
	};
	process.env = new Proxy(values, {
		get(target, key) {
			if (typeof key === "string" && Object.hasOwn(reads, key)) reads[key]++;
			return target[key];
		},
	});
	try { return await fn(reads); } finally { process.env = original; }
}

async function withFetch(implementation, fn) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = (url, init = {}) => {
		const call = { url: String(url), init };
		calls.push(call);
		return implementation(call, calls.length);
	};
	try { return await fn(calls); } finally { globalThis.fetch = original; }
}

function response(body = "", status = 200, headers = {}) {
	return new Response(body, { status, headers });
}

function isAuthorized(call) {
	return Boolean(call.init.headers?.authorization) || call.url.includes("exaApiKey=") || call.url.includes("api_key=");
}

function providerFailure(call) {
	return response("", 401);
}

async function preflightManager(backend, credential, remaining, options = {}) {
	const manager = createQuotaManager({ ...options, lookup: async () => ({ state: "known", remaining, eligibility: "not_verified" }) });
	await manager.lookupBalance({ backend, channel: "key", credential, allowBillable: true });
	return manager;
}

test("授权后的匿名成功不查询余额；解析凭据用于脱敏，但不发送带凭据请求", async () => {
	const storeReads = [];
	const tool = setup({ store: createStore({ exa: fakeKey("exa") }, storeReads) });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", EXA_API_KEY: fakeKey("exa") }, async () => {
		await withFetch((call) => call.url.includes("mcp.exa.ai") ? response(mcpBody()) : assert.fail(`意外请求 ${call.url}`), async (calls) => {
			const result = await tool.execute("anon-fast", { query: "查询", provider: "auto" });
			assert.equal(result.details.provider, "exa");
			assert.equal(result.details.channel, "free");
			assert.equal(calls.length, 1);
			assert.ok(!isAuthorized(calls[0]), "匿名成功前不得发送任何带凭据的请求");
			assert.deepEqual(storeReads, ["parallel", "tavily", "firecrawl", "serpapi"], "授权时为脱敏解析全部后端，未配置环境变量的部分回落到密钥库");
		});
	});
});

test("匿名全部失败后才按独立付费顺序尝试已配置密钥", async () => {
	const storeReads = [];
	const tool = setup({ store: createStore({ exa: fakeKey("exa") }, storeReads) });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", EXA_API_KEY: fakeKey("exa"), TAVILY_API_KEY: fakeKey("tavily") }, async () => {
		await withFetch((call) => {
			if (call.url.includes("mcp.exa.ai") && call.url.includes("exaApiKey=")) return response(mcpBody());
			return providerFailure(call);
		}, async (calls) => {
			const result = await tool.execute("lazy-key", { query: "查询", provider: "auto" });
			assert.equal(result.details.provider, "exa");
			assert.deepEqual(calls.slice(0, 5).map((call) => call.url.match(/exa\.ai|tavily\.com|parallel\.ai|firecrawl\.dev|agent\.tinyfish\.ai/)?.[0]), ["exa.ai", "tavily.com", "parallel.ai", "firecrawl.dev", "agent.tinyfish.ai"]);
			assert.ok(calls[5].url.includes("exaApiKey="));
			assert.deepEqual(storeReads, ["parallel", "firecrawl", "serpapi"]);
		});
	});
});

test("所有匿名通道失败时逐个检查缺失 Key；未授权时绝不读取环境或密钥库", async () => {
	const storeReads = [];
	const tool = setup({ store: createStore({}, storeReads) });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async (reads) => {
		await withFetch(providerFailure, async (calls) => {
			await assert.rejects(tool.execute("missing-keys", { query: "查询" }), /未配置密钥/u);
			assert.equal(calls.length, 5);
			assert.deepEqual(storeReads, ["exa", "parallel", "tavily", "firecrawl", "serpapi"]);
			// 每个可能计费后端解析一次；零凭据的 TinyFish 完全不进入密钥解析集合。
			assert.deepEqual(reads, { EXA_API_KEY: 1, PARALLEL_API_KEY: 1, TAVILY_API_KEY: 1, FIRECRAWL_API_KEY: 1, SERPAPI_API_KEY: 1, TINYFISH_API_KEY: 0 });
		});
	});

	const noBillingReads = [];
	const noBillingTool = setup({ store: createStore({}, noBillingReads) });
	await withEnv({}, async (reads) => {
		await withFetch(providerFailure, async (calls) => {
			await assert.rejects(noBillingTool.execute("no-billing", { query: "查询" }));
			assert.equal(calls.length, 5);
			assert.deepEqual(noBillingReads, []);
			assert.deepEqual(reads, { EXA_API_KEY: 0, PARALLEL_API_KEY: 0, TAVILY_API_KEY: 0, FIRECRAWL_API_KEY: 0, SERPAPI_API_KEY: 0, TINYFISH_API_KEY: 0 });
		});
	});
});

test("Tavily 零余额与 Firecrawl 不足以支付四积分时均不发 Key 搜索", async () => {
	for (const [backend, keyEnv, usageUrl, usagePayload, params] of [
		["tavily", "TAVILY_API_KEY", "/usage", tavilyBody(0), { provider: "tavily" }],
		["firecrawl", "FIRECRAWL_API_KEY", "/credit-usage", firecrawlBody(3), { provider: "firecrawl", maxResults: 11 }],
	]) {
		const token = fakeKey(backend);
		const tool = setup();
		await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", [keyEnv]: token }, async () => {
			await withFetch((call) => {
				if (call.init.method === "GET" && call.url.includes(usageUrl)) return response(JSON.stringify(usagePayload));
				if (call.init.method === "POST" && !isAuthorized(call)) return providerFailure(call);
				assert.fail(`额度不足时不应发 Key 搜索：${call.url}`);
			}, async (calls) => {
				await assert.rejects(tool.execute(`insufficient-${backend}`, { query: "查询", ...params }), /quota_preflight/u);
				assert.equal(calls.filter((call) => call.init.method === "GET").length, 1);
				assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 0);
			});
		});
	}
});

test("额度查询失败短缓存；未知余额不会发搜索 POST", async () => {
	const token = fakeKey("tavily");
	const tool = setup();
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", TAVILY_API_KEY: token }, async () => {
		await withFetch((call) => call.init.method === "GET" ? response("unavailable", 503) : providerFailure(call), async (calls) => {
			for (let index = 0; index < 2; index++) await assert.rejects(tool.execute(`unknown-${index}`, { query: "查询", provider: "tavily" }), /quota_preflight/u);
			assert.equal(calls.filter((call) => call.init.method === "GET").length, 1);
			assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 0);
		});
	});
});

test("五分钟余额缓存与并发预留按 Tavily 每次一积分原子扣额", async () => {
	let lookups = 0;
	const manager = createQuotaManager({ lookup: async () => (lookups++, { state: "known", remaining: 1, eligibility: "not_verified" }) });
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", TAVILY_API_KEY: fakeKey("tavily") }, async () => {
		await withFetch((call) => {
			if (call.init.method === "GET") assert.fail("fake lookup 不应访问网络");
			if (!isAuthorized(call)) return providerFailure(call);
			return response(tavilySearchBody);
		}, async (calls) => {
			const results = await Promise.allSettled([
				tool.execute("atomic-a", { query: "查询", provider: "tavily" }),
				tool.execute("atomic-b", { query: "查询", provider: "tavily" }),
			]);
			assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
			assert.equal(lookups, 1);
			assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 1);
		});
	});
});

test("Firecrawl 每次 11 条搜索预留四积分，缓存余额可供多次执行", async () => {
	let lookups = 0;
	const manager = createQuotaManager({ lookup: async () => (lookups++, { state: "known", remaining: 8, eligibility: "not_verified" }) });
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", FIRECRAWL_API_KEY: fakeKey("firecrawl") }, async () => {
		await withFetch((call) => {
			if (!isAuthorized(call)) return providerFailure(call);
			return response(firecrawlSearchBody);
		}, async (calls) => {
			await tool.execute("fire-cost-a", { query: "查询", provider: "firecrawl", maxResults: 11 });
			await tool.execute("fire-cost-b", { query: "查询", provider: "firecrawl", maxResults: 11 });
			assert.equal(lookups, 1);
			assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 2);
			const remaining = manager.reserve({ backend: "firecrawl", channel: "key", credential: fakeKey("firecrawl"), allowBillable: true, operation: "search", maxResults: 1 });
			assert.equal(remaining.status, "denied");
			assert.equal(remaining.reason, "insufficient_credits");
		});
	});
});

test("每次网络重试都重新预留并结算额度", async () => {
	const manager = createQuotaManager({ lookup: async () => ({ state: "known", remaining: 3, eligibility: "not_verified" }) });
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_RETRIES: "1", TAVILY_API_KEY: fakeKey("tavily") }, async () => {
		let keyedSearches = 0;
		await withFetch((call) => {
			if (!isAuthorized(call)) return providerFailure(call);
			keyedSearches++;
			return keyedSearches === 1 ? response("retry", 503) : response(tavilySearchBody);
		}, async () => {
			await tool.execute("retry-reserve", { query: "查询", provider: "tavily" });
			assert.equal(keyedSearches, 2);
			const next = manager.reserve({ backend: "tavily", channel: "key", credential: fakeKey("tavily"), allowBillable: true, operation: "search", maxResults: 1 });
			assert.equal(next.status, "reserved");
			assert.equal(next.availableBefore, 1);
			next.reservation.release();
		});
	});
});

test("正文超限、超时及取消都保守消耗已 dispatch 的预留", async () => {
	const token = fakeKey("tavily");
	for (const mode of ["oversize", "timeout", "cancel"]) {
		const manager = await preflightManager("tavily", token, 1);
		const tool = setup({ quotaManager: manager });
		await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_TIMEOUT_MS: "100", PI_WEB_SEARCH_MAX_RESPONSE_BYTES: mode === "oversize" ? "10" : undefined, TAVILY_API_KEY: token }, async () => {
			await withFetch((call) => {
				if (!isAuthorized(call)) return providerFailure(call);
				if (mode === "oversize") return response("x".repeat(100));
				return new Promise(() => {});
			}, async (calls) => {
				if (mode === "cancel") {
					const controller = new AbortController();
					const pending = tool.execute(`dispatch-${mode}`, { query: "查询", provider: "tavily" }, controller.signal);
					setTimeout(() => controller.abort(), 15);
					await assert.rejects(pending, { name: "AbortError" });
				} else if (mode === "timeout") {
					await assert.rejects(tool.execute(`dispatch-${mode}`, { query: "查询", provider: "tavily" }), /timed out/u);
				} else {
					await assert.rejects(tool.execute(`dispatch-${mode}`, { query: "查询", provider: "tavily" }), /response_too_large/u);
				}
				assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 1);
				const next = manager.reserve({ backend: "tavily", channel: "key", credential: token, allowBillable: true, operation: "search", maxResults: 1 });
				assert.equal(next.status, "denied");
				assert.equal(next.reason, "insufficient_credits");
			});
		});
	}
});

test("429 立即冷却且不在同一 Key 通道重试；HTTP 日期 Retry-After 生效", async () => {
	const token = fakeKey("tavily");
	const manager = await preflightManager("tavily", token, 5);
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_RETRIES: "2", TAVILY_API_KEY: token }, async () => {
		let keyedSearches = 0;
		const retryAt = new Date(Date.now() + 60_000).toUTCString();
		await withFetch((call) => {
			if (!isAuthorized(call)) return providerFailure(call);
			keyedSearches++;
			return response("", 429, { "retry-after": retryAt });
		}, async (calls) => {
			await assert.rejects(tool.execute("rate-date", { query: "查询", provider: "tavily" }), /rate_limited/u);
			assert.equal(keyedSearches, 1);
			const cooldown = manager.getCooldown("tavily", "key", token);
			assert.equal(cooldown.reason, "rate_limited");
			assert.ok(cooldown.remainingMs > 40_000 && cooldown.remainingMs <= 60_000);
			assert.equal(calls.filter((call) => call.init.method === "GET").length, 0);
		});
	});
});

test("显式零冷却覆盖允许下一次重新请求；额度耗尽采用较长探测阶梯", async () => {
	const manager = createQuotaManager();
	await manager.initialize();
	let now = Date.now();
	const ladder = createQuotaManager({ clock: () => now });
	await ladder.initialize();
	const rateOne = ladder.recordFailure("exa", "anonymous", "rate_limited");
	assert.equal(rateOne.remainingMs, 60_000);
	const rateTwo = ladder.recordFailure("exa", "anonymous", "rate_limited");
	assert.equal(rateTwo.remainingMs, 120_000);
	ladder.recordSuccess("exa", "anonymous");
	const quotaOne = ladder.recordFailure("firecrawl", "key", "quota_exhausted", { credential: fakeKey("firecrawl") });
	assert.equal(quotaOne.remainingMs, 1_800_000);
	assert.equal(quotaOne.nextProbeAt, now + 1_800_000);

	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0" }, async () => {
		let requests = 0;
		await withFetch(() => (requests++, response("", 429)), async () => {
			for (let index = 0; index < 2; index++) await assert.rejects(tool.execute(`zero-cooldown-${index}`, { query: "查询", provider: "exa" }));
			assert.equal(requests, 2);
		});
	});
});

test("显式零冷却允许绕过已有匿名和密钥冷却，余额预检与预留仍生效", async () => {
	for (const backend of ["exa", "tavily"]) {
		const token = fakeKey(backend);
		const manager = await preflightManager(backend, token, 3);
		const channel = backend === "exa" ? "anonymous" : "key";
		manager.recordFailure(backend, channel, "rate_limited", channel === "key" ? { credential: token } : {});
		assert.ok(manager.getCooldown(backend, channel, channel === "key" ? token : undefined));
		const tool = setup({ quotaManager: manager });
		await withEnv({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0", PI_WEB_SEARCH_ALLOW_BILLABLE: "true", [KEY_ENVS[backend]]: token }, async () => {
			await withFetch((call) => {
				if (backend === "exa") return response(mcpBody());
				return isAuthorized(call) ? response(tavilySearchBody) : providerFailure(call);
			}, async (calls) => {
				const result = await tool.execute(`existing-cooldown-${backend}`, { query: "查询", provider: backend });
				assert.equal(result.details.channel, backend === "exa" ? "free" : "key");
				assert.equal(calls.length, backend === "exa" ? 1 : 2);
				assert.equal(manager.getCooldown(backend, channel, channel === "key" ? token : undefined), undefined);
			});
		});
	}
});

test("管理器默认零冷却不覆盖调用级正数配置", async () => {
	const manager = createQuotaManager({ cooldownMs: 0, clock: () => Date.UTC(2030, 0, 1) });
	await manager.initialize();
	manager.recordFailure("exa", "anonymous", "rate_limited", { cooldownMs: 30_000 });
	assert.equal(manager.getCooldown("exa", "anonymous"), undefined);
	assert.equal(manager.getCooldown("exa", "anonymous", undefined, 30_000).remainingMs, 30_000);
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_FREE_COOLDOWN_MS: "30000" }, async () => {
		await withFetch(() => assert.fail("调用级正数覆盖必须跳过已冷却通道"), async () => {
			await assert.rejects(tool.execute("positive-override", { query: "查询", provider: "exa" }), /quota_preflight/u);
		});
	});
});

test("单次 Firecrawl 费用高于正余额，不阻断后续较便宜的搜索", async () => {
	const token = fakeKey("firecrawl");
	const manager = await preflightManager("firecrawl", token, 3);
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", FIRECRAWL_API_KEY: token }, async () => {
		await withFetch((call) => isAuthorized(call) ? response(firecrawlSearchBody) : providerFailure(call), async (calls) => {
			await assert.rejects(tool.execute("expensive-request", { query: "查询", provider: "firecrawl", maxResults: 11 }), /quota_preflight/u);
			assert.equal(calls.filter(isAuthorized).length, 0);
			assert.equal(manager.getCooldown("firecrawl", "key", token), undefined);
			const result = await tool.execute("cheaper-request", { query: "查询", provider: "firecrawl", maxResults: 1 });
			assert.equal(result.details.channel, "key");
			assert.equal(calls.filter(isAuthorized).length, 1);
		});
	});
});

test("密钥轮换隔离冷却 scope，公开快照不泄漏 Key 或 HMAC scope", async () => {
	const manager = createQuotaManager();
	await manager.initialize();
	manager.recordFailure("tavily", "key", "rate_limited", { credential: "FAKE_OLD_KEY" });
	assert.equal(manager.getCooldown("tavily", "key", "FAKE_NEW_KEY"), undefined);
	assert.equal(manager.getCooldown("tavily", "key", "FAKE_OLD_KEY").reason, "rate_limited");
	assert.doesNotMatch(JSON.stringify(manager.snapshot()), /FAKE_OLD_KEY|FAKE_NEW_KEY|[a-f0-9]{64}/u);
});

test("Pi 重启共享临时私有存储后直接跳过已冷却 Key，不展示 HMAC 标识", async () => {
	await mkdir(PRIVATE_TEST_ROOT, { recursive: true, mode: 0o700 });
	const directory = await mkdtemp(join(PRIVATE_TEST_ROOT, "quota-routing-private-"));
	{
		const token = fakeKey("tavily");
		const previous = createQuotaManager({ stateStore: createPrivateQuotaStateStore(directory) });
		await previous.initialize();
		previous.recordFailure("tavily", "key", "rate_limited", { credential: token, retryAfterMs: 60_000 });
		assert.equal((await previous.flush()).status, "persisted");

		const restored = createQuotaManager({ stateStore: createPrivateQuotaStateStore(directory) });
		const tool = setup({ quotaManager: restored });
		await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", TAVILY_API_KEY: token }, async () => {
			await withFetch((call) => providerFailure(call), async (calls) => {
				await assert.rejects(tool.execute("restart-cooldown", { query: "查询", provider: "tavily" }), /quota_preflight/u);
				assert.equal(calls.filter((call) => call.init.method === "GET").length, 0);
				assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 0);
				assert.doesNotMatch(JSON.stringify(restored.snapshot()), new RegExp(`${token}|[a-f0-9]{64}`, "u"));
			});
		});
	}
});

test("额度 API 仍受默认 5 MiB 正文上限约束", async () => {
	const tool = setup();
	const token = fakeKey("tavily");
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", TAVILY_API_KEY: token }, async () => {
		await withFetch((call) => {
			if (call.init.method === "GET") return response("x".repeat(5 * 1024 * 1024 + 1));
			return providerFailure(call);
		}, async (calls) => {
			await assert.rejects(tool.execute("usage-body-limit", { query: "查询", provider: "tavily" }), /quota_preflight/u);
			assert.equal(calls.filter((call) => call.init.method === "GET").length, 1);
			assert.equal(calls.filter((call) => call.init.method === "POST" && isAuthorized(call)).length, 0);
		});
	});
});

test("key-first 与显式计费授权冲突时在读取任何 Key 前报错", async () => {
	const reads = [];
	const tool = setup({ store: createStore({}, reads) });
	await withEnv({ PI_WEB_SEARCH_ROUTING: "key-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true", EXA_API_KEY: fakeKey("exa") }, async (envReads) => {
		await withFetch(() => assert.fail("冲突配置不得请求网络"), async () => {
			await assert.rejects(tool.execute("routing-conflict", { query: "查询" }), /free-first/u);
			assert.deepEqual(reads, []);
			assert.equal(envReads.EXA_API_KEY, 0);
		});
	});
});

test("HTTP 402 计为额度耗尽并使用较长冷却，不重试该通道", async () => {
	const now = Date.UTC(2030, 0, 1);
	const token = fakeKey("tavily");
	const manager = await preflightManager("tavily", token, 3, { clock: () => now });
	const tool = setup({ quotaManager: manager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_RETRIES: "2", TAVILY_API_KEY: token }, async () => {
		let keyedSearches = 0;
		await withFetch((call) => {
			if (!isAuthorized(call)) return providerFailure(call);
			keyedSearches++;
			return response(JSON.stringify({ message: "insufficient credits" }), 402);
		}, async () => {
			await assert.rejects(tool.execute("quota-402", { query: "查询", provider: "tavily" }), /quota_exhausted/u);
			assert.equal(keyedSearches, 1);
			const cooldown = manager.getCooldown("tavily", "key", token);
			assert.equal(cooldown.reason, "quota_exhausted");
			assert.equal(cooldown.remainingMs, 1_800_000);
			assert.equal(cooldown.nextProbeAt, now + 1_800_000);
			assert.equal(cooldown.nextProbeAt, cooldown.until);
		});
	});
});

test("每次执行的正文限制传入额度查询；超时初始化等待可被取消", async () => {
	let configuredLimit;
	const balanceManager = createQuotaManager({ lookup: async (_input, options) => {
		configuredLimit = options.maxResponseBytes;
		return { state: "known", remaining: 2, eligibility: "not_verified" };
	} });
	const token = fakeKey("tavily");
	const tool = setup({ quotaManager: balanceManager });
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "1234", TAVILY_API_KEY: token }, async () => {
		await withFetch((call) => !isAuthorized(call) ? providerFailure(call) : response(tavilySearchBody), async () => {
			await tool.execute("per-call-limit", { query: "查询", provider: "tavily" });
			assert.equal(configuredLimit, 1234);
		});
	});

	let rejectLoad;
	const pendingLoad = new Promise((_resolve, reject) => { rejectLoad = reject; });
	const stuckManager = createQuotaManager({ stateStore: {
		kind: "memory",
		load: () => pendingLoad,
		save: async () => ({ status: "memory_only" }),
	} });
	const stalledTool = setup({ quotaManager: stuckManager });
	await withEnv({}, async () => {
		const controller = new AbortController();
		const pending = stalledTool.execute("cancel-initialize", { query: "查询" }, controller.signal);
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		rejectLoad(new Error("late fake state failure"));
		await new Promise((resolve) => setImmediate(resolve));
	});
});

test("持久化失败会显示安全警告，不回显存储诊断原文", async () => {
	const manager = createQuotaManager({ stateStore: {
		kind: "private",
		load: async () => ({ status: "missing" }),
		save: async () => ({ status: "unavailable", reason: "FAKE_PRIVATE_PATH_SECRET" }),
	} });
	const tool = setup({ quotaManager: manager });
	await withEnv({}, async () => {
		await withFetch((call) => call.url.includes("mcp.exa.ai") ? response(mcpBody()) : assert.fail(`意外请求 ${call.url}`), async () => {
			const result = await tool.execute("persistence-warning", { query: "查询", provider: "exa" });
			assert.equal(result.details.quotaPersistence, "degraded");
			assert.match(result.details.quotaWarning, /QUOTA_STATE_IO_UNAVAILABLE/u);
			assert.doesNotMatch(JSON.stringify(result.details), /FAKE_PRIVATE_PATH_SECRET/u);
		});
	});
});

test("数字 Retry-After 原样驱动短期冷却", async () => {
	const manager = createQuotaManager({ clock: () => Date.UTC(2030, 0, 1) });
	const tool = setup({ quotaManager: manager });
	await withEnv({}, async () => {
		let requests = 0;
		await withFetch(() => (requests++, response("", 429, { "retry-after": "45" })), async () => {
			await assert.rejects(tool.execute("rate-seconds", { query: "查询", provider: "exa" }), /rate_limited/u);
			assert.equal(requests, 1);
			assert.equal(manager.getCooldown("exa", "anonymous").remainingMs, 45_000);
		});
	});
});
