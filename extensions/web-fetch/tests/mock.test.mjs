/**
 * web_fetch 离线测试：工具契约、参数校验与配置校验。
 * 全部使用假 Pi API 与进程内环境变量，不触网、不访问真实密钥库。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const configModule = await jiti.import(fileURLToPath(new URL("../config.ts", import.meta.url)));
const errorsModule = await jiti.import(fileURLToPath(new URL("../errors.ts", import.meta.url)));
const FetchErrorShim = errorsModule.FetchError;

function setup(options) {
	const tools = [];
	const commands = [];
	plugin({ registerTool: (tool) => tools.push(tool), registerCommand: (command) => commands.push(command) }, options ?? {});
	assert.equal(tools.length, 1, "web_fetch 应且只应注册一个工具");
	return { tool: tools[0], commands };
}

/** 用受控环境变量执行；默认清空全部 web_fetch 开关。 */
async function withEnv(vars, fn) {
	const saved = {};
	const merged = {
		PI_WEB_FETCH_TIMEOUT_MS: undefined,
		PI_WEB_FETCH_MAX_RESPONSE_BYTES: undefined,
		PI_WEB_FETCH_MAX_CHARS: undefined,
		PI_WEB_FETCH_MAX_REDIRECTS: undefined,
		PI_WEB_FETCH_REMOTE_FALLBACK: undefined,
		...vars,
	};
	for (const key of Object.keys(merged)) saved[key] = process.env[key];
	for (const [key, value] of Object.entries(merged)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
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

test("注册契约：名称 / 标签 / 参数 / 注解", () => {
	const { tool } = setup();
	assert.equal(tool.name, "web_fetch");
	assert.equal(tool.label, "Web Fetch");
	assert.ok(tool.description.length > 0);
	const keys = Object.keys(tool.parameters.properties);
	assert.deepEqual(keys, ["url", "mode", "maxChars"]);
	assert.deepEqual(tool.parameters.required, ["url"]);
	assert.deepEqual(tool.parameters.properties.mode.anyOf.map((entry) => entry.const), ["auto", "article", "text"]);
	assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: true });
});

test("未授权访问私有与内网地址时报固定诊断，且不回显 URL", async () => {
	const { tool } = setup();
	await withEnv({}, async () => {
		for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/", "ftp://example.com/"]) {
			await assert.rejects(tool.execute("fetch-blocked", { url }), (error) => {
				assert.equal(error.name, "FetchError");
				assert.equal(error.kind, "blocked_url");
				assert.ok(!error.message.includes(url), "诊断不得回显调用方 URL");
				return true;
			});
		}
	});
});

test("注入抓取实现后返回正文与结构化 details", async () => {
	const { tool } = setup({
		config: () => ({ timeoutMs: 1000, maxResponseBytes: 1024, maxChars: 500, maxRedirects: 0, remoteFallback: "off" }),
		resolveTarget: async (rawUrl) => ({ url: new URL(rawUrl), address: "93.184.216.34", family: 4 }),
		fetchPage: async () => ({ body: "<h1>标题</h1><p>正文</p>", contentType: "text/html; charset=utf-8", finalUrl: new URL("https://example.com/doc"), redirectCount: 0, statusCode: 200 }),
	});
	await withEnv({}, async () => {
		const result = await tool.execute("fetch-2", { url: "https://example.com/doc" });
		assert.match(result.content[0].text, /标题/u);
		assert.match(result.content[0].text, /正文/u);
		assert.equal(result.details.requestedUrl, "https://example.com/doc");
		assert.equal(result.details.finalUrl, "https://example.com/doc");
		assert.equal(result.details.provider, "direct");
		assert.equal(result.details.statusCode, 200);
		assert.equal(result.details.truncated, false);
		assert.ok(Number.isFinite(result.details.durationMs));
	});
});



test("重定向结果元数据不暴露查询串",  async () => {
	const { tool } = setup({
		config: () => ({ timeoutMs: 1000, maxResponseBytes: 4096, maxChars: 500, maxRedirects: 3, remoteFallback: "off" }),
		resolveTarget: async (rawUrl) => {
			const url = new URL(rawUrl);
			// 只放行测试用来源，其他主机一律按安全策略拒绝。
			if (url.hostname !== "93.184.216.34") throw new FetchErrorShim("目标不是公网地址", "blocked_url");
			return { url, address: "93.184.216.34", family: 4 };
		},
		fetchPage: async (request) => {
			if (request.url.pathname === "/signed") {
				// 模拟一次站内重定向：带令牌的地址必须被重新校验。
				return { body: "# 重定向后的正文", contentType: "text/markdown", finalUrl: new URL("https://93.184.216.34/doc?token=SECRET"), redirectCount: 1, statusCode: 200 };
			}
			throw new FetchErrorShim("unexpected", "network_error");
		},
	});
	await withEnv({}, async () => {
		const result = await tool.execute("fetch-redirect", { url: "https://93.184.216.34/signed?token=SECRET" });
		assert.match(result.content[0].text, /重定向后的正文/u);
		assert.equal(result.details.redirectCount, 1);
		// 请求地址与最终地址都不得带上查询串里的令牌。
		assert.doesNotMatch(JSON.stringify(result.details), /SECRET|token=/u);
		assert.equal(result.details.requestedUrl, "https://93.184.216.34/signed");
		assert.equal(result.details.finalUrl, "https://93.184.216.34/doc");
	});
});

test("空 URL、空白 URL 与非法 maxChars 被拒绝", async () => {
	const { tool } = setup();
	await withEnv({}, async () => {
		for (const params of [{ url: "" }, { url: "   " }, { url: "https://example.com", maxChars: 0 }, { url: "https://example.com", maxChars: 200001 }, { url: "https://example.com", mode: "unknown" }]) {
			await assert.rejects(tool.execute("fetch-bad", params), (error) => {
				assert.equal(error.kind, "invalid_url");
				return true;
			});
		}
	});
});

test("预取消时不调用抓取实现", async () => {
	let called = false;
	const { tool } = setup({ fetchPage: async () => { called = true; return { markdown: "", details: {} }; } });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(tool.execute("fetch-cancel", { url: "https://example.com" }, controller.signal), { name: "FetchError" });
	assert.equal(called, false);
});

test("配置默认值与边界严格校验", () => {
	assert.deepEqual(configModule.readWebFetchConfig({}), {
		timeoutMs: 20_000,
		maxResponseBytes: 5_242_880,
		maxChars: 24_000,
		maxRedirects: 3,
		remoteFallback: "off",
	});
	assert.equal(configModule.readWebFetchConfig({ PI_WEB_FETCH_REMOTE_FALLBACK: " OFF " }).remoteFallback, "off");
	assert.throws(() => configModule.readWebFetchConfig({ PI_WEB_FETCH_REMOTE_FALLBACK: "JINA" }), (error) => error.kind === "remote_blocked");
	assert.equal(configModule.readWebFetchConfig({ PI_WEB_FETCH_MAX_CHARS: " 1 " }).maxChars, 1);
	assert.equal(configModule.readWebFetchConfig({ PI_WEB_FETCH_MAX_RESPONSE_BYTES: "20971520" }).maxResponseBytes, 20_971_520);
	for (const name of [
		"PI_WEB_FETCH_TIMEOUT_MS",
		"PI_WEB_FETCH_MAX_RESPONSE_BYTES",
		"PI_WEB_FETCH_MAX_CHARS",
		"PI_WEB_FETCH_MAX_REDIRECTS",
	]) {
		for (const value of ["0", "-1", "abc", "1.5", "  ", "1e3", "0x10", "99999999999999999999"]) {
			assert.throws(() => configModule.readWebFetchConfig({ [name]: value }), new RegExp(name), `${name}=${value} 必须报错`);
		}
	}
	for (const value of ["on", "true", "reader", "jinaa", "ooff", "jina;rm", "off,off", "1"]) {
		assert.throws(() => configModule.readWebFetchConfig({ PI_WEB_FETCH_REMOTE_FALLBACK: value }), /PI_WEB_FETCH_REMOTE_FALLBACK/u);
	}
	assert.throws(() => configModule.readWebFetchConfig({ PI_WEB_FETCH_MAX_CHARS: "200001" }), /PI_WEB_FETCH_MAX_CHARS/u);
	assert.throws(() => configModule.readWebFetchConfig({ PI_WEB_FETCH_MAX_REDIRECTS: "6" }), /PI_WEB_FETCH_MAX_REDIRECTS/u);
});

test("错误分类与可重试标记只依赖固定分类", () => {
	const timeout = new errorsModule.FetchError("x", "timeout");
	assert.equal(timeout.name, "FetchError");
	assert.equal(timeout.retryable, false);
	const network = new errorsModule.FetchError("x", "network_error");
	assert.equal(network.retryable, true);
	assert.equal(new errorsModule.FetchError("x", "http_error", { statusCode: 404 }).options.statusCode, 404);
	assert.equal(errorsModule.toFetchError(new Error("boom")).kind, "network_error");
	assert.equal(errorsModule.toFetchError(timeout).kind, "timeout");
});

test("工具不注册任何命令，也不依赖 web-search", () => {
	const { commands } = setup();
	assert.deepEqual(commands, []);
});
