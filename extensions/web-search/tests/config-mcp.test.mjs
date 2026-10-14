import assert from "node:assert/strict";
import testRunner from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const test = (name, fn) => testRunner(name, { concurrency: false }, fn);
const jiti = createJiti(import.meta.url);
const load = (path) => jiti.import(fileURLToPath(new URL(path, import.meta.url)));
const { readSearchRequestConfig } = await load("../config.ts");
const { parseMcpResponse } = await load("../mcp-protocol.ts");
const loaded = await load("../index.ts");
const plugin = loaded.default ?? loaded;
const text = (value) => ({ type: "text", text: value });
const response = (content, extra = {}) => JSON.stringify({ result: { content, ...extra } });
const url = (id) => `https://example.com/${id}`;
const parallel = (ids) => JSON.stringify({ results: ids.map((id) => ({ url: url(id), title: `标题${id}`, excerpts: [`摘要${id}`] })) });

 test("配置默认、空值与闭区间端点", () => {
	assert.deepEqual(readSearchRequestConfig({}), { retries: 1, timeoutMs: 25000, totalTimeoutMs: 90000 });
	assert.deepEqual(readSearchRequestConfig({ PI_WEB_SEARCH_RETRIES: " ", PI_WEB_SEARCH_TIMEOUT_MS: "", PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: "  " }), { retries: 1, timeoutMs: 25000, totalTimeoutMs: 90000 });
	for (const retries of [0, 1, 3]) for (const timeoutMs of [100, 25000, 120000]) for (const totalTimeoutMs of [1000, 90000, 600000]) {
		assert.deepEqual(readSearchRequestConfig({ PI_WEB_SEARCH_RETRIES: String(retries), PI_WEB_SEARCH_TIMEOUT_MS: String(timeoutMs), PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: String(totalTimeoutMs) }), { retries, timeoutMs, totalTimeoutMs });
	}
});

 test("非法配置显式失败且不回显", () => {
	for (const [name, values] of [
		["PI_WEB_SEARCH_RETRIES", ["-1", "4", "1000000", "1.5", "Infinity", "NaN", "9007199254740992", "非法标记"]],
		["PI_WEB_SEARCH_TIMEOUT_MS", ["0", "99", "120001", "1000000", "100.5", "Infinity", "9007199254740992", "非法标记"]],
		["PI_WEB_SEARCH_TOTAL_TIMEOUT_MS", ["0", "999", "600001", "1000000", "100.5", "Infinity", "NaN", "9007199254740992", "非法标记"]],
	]) for (const value of values) {
		const range = name === "PI_WEB_SEARCH_RETRIES" ? "0..3" : name === "PI_WEB_SEARCH_TIMEOUT_MS" ? "100..120000" : "1000..600000";
		assert.throws(() => readSearchRequestConfig({ [name]: value }), (error) => error.message === `${name} 配置无效：必须是 ${range} 范围内的安全整数`);
	}
});

async function withTool(env, fetcher, fn) {
	const oldEnv = process.env;
	const oldFetch = globalThis.fetch;
	process.env = { PI_WEB_SEARCH_RETRIES: "0", ...env };
	globalThis.fetch = fetcher;
	let tool;
	let reads = 0;
	plugin({ registerTool: (value) => { tool = value; }, registerCommand() {} }, {
		credentialStore: { kind: "none", async read() { reads++; throw new Error("不得读取凭据"); } },
	});
	try { await fn(tool, () => reads); }
	finally { process.env = oldEnv; globalThis.fetch = oldFetch; }
}

 test("公开工具非法配置早于网络和凭据", async () => {
	for (const env of [{ PI_WEB_SEARCH_RETRIES: "1000000" }, { PI_WEB_SEARCH_TIMEOUT_MS: "99" }]) {
		let calls = 0;
		await withTool({ ...env, PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => { calls++; throw new Error("不得联网"); }, async (tool, reads) => {
			await assert.rejects(tool.execute("配置", { query: "测试", provider: "auto" }), /配置无效/);
			assert.equal(reads(), 0);
		});
		assert.equal(calls, 0);
	}
});

 test("文本块仅接受合法类型及非空字符串", () => {
	assert.deepEqual(parseMcpResponse(response([null, {}, { type: "image", text: "无效" }, { text: "无效" }, { type: "text" }, text(42), text(" "), text("正文"), text("后块")])), ["正文", "后块"]);
	assert.equal(parseMcpResponse(response([{ type: "image", text: "无效" }])), undefined);
	assert.deepEqual(parseMcpResponse(response([text("单块")])), ["单块"]);
});

 test("后块错误参与分类及协议错误兼容", () => {
	for (const [detail, kind] of [["too many requests", "rate_limited"], ["quota exhausted", "quota_exhausted"], ["invalid api key", "invalid_key"]]) {
		assert.throws(() => parseMcpResponse(response([text("介绍"), text(detail)], { isError: true })), (error) => error.kind === kind);
		assert.throws(() => parseMcpResponse(JSON.stringify({ error: { message: detail } })), (error) => error.kind === kind);
	}
	assert.throws(() => parseMcpResponse(response([], { isError: true })), (error) => error.kind === "protocol_error");
	assert.throws(() => parseMcpResponse('{"error":null}'), (error) => error.kind === "protocol_error");
});

 test("事件流不串接不同协议响应", () => {
	const first = response([text("第一块"), text("第二块")]);
	assert.deepEqual(parseMcpResponse(`data: ${first}\n\ndata: ${response([text("另一响应")])}\n\n`), ["第一块", "第二块"]);
	assert.deepEqual(parseMcpResponse(`data: ${first}`), ["第一块", "第二块"]);
	assert.deepEqual(parseMcpResponse('data: {"result":\ndata: {"content":[{"type":"text","text":"正文"}]}}\n\n'), ["正文"]);
});

 test("多个结构化块逐块解析、跨块去重限量且不重复回退", async () => {
	for (const provider of ["parallel", "exa"]) {
		let calls = 0;
		const blocks = provider === "parallel"
			? [text("介绍文字"), text(parallel([1, 2])), text(parallel([2, 3, 4]))]
			: [text(`Title: 标题1\nURL: ${url(1)}\nText: 摘要1`), text(`Title: 标题2\nURL: ${url(2)}`), text(`Title: 重复\nURL: ${url(1)}\n\nTitle: 标题3\nURL: ${url(3)}`)];
		await withTool({}, async () => { calls++; return new Response(response([{ type: "image", text: url("invalid") }, {}, ...blocks])); }, async (tool) => {
			const result = await tool.execute("多块", { query: "测试", provider, maxResults: 3 });
			assert.deepEqual(result.details.sources.map((source) => source.url), [url(1), url(2), url(3)]);
			assert.equal(result.details.sources[0].title, "标题1");
		});
		assert.equal(calls, 1);
	}
});

test("公开工具后块额度提示只尝试一次", async () => {
	for (const body of [
		response([text("介绍"), text("quota exhausted")], { isError: true }),
		response([text(`Title: 来源\nURL: ${url(1)}`), text("You've hit Exa's free MCP rate limit.")]),
	]) {
		let calls = 0;
		await withTool({}, async () => { calls++; return new Response(body); }, async (tool) => {
			await assert.rejects(tool.execute("错误", { query: "测试", provider: "exa" }));
		});
		assert.equal(calls, 1);
	}
});
