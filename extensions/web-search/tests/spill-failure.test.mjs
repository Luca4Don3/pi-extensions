import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// index.ts 用命名导入拿 fs/promises：包装器必须在加载它之前装好，
// 否则替换只影响测试自己的引用，测不到生产代码真实走的路径。
const realMkdir = fs.mkdir;
const realOpen = fs.open;
let overrideMkdir;
let overrideOpen;
fs.mkdir = (...args) => (overrideMkdir ?? realMkdir)(...args);
fs.open = (...args) => (overrideOpen ?? realOpen)(...args);
syncBuiltinESMExports();

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const { createChannelHealth } = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const root = fileURLToPath(new URL("../../../.temp/spill-failure-tests/", import.meta.url));
const warning = "正文已截断，完整正文落盘失败。";
const body = `Title: Success\nURL: https://example.com/success\nHighlights:\n${"x".repeat(40000)}`;

// 每次保留独立故障现场，不删除文件或修改权限。
async function runCase(kind, cancel = false) {
	mkdirSync(root, { recursive: true });
	const directory = mkdtempSync(join(root, "case-"));
	const spillDirectory = join(directory, `pi-web-search-${process.getuid()}`);
	const blocker = join(directory, "blocker");
	writeFileSync(blocker, "受控故障");
	const vars = {
		TMPDIR: directory,
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_ALLOW_BILLABLE: "true",
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		EXA_API_KEY: "offline-spill-secret",
		PARALLEL_API_KEY: undefined,
		TAVILY_API_KEY: undefined,
		FIRECRAWL_API_KEY: undefined,
		SERPAPI_API_KEY: undefined,
	};
	const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const controller = new AbortController();
	let injected = 0;
	// 明确调用真实 mkdir/open 制造故障，不用目录权限检查代替写入路径。
	if (kind === "mkdir") overrideMkdir = async (...args) => {
		if (!String(args[0]).endsWith(`pi-web-search-${process.getuid()}`)) return realMkdir(...args);
		injected++;
		try { return await realMkdir(join(blocker, "child"), args[1]); }
		finally { if (cancel) controller.abort(); }
	};
	overrideOpen = async (...args) => {
		if (kind === "open") {
			injected++;
			try { return await realOpen(spillDirectory, args[1], args[2]); }
			finally { if (cancel) controller.abort(); }
		}
		const handle = await realOpen(...args);
		if (cancel && kind === "success") {
			const write = handle.writeFile.bind(handle);
			handle.writeFile = async (...values) => {
				try { return await write(...values); }
				finally { injected++; controller.abort(); }
			};
		}
		return handle;
	};
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return new Response(`event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: body }] } })}\n\n`, { status: 200 });
	};
	const health = createChannelHealth();
	let failures = 0;
	const originalFailure = health.recordFailure;
	health.recordFailure = (...args) => { failures += 1; return originalFailure(...args); };
	let tool;
	plugin({ registerTool: (value) => { tool = value; }, registerCommand() {} }, {
		credentialStore: { kind: "none", read: async () => ({ status: "unavailable", reason: "离线测试" }) },
		channelHealth: health,
	});
	try {
		const execution = tool.execute("spill-failure", { query: "success", provider: "auto" }, controller.signal);
		if (cancel) {
			await assert.rejects(execution, (error) => error.name === "AbortError");
			assert.deepEqual(health.snapshot().channels, []);
		} else {
			const result = await execution;
			assert.equal(result.details.provider, "exa");
			assert.equal(result.details.attemptCount, 1);
			assert.equal(result.details.sourceCount, 1);
			assert.equal(result.details.sources[0].url, "https://example.com/success");
			assert.equal(result.details.truncated, true);
			assert.equal(result.details.fullTextWarning, warning);
			for (const field of ["fullTextPath", "fullTextComplete", "fallbackReason"]) assert.equal(field in result.details, false);
			assert.match(result.content[0].text, /content truncated to/);
			assert.doesNotMatch(result.content[0].text, /full text:/);
			const serialized = JSON.stringify(result);
			assert.equal(serialized.includes(directory), false);
			assert.equal(serialized.includes("offline-spill-secret"), false);
		}
		assert.equal(injected, 1);
		assert.equal(requests, 1);
		assert.equal(failures, 0);
	} finally {
		globalThis.fetch = originalFetch;
		overrideMkdir = undefined;
		overrideOpen = undefined;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

for (const kind of ["mkdir", "open"]) {
	test(`真实 ${kind} 冲突保留搜索结果，不触发渠道回退`, { concurrency: false }, () => runCase(kind));
	test(`真实 ${kind} 冲突后的取消仍终止`, { concurrency: false }, () => runCase(kind, true));
}
test("落盘成功后的取消仍终止", { concurrency: false }, () => runCase("success", true));
