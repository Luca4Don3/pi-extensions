/** 四匿名通道与计费授权集成验收；所有响应、密钥与密钥库均为模拟实现。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const { createChannelHealth } = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const { PROVIDER_IDS, PROVIDERS } = await jiti.import(fileURLToPath(new URL("../search/registry.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const KEY_NAMES = PROVIDER_IDS.map((provider) => PROVIDERS[provider].envVar);
const keyFor = (provider) => `FAKE_ROUTING_TEST_KEY_${provider}`;

function setup(health) {
	let tool;
	let reads = 0;
	plugin({ registerTool: (definition) => { tool = definition; }, registerCommand: () => {} }, {
		credentialStore: {
			kind: "none",
			read: async () => { reads++; throw new Error("匿名搜索不得读取密钥库"); },
			write: async () => ({ status: "unavailable", reason: "测试不写入" }),
			clear: async () => ({ status: "missing" }),
		},
		...(health ? { channelHealth: health } : {}),
	});
	return { tool, reads: () => reads };
}

/** 代理统计实际密钥读取；不给测试继承本机凭据或计费授权。 */
async function controlled(vars, fetcher, fn) {
	const originalEnv = process.env;
	const originalFetch = globalThis.fetch;
	let keyReads = 0;
	const calls = [];
	process.env = new Proxy({
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "1000",
		...Object.fromEntries(PROVIDER_IDS.map((provider) => [PROVIDERS[provider].envVar, keyFor(provider)])),
		...vars,
	}, {
		get(target, name) {
			if (KEY_NAMES.includes(name)) keyReads++;
			return target[name];
		},
	});
	globalThis.fetch = async (url, init) => {
		calls.push({ url: String(url), init });
		return fetcher(String(url), init, calls.length);
	};
	try {
		return await fn({ calls, keyReads: () => keyReads });
	} finally {
		process.env = originalEnv;
		globalThis.fetch = originalFetch;
	}
}

const hit = { url: "https://example.com/official", title: "技术文档", description: "官方说明", content: "官方说明" };
const fireResponse = (item = hit) => new Response(JSON.stringify({ success: true, data: { web: [item] } }));
const tavilyResponse = () => new Response(JSON.stringify({ results: [hit] }));
const mcpResponse = () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: 官方说明\nURL: https://example.com/official" }] } }));
const failed = () => new Response("upstream unavailable", { status: 503 });

function assertAnonymous(calls) {
	for (const { url, init } of calls) {
		assert.ok(!url.includes("exaApiKey="));
		assert.ok(!url.includes("api_key="));
		assert.ok(!Object.keys(init.headers).some((name) => /^(authorization|cookie|x-api-key)$/iu.test(name)));
	}
}

test("Exa 已知额度提示即使包含注册链接，也不能伪装成搜索来源", async () => {
	const health = createChannelHealth();
	const { tool } = setup(health);
	await controlled({}, () => new Response(JSON.stringify({ result: { content: [{ type: "text", text: "You've hit Exa's free MCP rate limit. Sign up at https://example.com/signup" }] } })), async ({ calls, keyReads }) => {
		await assert.rejects(tool.execute("quota-link", { query: "技术查询", provider: "exa" }), /quota_exhausted/u);
		assert.equal(calls.length, 1);
		assert.equal(keyReads(), 0);
		assert.equal(health.snapshot().channels[0].reason, "quota_exhausted");
	});
});

test("状态码成功但没有有效搜索来源时继续匿名回退，不返回服务提示", async () => {
	const health = createChannelHealth();
	const { tool, reads } = setup(health);
	await controlled({}, (url) => {
		if (url.includes("firecrawl.dev")) return fireResponse();
		if (url.includes("tavily.com")) return new Response(JSON.stringify({ results: [{ url: "data:text/plain,article" }] }));
		return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Service temporarily unavailable" }] } }));
	}, async ({ calls, keyReads }) => {
		const result = await tool.execute("empty-sources", { query: "技术查询" });
		assert.equal(result.details.provider, "firecrawl");
		assert.equal(result.details.attemptCount, 4);
		assert.equal(calls.length, 4);
		assertAnonymous(calls);
		assert.equal(reads(), 0);
		assert.equal(keyReads(), 0);
		assert.deepEqual(health.snapshot().channels, []);
	});
});

test("默认四匿名路由：有密钥也不读取环境密钥或密钥库，成功即停止", async () => {
	const { tool, reads } = setup();
	await controlled({}, (url) => url.includes("firecrawl.dev") ? fireResponse() : failed(), async ({ calls, keyReads }) => {
		const result = await tool.execute("default", { query: "官方技术文档", maxResults: 3 });
		assert.deepEqual(calls.map(({ url }) => new URL(url).hostname), ["search.parallel.ai", "mcp.exa.ai", "api.tavily.com", "api.firecrawl.dev"]);
		assertAnonymous(calls);
		assert.equal(calls[2].init.headers["X-Tavily-Access-Mode"], "keyless");
		assert.deepEqual(JSON.parse(calls[3].init.body), { query: "官方技术文档", limit: 3, sources: ["web"] });
		assert.equal(result.details.provider, "firecrawl");
		assert.equal(result.details.channel, "free");
		assert.equal(result.details.accessTier, "anonymous");
		assert.equal(result.details.attemptCount, 4);
		assert.equal(keyReads(), 0);
		assert.equal(reads(), 0);
	});
});

test("全部匿名失败时明确拒绝计费，不因五家已配置密钥而越权", async () => {
	const { tool, reads } = setup();
	await controlled({}, failed, async ({ calls, keyReads }) => {
		await assert.rejects(tool.execute("no-billing", { query: "技术查询" }), /可能计费通道未获授权，未尝试/u);
		assert.equal(calls.length, 4);
		assertAnonymous(calls);
		assert.equal(reads(), 0);
		assert.equal(keyReads(), 0);
	});
});

test("指定 Tavily 或 Firecrawl 只调用该服务的匿名通道", async () => {
	for (const provider of ["tavily", "firecrawl"]) {
		const { tool, reads } = setup();
		await controlled({}, () => provider === "tavily" ? tavilyResponse() : fireResponse(), async ({ calls, keyReads }) => {
			const result = await tool.execute("specified", { query: "技术查询", provider });
			assert.equal(calls.length, 1);
			assert.equal(result.details.provider, provider);
			assert.equal(result.details.accessTier, "anonymous");
			assertAnonymous(calls);
			assert.equal(reads(), 0);
			assert.equal(keyReads(), 0);
		});
	}
});

test("只有明确授权后，才在四匿名失败之后尝试已配置密钥", async () => {
	const { tool } = setup();
	await controlled({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, (url) => url.includes("exaApiKey=") ? mcpResponse() : failed(), async ({ calls, keyReads }) => {
		const result = await tool.execute("authorized", { query: "技术查询" });
		assert.equal(calls.length, 5);
		assertAnonymous(calls.slice(0, 4));
		assert.equal(new URL(calls[4].url).searchParams.get("exaApiKey"), keyFor("exa"));
		assert.equal(result.details.channel, "key");
		assert.equal(result.details.accessTier, "billable");
		assert.equal(keyReads(), 5);
	});
});

test("Tavily 匿名限流不影响其获授权的密钥通道，两个认证头互斥", async () => {
	const health = createChannelHealth();
	const { tool } = setup(health);
	await controlled({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, (_url, init) => init.headers.authorization ? tavilyResponse() : new Response("limit", { status: 429 }), async ({ calls }) => {
		const result = await tool.execute("tavily-key", { query: "技术查询", provider: "tavily" });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].init.headers["X-Tavily-Access-Mode"], "keyless");
		assert.equal(calls[0].init.headers.authorization, undefined);
		assert.equal(calls[1].init.headers["X-Tavily-Access-Mode"], undefined);
		assert.equal(calls[1].init.headers.authorization, `Bearer ${keyFor("tavily")}`);
		assert.equal(result.details.channel, "key");
		assert.equal(health.snapshot().channels[0].channel, "free");
	});
});

test("Firecrawl 429 遵守恢复时间，冷却中不发请求，到期成功后清状态", async () => {
	let now = 1000;
	const health = createChannelHealth({ clock: () => now });
	const { tool } = setup(health);
	await controlled({}, (_url, _init, count) => count === 1 ? new Response("limit", { status: 429, headers: { "retry-after": "60" } }) : fireResponse(), async ({ calls }) => {
		await assert.rejects(tool.execute("first", { query: "技术查询", provider: "firecrawl" }));
		assert.equal(health.getCooldown("firecrawl", "free").remainingMs, 60000);
		await assert.rejects(tool.execute("second", { query: "技术查询", provider: "firecrawl" }), /冷却/u);
		assert.equal(calls.length, 1);
		now += 60000;
		const result = await tool.execute("expired", { query: "技术查询", provider: "firecrawl" });
		assert.equal(result.details.accessTier, "anonymous");
		assert.equal(calls.length, 2);
		assert.deepEqual(health.snapshot().channels, []);
	});
});

test("计费开关冲突在读取密钥和发送请求之前报错", async () => {
	const { tool, reads } = setup();
	await controlled({ PI_WEB_SEARCH_ALLOW_BILLABLE: "false", PI_WEB_SEARCH_ALLOW_PAID: "true" }, failed, async ({ calls, keyReads }) => {
		await assert.rejects(tool.execute("conflict", { query: "技术查询" }), /配置冲突/u);
		assert.equal(calls.length, 0);
		assert.equal(keyReads(), 0);
		assert.equal(reads(), 0);
	});
});

test("Firecrawl 失败标记不作为结果；授权密钥结果中的回显在统一入口脱敏", async () => {
	const { tool } = setup();
	await controlled({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, (_url, init) => {
		if (!init.headers.authorization) return new Response(JSON.stringify({ success: false, data: { web: [hit] } }));
		return fireResponse({ ...hit, description: `说明 ${keyFor("firecrawl")}`, url: `https://example.com/${keyFor("firecrawl")}` });
	}, async ({ calls }) => {
		const result = await tool.execute("redaction", { query: "技术查询", provider: "firecrawl" });
		assert.equal(calls.length, 2);
		assert.equal(calls[0].init.headers.authorization, undefined);
		assert.equal(calls[1].init.headers.authorization, `Bearer ${keyFor("firecrawl")}`);
		assert.equal(result.details.accessTier, "billable");
		assert.ok(!JSON.stringify(result).includes(keyFor("firecrawl")));
	});
});
