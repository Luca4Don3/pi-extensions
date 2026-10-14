import assert from "node:assert/strict";
import testRunner from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const test = (name, fn) => testRunner(name, { concurrency: false }, fn);
const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const text = (value) => ({ type: "text", text: value });
const url = (id) => `https://example.com/${id}`;
const results = (ids) => JSON.stringify({ query: "测试", results: ids.map((id) => ({
	position: id, site_name: "示例", title: `标题${id}`, url: url(id), snippet: `摘要${id}`,
})) });
const envelope = (blocks, extra = {}) => JSON.stringify({ result: { content: blocks.map(text), ...extra } });

async function withTool(body, fn, onFetch) {
	const oldEnv = process.env;
	const oldFetch = globalThis.fetch;
	let calls = 0;
	let reads = 0;
	process.env = { PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_TIMEOUT_MS: "1500", PI_WEB_SEARCH_ALLOW_BILLABLE: "false" };
	globalThis.fetch = async (endpoint, init) => {
		calls++;
		assert.equal(endpoint, "https://agent.tinyfish.ai/mcp");
		assert.equal(init.method, "POST");
		assert.deepEqual(JSON.parse(init.body), {
			jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { query: "测试" } },
		});
		const headers = new Headers(init.headers);
		assert.equal(headers.get("X-TinyFish-Access-Mode"), "keyless");
		assert.equal(headers.get("X-API-Key"), null);
		assert.equal(headers.get("Authorization"), null);
		onFetch?.();
		return new Response(body);
	};
	let tool;
	plugin({ registerTool(value) { tool = value; }, registerCommand() {} }, {
		credentialStore: { kind: "none", async read() { reads++; throw new Error("不得读取凭据"); } },
	});
	try {
		await fn(tool);
		assert.equal(calls, 1, "不得重复请求或回退至其他通道");
		assert.equal(reads, 0);
	} finally {
		process.env = oldEnv;
		globalThis.fetch = oldFetch;
	}
}
const execute = (tool, signal) => tool.execute("分块", { query: "测试", provider: "tinyfish", maxResults: 3 }, signal);

test("公开工具匿名请求合法结果及前后介绍均成功", async () => {
	for (const blocks of [[results([1])], ["介绍", results([1])], [results([1]), "介绍"], ["前言", results([1]), "后记"]]) {
		await withTool(envelope(blocks), async (tool) => {
			const response = await execute(tool);
			assert.deepEqual(response.details.sources.map((source) => source.url), [url(1)]);
			assert.equal(response.details.sources[0].title, "标题1");
		});
	}
});

test("多个合法结构化块统一去重限量", async () => {
	await withTool(envelope(["介绍", results([1, 2]), results([2, 3, 4]), "后记"]), async (tool) => {
		const response = await execute(tool);
		assert.deepEqual(response.details.sources.map((source) => source.url), [url(1), url(2), url(3)]);
	});
});

test("全部介绍或没有来源时为协议错误", async () => {
	for (const blocks of [["介绍", "后记"], ["介绍", results([])], [results([1]), '{"error":']]) {
		await withTool(envelope(blocks), async (tool) => {
			await assert.rejects(execute(tool), /\[protocol_error\]/);
		});
	}
});

test("结果前后结构化错误信封不得作为介绍忽略且保留分类", async () => {
	for (const [payload, kind] of [
		[{ error: { message: "quota exhausted" } }, "quota_exhausted"],
		[{ error: { message: "too many requests" } }, "rate_limited"],
		[{ error: "provider_error" }, "protocol_error"],
		[{ error: null }, "protocol_error"],
		[{ success: false, results: [{ url: url(9) }] }, "protocol_error"],
	]) {
		for (const blocks of [[JSON.stringify(payload), results([1])], [results([1]), JSON.stringify(payload)]]) {
			await withTool(envelope(blocks), async (tool) => {
				await assert.rejects(execute(tool), new RegExp(`\\[${kind}\\]`));
			});
		}
	}
});

test("明确普通文本错误及协议失败不能与有效来源混成成功", async () => {
	for (const [detail, kind] of [["quota exhausted", "quota_exhausted"], ["rate_limited", "rate_limited"], ["provider_error", "protocol_error"]]) {
		for (const blocks of [[detail, results([1])], [results([1]), detail]]) {
			await withTool(envelope(blocks), async (tool) => {
				await assert.rejects(execute(tool), new RegExp(`\\[${kind}\\]`));
			});
		}
	}
	await withTool(envelope([results([1]), "quota exhausted"], { isError: true }), async (tool) => {
		await assert.rejects(execute(tool), /\[quota_exhausted\]/);
	});
});

test("取消不能被跳过介绍的分支吞掉", async () => {
	const controller = new AbortController();
	await withTool(envelope(["介绍", results([1])]), async (tool) => {
		await assert.rejects(execute(tool, controller.signal), (error) => error.name === "AbortError");
	}, () => controller.abort());
});
