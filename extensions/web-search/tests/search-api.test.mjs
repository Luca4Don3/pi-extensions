/** REST provider 请求与解析离线测试；不访问网络或真实凭据。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const api = await jiti.import(fileURLToPath(new URL("../search-api.ts", import.meta.url)));

const parse = (backend, payload, limit = 10) => api.parseApiResponse(backend, JSON.stringify(payload), limit);

test("服务提供方识别使用统一表", () => {
	assert.equal(api.isApiBackend("tavily"), true);
	assert.equal(api.isApiBackend("firecrawl"), true);
	assert.equal(api.isApiBackend("serpapi"), true);
	assert.equal(api.isApiBackend("exa"), false);
});

test("Tavily 免费请求仅用 keyless 头和固定 basic 请求体", () => {
	const request = api.buildApiRequest("tavily", "hello", 4, undefined, "free");
	assert.equal(request.url, "https://api.tavily.com/search");
	assert.equal(request.method, "POST");
	assert.deepEqual(request.headers, {
		accept: "application/json",
		"content-type": "application/json",
		"X-Tavily-Access-Mode": "keyless",
	});
	assert.deepEqual(JSON.parse(request.body), {
		query: "hello",
		search_depth: "basic",
		auto_parameters: false,
		include_answer: false,
		include_raw_content: false,
		max_results: 4,
	});
	assert.equal("authorization" in request.headers, false);
});

test("Tavily 密钥请求仅用 Bearer，不带 keyless 头", () => {
	const request = api.buildApiRequest("tavily", "q", 2, "tvly-test-secret");
	assert.deepEqual(request.headers, {
		accept: "application/json",
		"content-type": "application/json",
		authorization: "Bearer tvly-test-secret",
	});
	assert.equal("X-Tavily-Access-Mode" in request.headers, false);
});

test("Firecrawl 免费与密钥请求严格限制 body 和 headers", () => {
	const free = api.buildApiRequest("firecrawl", "q", 3, undefined, "free");
	assert.equal(free.url, "https://api.firecrawl.dev/v2/search");
	assert.equal(free.method, "POST");
	assert.deepEqual(free.headers, { accept: "application/json", "content-type": "application/json" });
	assert.deepEqual(JSON.parse(free.body), { query: "q", limit: 3, sources: ["web"] });

	const keyed = api.buildApiRequest("firecrawl", "q", 3, "fc-test-secret", "key");
	assert.deepEqual(keyed.headers, {
		accept: "application/json",
		"content-type": "application/json",
		authorization: "Bearer fc-test-secret",
	});
	assert.deepEqual(JSON.parse(keyed.body), { query: "q", limit: 3, sources: ["web"] });
});

test("SerpApi 保留 Google organic 请求参数，且明确拒绝免费通道", () => {
	const request = api.buildApiRequest("serpapi", "a&b=c", 5, "serp-secret");
	const url = new URL(request.url);
	assert.equal(`${url.origin}${url.pathname}`, "https://serpapi.com/search.json");
	assert.equal(request.method, "GET");
	assert.deepEqual(request.headers, { accept: "application/json" });
	assert.equal(url.searchParams.get("engine"), "google");
	assert.equal(url.searchParams.get("q"), "a&b=c");
	assert.equal(url.searchParams.get("api_key"), "serp-secret");
	assert.equal(url.searchParams.get("num"), "5");
	assert.throws(() => api.buildApiRequest("serpapi", "q", 1, undefined, "free"), /免费通道/);
});

test("免费与密钥凭据混用均拒绝且错误不回显密钥", () => {
	for (const backend of ["tavily", "firecrawl", "serpapi"]) {
		const secret = `${backend}-never-echo-this`;
		assert.throws(() => api.buildApiRequest(backend, "q", 1, secret, "free"), (error) => {
			assert.equal(String(error).includes(secret), false);
			return true;
		});
		assert.throws(() => api.buildApiRequest(backend, "q", 1), /密钥/);
	}
});

test("Firecrawl success:false 即使携带 data.web 也按失败处理", () => {
	assert.throws(
		() => parse("firecrawl", { success: false, data: { web: [{ url: "https://valid.example/" }] } }),
		(error) => error.kind === "protocol_error",
	);
});

test("成功结果字段归一化、摘要保留完整且发布时间只取真实字段", () => {
	const longSnippet = "完整摘要".repeat(2000);
	const tavily = parse("tavily", { results: [{ url: "https://t.example/", title: " T ", content: longSnippet, published_date: "2026-01-02", raw_content: "不公开" }] });
	assert.deepEqual(tavily, [{ url: "https://t.example/", title: "T", snippet: longSnippet, publishedAt: "2026-01-02" }]);

	const firecrawl = parse("firecrawl", { success: true, data: { web: [
		{ url: "https://f.example/", title: "F", description: "描述", publish_date: "2026-02-03", other: "不公开" },
		{ url: "https://f2.example/", title: "无日期", description: "摘要" },
	] } });
	assert.deepEqual(firecrawl, [
		{ url: "https://f.example/", title: "F", snippet: "描述", publishedAt: "2026-02-03" },
		{ url: "https://f2.example/", title: "无日期", snippet: "摘要" },
	]);
	assert.deepEqual(parse("firecrawl", { data: { web: [{ url: "https://p.example/", publishedAt: "2026-03-04" }] } }), [
		{ url: "https://p.example/", publishedAt: "2026-03-04" },
	]);

	assert.deepEqual(parse("serpapi", { search_metadata: { status: "Success" }, organic_results: [
		{ link: "https://s.example/", title: "S", snippet: "摘要", date: "2026-04-05", position: 1 },
	] }), [{ url: "https://s.example/", title: "S", snippet: "摘要", publishedAt: "2026-04-05" }]);
});

test("非法 JSON、错误字段、空结果、重复和恶意 URL 均不产生伪来源", () => {
	assert.throws(() => api.parseApiResponse("tavily", "not-json", 3), /非法 JSON/);
	for (const field of ["error", "detail", "message"]) {
		assert.throws(() => parse("firecrawl", { [field]: "provider failed", data: { web: [{ url: "https://fake.example/" }] } }), /provider failed/);
	}
	assert.throws(() => parse("firecrawl", { error: { code: "unknown" }, data: { web: [{ url: "https://fake.example/" }] } }), /错误字段/);
	assert.throws(() => parse("firecrawl", { data: { web: [] } }), /没有可用搜索结果/);
	assert.throws(() => parse("serpapi", { organic_results: [
		{ link: "javascript:alert(1)" },
		{ link: "file:///etc/passwd" },
		{ link: "data:text/html,bad" },
	] }), /没有可用搜索结果/);
	const deduped = parse("firecrawl", { data: { web: [
		{ url: "https://same.example/", title: "first" },
		{ url: "https://same.example/", title: "duplicate" },
		{ url: "https://other.example/", title: "second" },
	] } }, 2);
	assert.deepEqual(deduped, [
		{ url: "https://same.example/", title: "first" },
		{ url: "https://other.example/", title: "second" },
	]);
});

test("Tavily、Firecrawl 额度/限流分类和 SerpApi 通用分类兼容", () => {
	assert.equal(api.apiHttpKind("tavily", 432, "limit"), "quota_exhausted");
	assert.equal(api.apiHttpKind("tavily", 433, "limit"), "quota_exhausted");
	assert.equal(api.apiHttpKind("firecrawl", 402, "payment required"), "quota_exhausted");
	assert.equal(api.apiHttpKind("firecrawl", 429, "temporary limit"), "rate_limited");
	assert.equal(api.apiHttpKind("serpapi", 429, "Your account has run out of searches"), "quota_exhausted");
	assert.equal(api.apiHttpKind("serpapi", 429, "too many requests"), "rate_limited");
});
