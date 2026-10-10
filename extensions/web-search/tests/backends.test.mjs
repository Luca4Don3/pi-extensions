/**
 * Tavily / SerpApi 离线测试：fake fetch 与 fake 密钥库，不访问网络和真实系统密钥库。
 *
 * 运行：node --test tests/backends.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const apiModule = await jiti.import(fileURLToPath(new URL("../search-api.ts", import.meta.url)));

/** 测试用超敏感 key：任何对外输出都不能包含它。 */
const TAVILY_KEY = "tvly-test-SECRET-0123456789";
const SERP_KEY = "serp+test/SECRET=987";
const KEY_ENV = ["EXA_API_KEY", "PARALLEL_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "SERPAPI_API_KEY"];

/** 注入内存密钥库，并记录每个后端被读取的次数。 */
function fakeStore(values = {}) {
	const reads = { exa: 0, parallel: 0, tavily: 0, firecrawl: 0, serpapi: 0 };
	return {
		reads,
		store: {
			kind: "keychain",
			read: async (backend) => {
				reads[backend] += 1;
				return values[backend] === undefined ? { status: "missing" } : { status: "found", value: values[backend] };
			},
			clear: async () => ({ status: "missing" }),
		},
	};
}

/** 注册扩展，返回 web_search 工具。 */
function setup(store) {
	const tools = [];
	plugin({ registerTool: (tool) => tools.push(tool), registerCommand: () => undefined }, { credentialStore: store });
	return tools[0];
}

/** 注入环境变量，结束后恢复；默认清空五个 key 和计费授权。 */
async function withEnv(vars, fn) {
	const saved = {};
	const merged = {
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_TIMEOUT_MS: "25000",
		PI_WEB_SEARCH_MAX_RESPONSE_BYTES: undefined,
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_ALLOW_BILLABLE: undefined,
		PI_WEB_SEARCH_ALLOW_PAID: undefined,
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		...Object.fromEntries(KEY_ENV.map((key) => [key, undefined])),
		...vars,
	};
	for (const key of Object.keys(merged)) saved[key] = process.env[key];
	for (const [key, value] of Object.entries(merged)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = String(value);
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** 替换 fetch；calls 仅记录搜索请求，额度 GET 单独存入 calls.usageCalls。 */
async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	const calls = [];
	const usageCalls = [];
	calls.usageCalls = usageCalls;
	globalThis.fetch = (url, init) => {
		const address = String(url);
		if (init?.method === "GET" && (address === "https://api.tavily.com/usage" || address === "https://api.firecrawl.dev/v2/team/credit-usage")) {
			usageCalls.push({ url: address, init });
			const body = address === "https://api.tavily.com/usage"
				? { key: { usage: 0, limit: 1000 }, account: { plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }
				: { success: true, data: { remainingCredits: 1000 } };
			return Promise.resolve(json(body));
		}
		calls.push({ url: address, init });
		return impl(address, init, calls.length);
	};
	try {
		return await fn(calls);
	} finally {
		globalThis.fetch = original;
	}
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tavilyOk = (results) => json({ results });
const serpOk = (organic_results) => json({ search_metadata: { status: "Success" }, organic_results });

// 1. Tavily 请求契约：POST、Bearer 头、basic 且关闭自动升档。
test("tavily: POST + Bearer 头 + basic 固定 1 积分", async () => {
	const { store } = fakeStore({ tavily: TAVILY_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_ROUTING: "free-first" }, () =>
		withFetch(
			(_url, init) => init.headers.authorization
				? tavilyOk([{ url: "https://example.com/a", title: "A", content: "内容", published_date: "2026-01-01" }])
				: new Response("anonymous unavailable", { status: 503 }),
			async (calls) => {
				await tool.execute("b1", { query: "hello", provider: "tavily", maxResults: 3 }, undefined, undefined, {});
				assert.equal(calls.length, 2);
				assert.equal(calls[1].url, "https://api.tavily.com/search");
				assert.equal(calls[1].init.method, "POST");
				assert.equal(calls[1].init.headers.authorization, `Bearer ${TAVILY_KEY}`);
				const body = JSON.parse(calls[1].init.body);
				assert.equal(body.search_depth, "basic");
				assert.equal(body.auto_parameters, false);
				assert.equal(body.max_results, 3);
				assert.ok(!calls[0].url.includes(TAVILY_KEY), "Tavily key 不能进入 URL");
			},
		),
	);
});

// 2. SerpApi 请求契约：GET，key 只进查询参数，参数用 URLSearchParams 编码。
test("serpapi: GET + key 仅作为查询参数并正确编码", async () => {
	const { store } = fakeStore({ serpapi: SERP_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true", PI_WEB_SEARCH_ROUTING: "free-first" }, () =>
		withFetch(
			() => serpOk([{ link: "https://example.com/s", title: "S", snippet: "摘要" }]),
			async (calls) => {
				await tool.execute("b2", { query: "a&b=c", provider: "serpapi" }, undefined, undefined, {});
				const url = new URL(calls[0].url);
				assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
				assert.equal(calls[0].init.method, "GET");
				assert.equal(url.searchParams.get("api_key"), SERP_KEY);
				assert.equal(url.searchParams.get("q"), "a&b=c");
				assert.equal(url.searchParams.get("engine"), "google");
				assert.equal(calls[0].init.headers.authorization, undefined, "SerpApi 不使用 Authorization 头");
			},
		),
	);
});

// 3. 解析只保留公开字段，并按 maxResults 截断。
test("解析：Tavily 只取公开字段并限制条数", () => {
	const body = JSON.stringify({
		query: "x",
		api_key: TAVILY_KEY,
		results: [
			{ url: "https://a.example/1", title: "1", content: "c1", score: 0.9, raw_content: "RAW" },
			{ url: "https://a.example/2", title: "2", content: "c2" },
			{ url: "https://a.example/3", title: "3", content: "c3" },
		],
	});
	const sources = apiModule.parseApiResponse("tavily", body, 2);
	assert.equal(sources.length, 2);
	assert.deepEqual(Object.keys(sources[0]).sort(), ["snippet", "title", "url"]);
	assert.ok(!JSON.stringify(sources).includes("RAW"));
});

test("解析：SerpApi 只取 organic_results 公开字段", () => {
	const body = JSON.stringify({
		search_parameters: { q: "x", api_key: SERP_KEY },
		search_metadata: { status: "Success", json_endpoint: "https://serpapi.com/searches/x.json" },
		organic_results: [{ link: "https://b.example/1", title: "B", snippet: "S", date: "2026-02-01", position: 1 }],
	});
	const sources = apiModule.parseApiResponse("serpapi", body, 5);
	assert.deepEqual(sources, [{ url: "https://b.example/1", title: "B", snippet: "S", publishedAt: "2026-02-01" }]);
	assert.ok(!JSON.stringify(sources).includes(SERP_KEY));
});

// 4. 链接协议只允许 http / https。
test("解析：拒绝 javascript / data / file 等非网页链接", () => {
	const sources = apiModule.parseApiResponse(
		"tavily",
		JSON.stringify({
			results: [
				{ url: "javascript:alert(1)", title: "x", content: "x" },
				{ url: "data:text/html,hi", title: "y", content: "y" },
				{ url: "file:///etc/passwd", title: "z", content: "z" },
				{ url: "https://ok.example/", title: "ok", content: "ok" },
			],
		}),
		10,
	);
	assert.deepEqual(sources.map((source) => source.url), ["https://ok.example/"]);
});

// 5. HTTP 200 内的错误与无结果都必须显式失败。
test("解析：SerpApi HTTP 200 错误与空结果均失败", () => {
	assert.throws(() => apiModule.parseApiResponse("serpapi", JSON.stringify({ error: "Invalid API key" }), 3), /Invalid API key/);
	assert.throws(
		() => apiModule.parseApiResponse("serpapi", JSON.stringify({ search_metadata: { status: "Error" }, organic_results: [] }), 3),
		/状态为 Error/,
	);
	assert.throws(() => apiModule.parseApiResponse("serpapi", JSON.stringify({ organic_results: [] }), 3), /没有可用搜索结果/);
	assert.throws(() => apiModule.parseApiResponse("tavily", "not json", 3), /非法 JSON/);
});

// 6. 额度与限流分类：Tavily 432 / 433、SerpApi 429 额度与普通限流。
test("额度：Tavily 432 不重试并判为 quota_exhausted", async () => {
	const { store } = fakeStore({ tavily: TAVILY_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_RETRIES: "2", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(_url, init) => init.headers.authorization
				? json({ detail: { error: "This request exceeds your plan's set usage limit. Please upgrade your plan." } }, 432)
				: new Response("anonymous rate limited", { status: 429 }),
			async (calls) => {
				await assert.rejects(tool.execute("b6", { query: "q", provider: "tavily" }, undefined, undefined, {}), /432/);
				assert.equal(calls.length, 2, "匿名失败后只尝试一次授权通道，额度错误不重试");
				assert.equal(calls[0].init.headers.authorization, undefined);
				assert.equal(calls[1].init.headers.authorization, `Bearer ${TAVILY_KEY}`);
			},
		),
	);
});

test("额度：Tavily 433 同样判为额度耗尽", () => {
	assert.equal(apiModule.apiHttpKind("tavily", 433, "pay-as-you-go limit"), "quota_exhausted");
});

test("额度：SerpApi 429 额度耗尽和普通限流均不重试同一通道", async () => {
	const { store } = fakeStore({ serpapi: SERP_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_TIMEOUT_MS: "5000", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => json({ error: "Your account has run out of searches." }, 429),
			async (calls) => {
				await assert.rejects(tool.execute("b6b", { query: "q", provider: "serpapi" }, undefined, undefined, {}), /run out/);
				assert.equal(calls.length, 1);
			},
		),
	);
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_TIMEOUT_MS: "5000", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => new Response("slow down", { status: 429, headers: { "retry-after": "0" } }),
			async (calls) => {
				await assert.rejects(tool.execute("b6c", { query: "q", provider: "serpapi" }, undefined, undefined, {}), /429/u);
				assert.equal(calls.length, 1, "429 立即冷却，不得对同一通道重试");
			},
		),
	);
});

// 7. Tavily 无 key 仍可匿名；SerpApi 没有匿名通道，需 key 才能请求。
test("显式未配置：Tavily 匿名可用，SerpApi 无匿名时失败", async () => {
	const { store } = fakeStore({});
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => tavilyOk([{ url: "https://example.com/free", title: "Free", content: "匿名结果" }]),
			async (calls) => {
				const result = await tool.execute("b7", { query: "q", provider: "tavily" }, undefined, undefined, {});
				assert.equal(result.details.channel, "free");
				assert.equal(calls[0].url, "https://api.tavily.com/search");
				assert.equal(calls[0].init.headers.authorization, undefined);
				assert.equal(calls[0].init.headers["X-Tavily-Access-Mode"], "keyless");
				await assert.rejects(tool.execute("b7b", { query: "q", provider: "serpapi" }, undefined, undefined, {}), /未配置密钥/);
				assert.equal(calls.length, 1, "SerpApi 无 key 时不能发请求");
			},
		),
	);
});

// 8. 授权后仍先尝试全部匿名通道，再按独立计费顺序逐个尝试密钥。
test("auto free-first：按匿名顺序失败后再按计费顺序尝试五家密钥", async () => {
	const { store } = fakeStore({ exa: "e", parallel: "p", tavily: TAVILY_KEY, firecrawl: "f", serpapi: SERP_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => json({ error: "boom" }, 500),
			async (calls) => {
				await assert.rejects(tool.execute("b8", { query: "q" }, undefined, undefined, {}));
				const order = calls.map((call) => {
					if (call.url.includes("exaApiKey")) return "exa(key)";
					if (call.url.includes("mcp.exa.ai")) return "exa";
					if (call.url.includes("search.parallel.ai")) return call.init.headers.authorization ? "parallel(key)" : "parallel";
					if (call.url.includes("api.tavily.com")) return call.init.headers.authorization ? "tavily(key)" : "tavily";
					if (call.url.includes("firecrawl.dev")) return call.init.headers.authorization ? "firecrawl(key)" : "firecrawl";
					if (call.url.includes("agent.tinyfish.ai")) return call.init.headers["X-TinyFish-Access-Mode"] === "keyless" ? "tinyfish" : "other";
					return "serpapi(key)";
				});
				assert.deepEqual(order, ["exa", "tavily", "parallel", "firecrawl", "tinyfish", "exa(key)", "tavily(key)", "parallel(key)", "firecrawl(key)", "serpapi(key)"]);
			},
		),
	);
});

test("auto 默认禁止计费：未配置密钥时仍尝试全部匿名通道", async () => {
	const { store } = fakeStore({});
	const tool = setup(store);
	await withEnv({}, () =>
		withFetch(
			() => Promise.reject(new TypeError("offline")),
			async (calls) => {
				await assert.rejects(tool.execute("b8b", { query: "q" }, undefined, undefined, {}));
				const order = calls.map((call) => {
					if (call.url.includes("mcp.exa.ai")) return "exa";
					if (call.url.includes("api.tavily.com")) return "tavily";
					if (call.url.includes("search.parallel.ai")) return "parallel";
					if (call.url.includes("firecrawl.dev")) return "firecrawl";
					if (call.url.includes("agent.tinyfish.ai")) return "tinyfish";
					return "other";
				});
				assert.deepEqual(order, ["exa", "tavily", "parallel", "firecrawl", "tinyfish"]);
			},
		),
	);
});

// 9. 密钥只读一次；环境变量优先于密钥库。
test("密钥：环境变量优先，且每个后端只读取一次", async () => {
	const { store, reads } = fakeStore({ tavily: "from-store" });
	const tool = setup(store);
	await withEnv({ TAVILY_API_KEY: TAVILY_KEY, PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(_url, init) => init.headers.authorization
				? tavilyOk([{ url: "https://d.example/", title: "D", content: "d" }])
				: new Response("anonymous unavailable", { status: 503 }),
			async (calls) => {
				await tool.execute("b9", { query: "q", provider: "tavily" }, undefined, undefined, {});
				assert.equal(calls[1].init.headers.authorization, `Bearer ${TAVILY_KEY}`);
				assert.equal(reads.tavily, 0, "环境变量存在时不应访问密钥库");
			},
		),
	);
	await withEnv({ PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(_url, init) => init.headers.authorization
				? tavilyOk([{ url: "https://d.example/", title: "D", content: "d" }])
				: new Response("anonymous unavailable", { status: 503 }),
			async () => {
				await tool.execute("b9b", { query: "q", provider: "tavily" }, undefined, undefined, {});
				assert.equal(reads.tavily, 1);
			},
		),
	);
});

// 10. 脱敏：key 跨过 200 字符摘要边界时也不能泄露；details 与正文都不含 key。
test("脱敏：摘要跨 200 字符边界的 key 被完整替换", async () => {
	const { store } = fakeStore({ tavily: TAVILY_KEY });
	const tool = setup(store);
	const content = `${"x".repeat(190)}${TAVILY_KEY}tail`;
	await withEnv({ PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(_url, init) => init.headers.authorization
				? tavilyOk([{ url: "https://e.example/", title: "E", content }])
				: new Response("anonymous unavailable", { status: 503 }),
			async () => {
				const result = await tool.execute("b10", { query: "q", provider: "tavily" }, undefined, undefined, {});
				const serialized = JSON.stringify(result);
				assert.ok(!serialized.includes(TAVILY_KEY));
				assert.ok(!serialized.includes(TAVILY_KEY.slice(0, 10)), "不应残留 key 前缀");
				assert.match(result.content[0].text, /\*\*\*/);
			},
		),
	);
});

test("脱敏：SerpApi 错误回显 key 时最终错误不含原文与编码形式", async () => {
	const { store } = fakeStore({ serpapi: SERP_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => json({ error: `bad key ${SERP_KEY} ${encodeURIComponent(SERP_KEY)}` }, 500),
			async () => {
				await assert.rejects(tool.execute("b10b", { query: "q", provider: "serpapi" }, undefined, undefined, {}), (error) => {
					assert.ok(!String(error.message).includes(SERP_KEY));
					assert.ok(!String(error.message).includes(encodeURIComponent(SERP_KEY)));
					return true;
				});
			},
		),
	);
});

// 11. 超时与取消对原生接口同样生效。
test("原生接口：超时按预算中止", async () => {
	const { store } = fakeStore({ tavily: TAVILY_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "100", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				}),
			async () => {
				await assert.rejects(tool.execute("b11", { query: "q", provider: "tavily" }), /timed out after 100ms/);
			},
		),
	);
});

test("原生接口：中途取消立即返回 AbortError", async () => {
	const { store } = fakeStore({ serpapi: SERP_KEY });
	const tool = setup(store);
	const controller = new AbortController();
	setTimeout(() => controller.abort(), 60);
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "5000", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				}),
			async () => {
				const startedAt = Date.now();
				await assert.rejects(tool.execute("b11b", { query: "q", provider: "serpapi" }, controller.signal), /aborted/);
				assert.ok(Date.now() - startedAt < 2000);
			},
		),
	);
});

// 12. 成功结果的 details 标明实际后端与通道。
test("details：标明 tavily / serpapi 的实际后端与 key 通道", async () => {
	const { store } = fakeStore({ serpapi: SERP_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => serpOk([{ link: "https://f.example/", title: "F", snippet: "f" }]),
			async () => {
				const result = await tool.execute("b12", { query: "q", provider: "serpapi" }, undefined, undefined, {});
				assert.equal(result.details.provider, "serpapi");
				assert.equal(result.details.channel, "key");
				assert.equal(result.details.sourceCount, 1);
				assert.ok(!JSON.stringify(result.details).includes(SERP_KEY));
			},
		),
	);
});

test("allowBillable=false 不读 SecretStore：四匿名可用，SerpApi 被禁用", async () => {
	const { store, reads } = fakeStore({ exa: "store-exa", tavily: TAVILY_KEY });
	const tool = setup(store);
	await withEnv({ PI_WEB_SEARCH_ALLOW_BILLABLE: "false", EXA_API_KEY: "env-exa", TAVILY_API_KEY: TAVILY_KEY }, () =>
		withFetch(
			(url) => String(url).includes("api.tavily.com")
				? tavilyOk([{ url: "https://example.com/t", title: "T", content: "匿名" }])
				: json({ result: { content: [{ type: "text", text: JSON.stringify({ results: [{ url: "https://example.com/p", title: "P", excerpts: ["匿名"] }] }) }] } }),
			async (calls) => {
				const result = await tool.execute("b13", { query: "q", provider: "auto" });
				assert.equal(result.details.provider, "exa");
				assert.equal(result.details.channel, "free");
				const tavily = await tool.execute("b13t", { query: "q", provider: "tavily" });
				assert.equal(tavily.details.channel, "free");
				assert.equal(calls[1].init.headers.authorization, undefined);
				assert.equal(calls[1].init.headers["X-Tavily-Access-Mode"], "keyless");
				await assert.rejects(tool.execute("b13b", { query: "q", provider: "serpapi" }), /PI_WEB_SEARCH_ALLOW_BILLABLE=false/);
				assert.equal(calls.length, 2);
				assert.deepEqual(reads, { exa: 0, parallel: 0, tavily: 0, firecrawl: 0, serpapi: 0 });
			},
		),
	);
});
