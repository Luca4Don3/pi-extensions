/**
 * 冒烟测试：mock Pi 的 ExtensionAPI，直接调用 web_search 的 execute。
 * 不经过模型，只验证「注册 → 参数校验 → 真实网络请求 → 解析 → 渲染」全链路。
 *
 * 该脚本需要真实外网，不适合放进 CI；离线断言请用 tests/mock.test.mjs。
 * 用法：node tests/smoke.mjs
 */

import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const module_ = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = module_.default ?? module_;

const tools = [];
const noSystemStore = {
	kind: "none",
	read: async () => ({ status: "unavailable", reason: "smoke test skips system key stores" }),
	clear: async () => ({ status: "unavailable", reason: "smoke test skips system key stores" }),
};
plugin(
	{ registerTool: (tool) => tools.push(tool), registerCommand: () => undefined },
	{ credentialStore: noSystemStore },
);

const tool = tools[0];
if (!tool) throw new Error("扩展没有注册任何工具");
const paramKeys = Object.keys(tool.parameters?.properties ?? {});

console.log(`[1] 工具名: ${tool.name} | label: ${tool.label}`);
console.log(`[1] 参数: ${paramKeys.join(", ")}`);
console.log(`[1] annotations: ${JSON.stringify(tool.annotations)}`);

async function run(label, params) {
	const startedAt = Date.now();
	try {
		const result = await tool.execute("smoke-1", params, undefined, undefined, {});
		const text = result.content?.[0]?.text ?? "";
		const details = result.details ?? {};
		console.log(
			`\n[${label}] OK ${Date.now() - startedAt}ms | provider=${details.provider} | sources=${details.sourceCount} | truncated=${details.truncated}`,
		);
		console.log(`[${label}] 正文前 400 字:\n${text.slice(0, 400)}`);
		console.log(`[${label}] 首条来源: ${JSON.stringify(details.sources?.[0]?.url ?? null)}`);
	} catch (error) {
		console.log(`\n[${label}] FAIL ${Date.now() - startedAt}ms | ${error instanceof Error ? error.message : String(error)}`);
	}
}

await run("exa", { query: "Pi coding agent extension registerTool API", maxResults: 3, provider: "exa" });
await run("parallel", { query: "Pi coding agent extension registerTool API", provider: "parallel" });
await run("auto", { query: "TypeScript 5.7 新特性", maxResults: 2 });

// Tavily / SerpApi 必须显式提供环境变量才会真实调用，避免误用密钥库或产生额度消耗。
for (const [provider, variable] of [["tavily", "TAVILY_API_KEY"], ["serpapi", "SERPAPI_API_KEY"]]) {
	if (!process.env[variable]) {
		console.log(`\n[${provider}] SKIP 未设置 ${variable}`);
		continue;
	}
	await run(provider, { query: "Pi coding agent extension registerTool API", maxResults: 2, provider });
}

// 参数校验路径：空 query 必须显式失败。
try {
	await tool.execute("smoke-2", { query: "   " }, undefined, undefined, {});
	console.log("\n[empty-query] FAIL 未按预期抛错");
} catch (error) {
	console.log(`\n[empty-query] OK 已按预期失败 | ${error instanceof Error ? error.message : String(error)}`);
}
