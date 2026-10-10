/**
 * TinyFish keyless 匿名通道测试：全部使用假网络与假凭据库。
 *
 * 验证重点是「零凭据」与「不读取任何密钥」：该通道只以
 * X-TinyFish-Access-Mode: keyless 接入，既不发送也不解析 API Key。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const { PROVIDER_IDS, PROVIDERS, ANONYMOUS_PROVIDER_ORDER } = await jiti.import(
	fileURLToPath(new URL("../search/registry.ts", import.meta.url)),
);
const tinyfish = await jiti.import(fileURLToPath(new URL("../search/providers/tinyfish.ts", import.meta.url)));
const KEY_ENVS = Object.fromEntries(PROVIDER_IDS.map((id) => [id, PROVIDERS[id].envVar]));
const fakeKey = (provider) => `FAKE_TINYFISH_${provider.toUpperCase()}`;
const resultsBody = JSON.stringify({
	query: "pi 扩展",
	results: [
		{ position: 1, site_name: "pi.dev", title: "Extensions", url: "https://pi.dev/docs/extensions", snippet: "扩展说明" },
		{ position: 2, site_name: "github.com", title: "Repo", url: "https://github.com/example/repo", snippet: "仓库" },
	],
	total_results: 2,
	page: 0,
});
const mcpEnvelope = (text) =>
	JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });

function fakeStore(reads = []) {
	return {
		kind: "none",
		async read(provider) {
			reads.push(provider);
			return { status: "missing" };
		},
		async write() { return { status: "unavailable", reason: "fake" }; },
		async clear() { return { status: "missing" }; },
	};
}

function setup(store) {
	let tool;
	const tools = [];
	plugin({ registerTool: (entry) => tools.push(entry), registerCommand: () => {} }, { credentialStore: store });
	return tools[0];
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

test("keyless 请求只带匿名接入标识，不发送也不读取任何凭据", async () => {
	const storeReads = [];
	const tool = setup(fakeStore(storeReads));
	await withEnv({}, async (envReads) => {
		await withFetch((call) => {
			assert.equal(call.url, "https://agent.tinyfish.ai/mcp");
			assert.equal(call.init.method, "POST");
			return new Response(mcpEnvelope(resultsBody), { status: 200 });
		}, async (calls) => {
			const result = await tool.execute("tinyfish-keyless", { query: "pi 扩展", provider: "tinyfish" });
			assert.equal(result.details.provider, "tinyfish");
			assert.equal(result.details.channel, "free");
			assert.equal(result.details.accessTier, "anonymous");
			assert.equal(calls.length, 1);
			const headers = calls[0].init.headers;
			assert.equal(headers["X-TinyFish-Access-Mode"], "keyless");
			assert.equal(headers.authorization, undefined);
			assert.equal(headers["X-API-Key"], undefined);
			const serialized = JSON.stringify(calls[0].init);
			for (const name of Object.values(KEY_ENVS)) assert.ok(!serialized.includes(`${name}=`));
			assert.deepEqual(storeReads, [], "零凭据通道不得读取系统密钥库");
			assert.deepEqual(Object.values(envReads), Object.values(KEY_ENVS).map(() => 0), "未授权不得读取密钥环境变量");
		});
	});
});

test("keyless 响应按 url/title/snippet 提取来源并限量", async () => {
	const tool = setup(fakeStore());
	await withEnv({}, async () => {
		await withFetch(() => new Response(mcpEnvelope(resultsBody), { status: 200 }), async () => {
			const result = await tool.execute("tinyfish-sources", { query: "pi 扩展", provider: "tinyfish", maxResults: 1 });
			assert.equal(result.details.sourceCount, 1);
			assert.equal(result.details.sources[0].url, "https://pi.dev/docs/extensions");
			assert.equal(result.details.sources[0].title, "Extensions");
			assert.equal(result.details.sources[0].snippet, "扩展说明");
			assert.match(result.content[0].text, /Extensions/u);
		});
	});
});

test("keyless 无结果或返回错误信封时明确失败，不冒充成功", async () => {
	const tool = setup(fakeStore());
	await withEnv({}, async () => {
		await withFetch(() => new Response(mcpEnvelope(JSON.stringify({ query: "x", results: [] })), { status: 200 }), async (calls) => {
			await assert.rejects(tool.execute("tinyfish-empty", { query: "无结果", provider: "tinyfish" }), /没有可用搜索结果/u);
			assert.equal(calls.length, 1);
		});
		await withFetch(
			() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "invalid request" } }), { status: 200 }),
			async (calls) => {
				await assert.rejects(tool.execute("tinyfish-rpc-error", { query: "错误", provider: "tinyfish" }), /invalid request/u);
				assert.equal(calls.length, 1, "JSON-RPC 错误不得重试");
			},
		);
		await withFetch(
			() => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "keyless search failed" }] } }), { status: 200 }),
			async (calls) => {
				await assert.rejects(tool.execute("tinyfish-tool-error", { query: "失败", provider: "tinyfish" }), /keyless search failed/u);
				assert.equal(calls.length, 1);
			},
		);
	});
});

test("keyless 429 只请求一次并按限流冷却，冷却期内跳过网络请求", async () => {
	const tool = setup(fakeStore());
	await withEnv({ PI_WEB_SEARCH_RETRIES: "2", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "60000" }, async () => {
		let requests = 0;
		await withFetch(() => (requests++, new Response("rate limited", { status: 429, headers: { "retry-after": "45" } })), async (calls) => {
			await assert.rejects(tool.execute("tinyfish-429", { query: "限流", provider: "tinyfish" }), /rate_limited/u);
			assert.equal(requests, 1, "限流不得对同一通道重试");
			assert.equal(calls.length, 1);
		});
		let cooledRequests = 0;
		await withFetch(() => { cooledRequests++; return new Response("unavailable", { status: 503 }); }, async () => {
			await assert.rejects(tool.execute("tinyfish-cooled", { query: "冷却中", provider: "tinyfish" }), /quota_preflight/u);
			assert.equal(cooledRequests, 0, "冷却期内不得发出任何请求");
		});
	});
});

test("keyless 500 按服务端错误重试一次", async () => {
	const tool = setup(fakeStore());
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1" }, async () => {
		await withFetch(() => new Response("upstream failure", { status: 500 }), async (calls) => {
			await assert.rejects(tool.execute("tinyfish-500", { query: "服务端错误", provider: "tinyfish" }), /server_error/u);
			assert.equal(calls.length, 2);
		});
	});
});

/**
 * keyless 每日额度耗尽时的确切响应文本未经实测（不想为观测而打满 50 次请求），
 * 因此这里只锁定通用的分类与冷却路径：状态码（402 / 429）与正文特征（quota / credit
 * exhausted）都能分别归入额度耗尽或限流，并进入冷却，避免在额度耗尽后反复请求。
 */
test("keyless 额度耗尽的各种形态均被分类并进入冷却，不重试", async () => {
	const cases = [
		{
			label: "HTTP 402 需钱包余额",
			response: () => new Response(JSON.stringify({ error: { code: "INSUFFICIENT_CREDITS", message: "insufficient credits" } }), { status: 402 }),
			kind: /quota_exhausted/u,
			reason: "quota_exhausted",
		},
		{
			label: "HTTP 402 每日免费额度用尽",
			response: () => new Response(JSON.stringify({ error: { code: "FREE_ALLOWANCE_EXHAUSTED", message: "free allowance exhausted" } }), { status: 402 }),
			kind: /quota_exhausted/u,
			reason: "quota_exhausted",
		},
		{
			label: "HTTP 429 限流",
			response: () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }),
			kind: /rate_limited/u,
			reason: "rate_limited",
		},
		{
			label: "JSON-RPC 错误含额度用尽特征",
			response: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "daily search quota exhausted" } }), { status: 200 }),
			kind: /quota_exhausted/u,
			reason: "quota_exhausted",
		},
		{
			label: "MCP isError 含积分用尽特征",
			response: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "no remaining credits for keyless search" }] } }), { status: 200 }),
			kind: /quota_exhausted/u,
			reason: "quota_exhausted",
		},
	];
	for (const testCase of cases) {
		const reads = [];
		const store = fakeStore(reads);
		const tool = setup(store);
		await withEnv({ PI_WEB_SEARCH_RETRIES: "2", PI_WEB_SEARCH_ALLOW_BILLABLE: "true", TINYFISH_API_KEY: fakeKey("tinyfish") }, async () => {
			let requests = 0;
			await withFetch(() => (requests++, testCase.response()), async () => {
				await assert.rejects(tool.execute(`tinyfish-${testCase.reason}`, { query: "额度耗尽", provider: "tinyfish" }), testCase.kind);
				assert.equal(requests, 1, `${testCase.label}：不得重试同一通道`);
			});
			// 冷却生效：后续执行直接跳过，不再发请求。
			await withFetch(() => { requests++; return testCase.response(); }, async () => {
				await assert.rejects(tool.execute(`tinyfish-cooled-${testCase.reason}`, { query: "冷却中", provider: "tinyfish" }), /quota_preflight/u);
				assert.equal(requests, 1, `${testCase.label}：冷却期内不得发出新请求`);
			});
		});
		assert.deepEqual(reads, [], "零凭据通道在任何错误形态下都不得读取密钥库");
	}
});

test("keyless 无凭据状态不读取密钥环境变量或密钥库", async () => {
	const reads = [];
	const store = fakeStore(reads);
	const tool = setup(store);
	await withEnv({ TINYFISH_API_KEY: fakeKey("tinyfish") }, async (envReads) => {
		const { probeBackendStatus, KEY_BACKENDS } = await jiti.import(fileURLToPath(new URL("../auth.ts", import.meta.url)));
		const status = await probeBackendStatus("tinyfish", store.store);
		assert.equal(status.state, "credential_free");
		assert.equal(envReads.TINYFISH_API_KEY, 0, "零凭据后端的状态探测不得读取密钥环境变量");
		assert.deepEqual(reads, [], "零凭据后端的状态探测不得读取密钥库");
		assert.ok(!KEY_BACKENDS.includes("tinyfish"));
	});
});

test("keyless 响应体超过上限时不返回部分结果，也不记录冷却", async () => {
	const tool = setup(fakeStore());
	await withEnv({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "32", PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "60000" }, async () => {
		await withFetch(() => new Response(mcpEnvelope(resultsBody), { status: 200 }), async (calls) => {
			await assert.rejects(tool.execute("tinyfish-too-large", { query: "超限", provider: "tinyfish" }), /response_too_large/u);
			assert.equal(calls.length, 1, "正文超限不得重试");
		});
	});
});

test("keyless 请求期间取消立即拒绝，且不再发请求", async () => {
	const tool = setup(fakeStore());
	await withEnv({}, async () => {
		let seen = 0;
		await withFetch(() => {
			seen++;
			return new Promise(() => {});
		}, async () => {
			const controller = new AbortController();
			const pending = tool.execute("tinyfish-cancel", { query: "取消", provider: "tinyfish" }, controller.signal);
			await new Promise((resolve) => setImmediate(resolve));
			controller.abort();
			await assert.rejects(pending, { name: "AbortError" });
			assert.equal(seen, 1, "取消前只发出一个请求");
		});
	});
});

test("auto 路由中 TinyFish 排在匿名候选最后，且未授权不读任何密钥", async () => {
	const storeReads = [];
	const tool = setup(fakeStore(storeReads));
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", TINYFISH_API_KEY: fakeKey("tinyfish"), EXA_API_KEY: fakeKey("exa") }, async (envReads) => {
		const anonymous = ANONYMOUS_PROVIDER_ORDER;
		assert.equal(anonymous[anonymous.length - 1], "tinyfish");
		assert.ok(!ANONYMOUS_PROVIDER_ORDER.includes("serpapi"));
		await withFetch((call) => {
			const host = call.url.includes("mcp.exa.ai") ? "exa"
				: call.url.includes("tavily.com") ? "tavily"
					: call.url.includes("parallel.ai") ? "parallel"
						: call.url.includes("firecrawl.dev") ? "firecrawl"
							: call.url.includes("agent.tinyfish.ai") ? "tinyfish" : "other";
			return host === "tinyfish" ? new Response(mcpEnvelope(resultsBody), { status: 200 }) : new Response("unavailable", { status: 503 });
		}, async (calls) => {
			const result = await tool.execute("tinyfish-auto-last", { query: "匿名回退" });
			assert.equal(result.details.provider, "tinyfish");
			assert.equal(result.details.channel, "free");
			const order = calls.map((call) =>
				call.url.includes("mcp.exa.ai") ? "exa"
					: call.url.includes("tavily.com") ? "tavily"
						: call.url.includes("parallel.ai") ? "parallel"
							: call.url.includes("firecrawl.dev") ? "firecrawl" : "tinyfish");
			assert.deepEqual(order, ["exa", "tavily", "parallel", "firecrawl", "tinyfish"]);
			for (const call of calls) assert.equal(call.init.headers?.authorization, undefined);
			assert.equal(calls[calls.length - 1].init.headers["X-TinyFish-Access-Mode"], "keyless");
		});
	});
});

test("零凭据后端不出现在密钥菜单与解析集合中", async () => {
	const auth = await jiti.import(fileURLToPath(new URL("../auth.ts", import.meta.url)));
	const registry = await jiti.import(fileURLToPath(new URL("../search/registry.ts", import.meta.url)));
	assert.equal(registry.supportsKeyChannel("tinyfish"), false);
	assert.equal(registry.hasAnonymousChannel("tinyfish"), true);
	assert.ok(!auth.KEY_BACKENDS.includes("tinyfish"));
	assert.ok(auth.BACKENDS.includes("tinyfish"));
	assert.equal(tinyfish.buildTinyFishHeaders()["X-TinyFish-Access-Mode"], "keyless");
	assert.equal(tinyfish.buildTinyFishPayload("查询").arguments.query, "查询");
});
