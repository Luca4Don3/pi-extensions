/** 落盘失败路径的端到端语义：清理未完成文件、降级返回、不重发请求、取消不变。 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// index.ts 用命名导入拿 fs/promises：包装器必须在加载它之前装好。
const realOpen = fs.open;
let overrideOpen;
fs.open = (...args) => (overrideOpen ?? realOpen)(...args);
syncBuiltinESMExports();

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const { createChannelHealth } = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const base = fileURLToPath(new URL("../.temp/", import.meta.url));
await fs.mkdir(base, { recursive: true });
const uid = process.getuid();
const warning = "正文已截断，完整正文落盘失败。";
const body = `Title: Success\nURL: https://example.com/success\nHighlights:\n${"x".repeat(40000)}`;
const sse = `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text: body }] } })}\n\n`;

/** 每个故障现场相互独立，不删除文件或修改权限。 */
async function runCase(kind) {
	const directory = mkdtempSync(join(base, "spill-cleanup-int-"));
	const spillDirectory = join(directory, `pi-web-search-${uid}`);
	const vars = {
		TMPDIR: directory,
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		PI_WEB_SEARCH_ALLOW_BILLABLE: undefined,
		PI_WEB_SEARCH_ALLOW_PAID: undefined,
		PI_WEB_SEARCH_TIMEOUT_MS: undefined,
		PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: undefined,
		EXA_API_KEY: undefined,
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
	overrideOpen = async (...args) => {
		const handle = await realOpen(...args);
		if (kind === "write" || kind === "cancel-write") {
			const write = handle.writeFile.bind(handle);
			handle.writeFile = async (...values) => {
				injected++;
				// 先真实写一段再失败：留下未完成的文件。
				await write(Buffer.from("半截正文"));
				if (kind === "cancel-write") controller.abort();
				throw new Error("注入写入故障");
			};
		} else if (kind === "close") {
			injected++;
			handle.close = async () => { throw new Error("注入关闭故障"); };
		}
		return handle;
	};
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => {
		requests += 1;
		return new Response(sse, { status: 200 });
	};
	const health = createChannelHealth();
	let failures = 0;
	const originalFailure = health.recordFailure;
	health.recordFailure = (...args) => { failures += 1; return originalFailure(...args); };
	const tools = [];
	plugin({ registerTool: (value) => { tools.push(value); }, registerCommand() {} }, {
		credentialStore: { kind: "none", read: async () => ({ status: "unavailable", reason: "离线测试" }) },
		channelHealth: health,
	});
	const tool = tools[0];
	try {
		const execution = tool.execute("spill-cleanup", { query: "success", provider: "exa" }, controller.signal);
		if (kind === "cancel-write") {
			await assert.rejects(execution, (error) => error.name === "AbortError");
			// 取消不改变任何通道健康状态。
			assert.deepEqual(health.snapshot().channels, []);
		} else {
			const result = await execution;
			assert.equal(result.details.provider, "exa");
			assert.equal(result.details.attemptCount, 1);
			assert.equal(result.details.truncated, true);
			// 落盘失败按既有语义降级，不回退到其他通道。
			assert.equal(result.details.fullTextWarning, warning);
			for (const field of ["fullTextPath", "fullTextComplete"]) assert.equal(field in result.details, false);
		}
		assert.equal(injected, 1);
		assert.equal(requests, 1, "落盘失败后不得重发网络请求");
		assert.equal(failures, 0);
		// 未完成的文件必须被清理；但完整写入并复查通过后 close 失败不得删除正文，
		// 否则本次已取得的完整内容会被无谓丢弃，只允许保留这份完整文件。
		const names = (await fs.readdir(spillDirectory).catch(() => [])).filter((name) => name.startsWith("results-"));
		if (kind === "close") {
			assert.equal(names.length, 1, "完整落盘后 close 失败必须保留正文文件");
			assert.equal(await fs.readFile(join(spillDirectory, names[0]), "utf8"), body);
		} else {
			assert.deepEqual(names, []);
		}
	} finally {
		globalThis.fetch = originalFetch;
		overrideOpen = undefined;
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

for (const kind of ["write", "close"]) {
	test(`落盘 ${kind} 失败后降级返回且清理未完成文件`, { concurrency: false }, () => runCase(kind));
}
test("落盘失败后取消仍终止且不改变通道状态", { concurrency: false }, () => runCase("cancel-write"));
