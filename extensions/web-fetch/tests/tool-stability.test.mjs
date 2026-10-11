/** 工具入口稳定性回归：本地服务器或假依赖，不访问外网与用户配置。 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: plugin } = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const { readWebFetchConfig } = await jiti.import(fileURLToPath(new URL("../config.ts", import.meta.url)));
const { FetchError } = await jiti.import(fileURLToPath(new URL("../errors.ts", import.meta.url)));
const config = (overrides = {}) => ({ timeoutMs: 1000, maxResponseBytes: 4096, maxChars: 500, maxRedirects: 3, remoteFallback: "off", ...overrides });
const target = (rawUrl) => ({ url: new URL(rawUrl), address: "127.0.0.1", family: 4 });
const page = (body = "正文") => ({ body, contentType: "text/plain", finalUrl: new URL("https://example.test/doc"), redirectCount: 0, statusCode: 200 });
function setup(options) {
	const tools = [];
	plugin({ registerTool: (tool) => tools.push(tool) }, { config: () => config(), ...options });
	return tools[0];
}
function deferred() {
	let resolve, reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}
async function withServer(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try { await fn(`http://127.0.0.1:${server.address().port}`); }
	finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("初始 DNS 永不返回也受整次预算约束，且绝不发起抓取", async () => {
	let fetched = false;
	let dnsSignal;
	const lookup = deferred();
	const tool = setup({
		config: () => config({ timeoutMs: 25 }),
		resolveTarget: (_url, signal) => { dnsSignal = signal; return lookup.promise; },
		fetchPage: async () => { fetched = true; return page(); },
	});
	await assert.rejects(tool.execute("deadline", { url: "https://example.test/" }), (error) => error.kind === "timeout");
	assert.equal(dnsSignal.aborted, true);
	assert.equal(fetched, false);
	lookup.reject(new Error("迟到解析错误"));
	await new Promise((resolve) => setImmediate(resolve));
});

test("初始 DNS 的外部取消及时生效，迟到成功不能继续抓取", async () => {
	const lookup = deferred();
	let fetched = false;
	const controller = new AbortController();
	const tool = setup({ resolveTarget: () => lookup.promise, fetchPage: async () => { fetched = true; return page(); } });
	const pending = tool.execute("cancel", { url: "https://example.test/" }, controller.signal);
	controller.abort(new Error("不应暴露的上游错误"));
	await assert.rejects(pending, (error) => error.kind === "aborted" && !error.message.includes("上游错误"));
	lookup.resolve(target("https://example.test/"));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(fetched, false);
});

test("入口真实跟随跳转，读取 maxRedirects 配置并拒绝非测试来源", async () => {
	const visited = [];
	await withServer((request, response) => {
		visited.push(request.url);
		if (request.url === "/blocked") { response.writeHead(302, { location: "http://metadata.example.test/" }); response.end(); return; }
		const step = Number(request.url.slice(1));
		if (step < 4) { response.writeHead(302, { location: `/${step + 1}` }); response.end(); return; }
		response.writeHead(200, { "content-type": "text/html" });
		response.end('<main><p>终点正文 <a href="../guide">相对链接</a></p></main>');
	}, async (base) => {
		const resolved = [];
		const resolveTarget = async (rawUrl, signal) => {
			assert.equal(signal.aborted, false);
			resolved.push(rawUrl);
			if (new URL(rawUrl).origin !== base) throw new FetchError("目标不是公网地址", "blocked_url");
			return target(rawUrl);
		};
		const limited = setup({ config: () => readWebFetchConfig({ PI_WEB_FETCH_MAX_REDIRECTS: "1" }), resolveTarget });
		await assert.rejects(limited.execute("limited", { url: `${base}/0` }), (error) => error.kind === "blocked_url");
		assert.deepEqual(visited, ["/0", "/1"]);
		visited.length = 0;
		const tool = setup({ config: () => readWebFetchConfig({ PI_WEB_FETCH_MAX_REDIRECTS: "5" }), resolveTarget });
		const result = await tool.execute("chain", { url: `${base}/0` });
		assert.deepEqual(visited, ["/0", "/1", "/2", "/3", "/4"]);
		assert.equal(result.details.redirectCount, 4);
		assert.ok(result.content[0].text.includes(`[相对链接](${base}/guide)`));
		await assert.rejects(tool.execute("blocked", { url: `${base}/blocked` }), (error) => error.kind === "blocked_url");
		assert.ok(resolved.includes("http://metadata.example.test/"));
		assert.equal(visited.at(-1), "/blocked");
	});
});

test("DNS 消耗的预算不能在 HTTP 层重新计时", async () => {
	let fetchRequest;
	const tool = setup({
		config: () => config({ timeoutMs: 80, maxRedirects: 5 }),
		resolveTarget: async (url) => { await new Promise((resolve) => setTimeout(resolve, 50)); return target(url); },
		fetchPage: (request) => {
			fetchRequest = request;
			return new Promise(() => undefined);
		},
	});
	await assert.rejects(tool.execute("total", { url: "https://example.test/" }), (error) => error.kind === "timeout");
	assert.equal(fetchRequest.maxRedirects, 5);
	assert.equal(fetchRequest.signal.aborted, true);
	assert.ok(fetchRequest.deadlineMs < performance.now());
});

test("同步提取超过截止时间时不得返回成功正文", async () => {
	const tool = setup({
		config: () => config({ timeoutMs: 10 }), resolveTarget: async (url) => target(url), fetchPage: async () => page(),
		extract: () => {
			const stop = performance.now() + 30;
			while (performance.now() < stop) { /* 模拟不可抢占的同步计算。 */ }
			return { markdown: "过期正文", truncated: false };
		},
	});
	await assert.rejects(tool.execute("extract", { url: "https://example.test/" }), (error) => error.kind === "timeout");
});

test("远程回退尚未实现时明确失败，发生在解析或抓取之前", async () => {
	for (const configuration of [() => readWebFetchConfig({ PI_WEB_FETCH_REMOTE_FALLBACK: "jina" }), () => config({ remoteFallback: "jina" })]) {
		let touched = false;
		const tool = setup({ config: configuration, resolveTarget: async (url) => { touched = true; return target(url); } });
		await assert.rejects(tool.execute("remote", { url: "https://example.test/" }), (error) => error.kind === "remote_blocked" && /尚未实现/u.test(error.message));
		assert.equal(touched, false);
	}
});

test("恰好达到上限不是截断，真实超限包含提示且仍在上限内", async () => {
	for (const [body, truncated] of [["abcde", false], ["abcdef", true]]) {
		const tool = setup({ resolveTarget: async (url) => target(url), fetchPage: async () => page(body) });
		const result = await tool.execute("chars", { url: "https://example.test/", maxChars: 5 });
		assert.equal(result.details.truncated, truncated);
		assert.ok(result.content[0].text.length <= 5);
		assert.equal(result.details.extractedChars, result.content[0].text.length);
	}
});
