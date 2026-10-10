/**
 * 冒烟测试：mock Pi 的 ExtensionAPI，直接调用 web_search 的 execute。
 * 默认仅测试四个匿名 provider 与 auto；计费通道须双重显式授权。
 *
 * 该脚本需要真实外网，不适合放进 CI；离线断言请用 tests/mock.test.mjs。
 * 用法：node tests/smoke.mjs [--billable]
 */

import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--billable") || args.filter((arg) => arg === "--billable").length > 1) {
	throw new Error("仅支持可选参数 --billable");
}
const billableOptIn = args.includes("--billable");
const jiti = createJiti(import.meta.url);
const routingModule = await jiti.import(fileURLToPath(new URL("../routing.ts", import.meta.url)));
const registry = await jiti.import(fileURLToPath(new URL("../search/registry.ts", import.meta.url)));
const { readRoutingConfig } = routingModule;
const { ANONYMOUS_PROVIDER_ORDER, PROVIDER_IDS, PROVIDERS } = registry;

// 计费模式必须先由当前环境配置授权，再由 CLI 单独确认；key-first 仅用于这次显式冒烟。
if (billableOptIn) {
	const configuredRouting = readRoutingConfig(process.env);
	if (!configuredRouting.allowBillable) {
		throw new Error("--billable 需要现有 PI_WEB_SEARCH_ALLOW_BILLABLE=true 或兼容别名 PI_WEB_SEARCH_ALLOW_PAID=true");
	}
	process.env.PI_WEB_SEARCH_ALLOW_BILLABLE = "true";
	delete process.env.PI_WEB_SEARCH_ALLOW_PAID;
	process.env.PI_WEB_SEARCH_ROUTING = "key-first";
	console.log("[安全提示] 已显式启用 --billable 与计费路由授权；密钥优先搜索可能产生费用，不会输出密钥值。");
} else {
	// 覆盖本机既有授权，确保默认运行绝不进入计费路由。
	process.env.PI_WEB_SEARCH_ALLOW_BILLABLE = "false";
	delete process.env.PI_WEB_SEARCH_ALLOW_PAID;
	console.log("[安全模式] 默认仅匿名搜索；计费通道已禁用，系统密钥库由不可用模拟器替代。");
}
const routingConfig = readRoutingConfig(process.env);
if (routingConfig.allowBillable !== billableOptIn) throw new Error("冒烟测试路由授权状态与 CLI 选择不一致");

const keyEnvNames = PROVIDER_IDS.map((provider) => PROVIDERS[provider].envVar);
const secrets = billableOptIn
	? keyEnvNames.map((name) => process.env[name]).filter((value) => typeof value === "string" && value.length > 0)
	: [];
const sanitize = (value) => {
	let text = String(value);
	for (const secret of secrets) {
		text = text.split(secret).join("[已脱敏]");
		try {
			text = text.split(encodeURIComponent(secret)).join("[已脱敏]");
		} catch {
			// 非法 URI 字符串的原文仍已脱敏。
		}
	}
	return text;
};

let keyEnvReads = 0;
const originalEnv = process.env;
process.env = new Proxy(originalEnv, {
	get(target, property, receiver) {
		if (keyEnvNames.includes(property)) {
			keyEnvReads++;
			if (!billableOptIn) throw new Error("匿名冒烟测试不得读取密钥环境变量");
		}
		return Reflect.get(target, property, receiver);
	},
});

const module_ = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = module_.default ?? module_;

const tools = [];
let storeReads = 0;
const noSystemStore = {
	kind: "none",
	read: async () => {
		storeReads++;
		return { status: "unavailable", reason: "冒烟测试不访问系统密钥库" };
	},
	write: async () => ({ status: "unavailable", reason: "冒烟测试不写入凭据" }),
	clear: async () => ({ status: "unavailable", reason: "冒烟测试不访问系统密钥库" }),
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
			`\n[${label}] OK ${Date.now() - startedAt}ms | provider=${details.provider} | channel=${details.channel} | accessTier=${details.accessTier} | sources=${details.sourceCount} | truncated=${details.truncated}`,
		);
		console.log(`[${label}] 正文前 400 字:\n${sanitize(text.slice(0, 400))}`);
		console.log(`[${label}] 首条来源: ${sanitize(details.sources?.[0]?.url ?? "无")}`);
	} catch (error) {
		process.exitCode = 1;
		console.log(`\n[${label}] FAIL ${Date.now() - startedAt}ms | ${sanitize(error instanceof Error ? error.message : String(error))}`);
	}
}

for (const provider of ANONYMOUS_PROVIDER_ORDER) {
	await run(provider, { query: "Pi coding agent extension registerTool API", maxResults: 3, provider });
}
// SerpApi 没有匿名通道；仅在双重 opt-in 且环境已配置时测试它。
if (billableOptIn && process.env[PROVIDERS.serpapi.envVar]) {
	await run("serpapi", { query: "Pi coding agent extension registerTool API", maxResults: 2, provider: "serpapi" });
}
await run("auto", { query: "TypeScript 5.7 新特性", maxResults: 2 });

// 参数校验路径：空 query 必须显式失败，漏报也会使进程以失败状态退出。
try {
	await tool.execute("smoke-2", { query: "   " }, undefined, undefined, {});
	console.log("\n[empty-query] FAIL 未按预期抛错");
	process.exitCode = 1;
} catch (error) {
	console.log(`\n[empty-query] OK 已按预期失败 | ${sanitize(error instanceof Error ? error.message : String(error))}`);
}

if (!billableOptIn && keyEnvReads !== 0) {
	console.log(`[安全检查] FAIL 匿名模式读取了 ${keyEnvReads} 个密钥环境变量`);
	process.exitCode = 1;
}
if (!billableOptIn && storeReads !== 0) {
	console.log(`[安全检查] FAIL 匿名模式读取了 ${storeReads} 次密钥库`);
	process.exitCode = 1;
}
