import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;

test("零重试配置保留单次服务器错误尝试", async () => {
	const oldEnv = process.env;
	const oldFetch = globalThis.fetch;
	let calls = 0;
	let tool;
	process.env = { PI_WEB_SEARCH_RETRIES: "0" };
	globalThis.fetch = async () => { calls++; return new Response("server unavailable", { status: 503 }); };
	try {
		plugin({ registerTool: (value) => { tool = value; }, registerCommand() {} }, {
			credentialStore: { kind: "none", async read() { throw new Error("不得读取凭据"); } },
		});
		await assert.rejects(tool.execute("零重试", { query: "测试", provider: "exa" }));
		assert.equal(calls, 1);
	} finally {
		process.env = oldEnv;
		globalThis.fetch = oldFetch;
	}
});
