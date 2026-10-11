/**
 * web_fetch 冒烟：访问若干公开网页，验证端到端链路与 SSRF 拦截。
 * 只使用公开地址；不读取任何密钥环境变量，不访问系统密钥库。
 *
 * 用法：node tests/smoke.mjs
 */

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;

const tools = [];
plugin({ registerTool: (tool) => tools.push(tool), registerCommand: () => undefined }, {});
const tool = tools[0];
if (!tool) throw new Error("扩展没有注册任何工具");

console.log(`[1] 工具名: ${tool.name} | label: ${tool.label}`);
console.log(`[1] 参数: ${Object.keys(tool.parameters.properties).join(", ")}`);

const cases = [
	["HTML 文档", { url: "https://pi.dev/docs/latest/extensions" }],
	["Markdown 直读", { url: "https://raw.githubusercontent.com/anomalyco/opencode/v2.0.13/README.md" }],
	["GitHub README", { url: "https://github.com/searxng/searxng" }],
	["example.com", { url: "https://example.com/" }],
	["text 模式", { url: "https://pi.dev/docs/latest/extensions", mode: "text", maxChars: 4000 }],
];

for (const [label, params] of cases) {
	const startedAt = Date.now();
	try {
		const result = await tool.execute("smoke", params);
		const details = result.details ?? {};
		const text = result.content?.[0]?.text ?? "";
		assert.equal(details.statusCode, 200);
		assert.equal(details.provider, "direct");
		assert.ok(text.trim().length > 0, "正文必须非空");
		assert.ok(text.length <= (params.maxChars ?? 24000), "包括截断提示在内也不得超限");
		assert.equal(details.extractedChars, text.length);
		console.log(
			`\n[${label}] OK ${Date.now() - startedAt}ms | status=${details.statusCode} | provider=${details.provider} | chars=${details.extractedChars} | truncated=${details.truncated} | redirects=${details.redirectCount}`,
		);
		console.log(`[${label}] 开头：${result.content?.[0]?.text?.slice(0, 200).replace(/\s+/gu, " ") ?? "无正文"}`);
	} catch (error) {
		process.exitCode = 1;
		console.log(`\n[${label}] FAIL ${Date.now() - startedAt}ms | ${error?.kind ?? error?.name}: ${String(error?.message ?? error).slice(0, 120)}`);
	}
}

// SSRF 必须全部被拒绝；任何一条放行都视为失败。
const blocked = [
	"http://127.0.0.1/x",
	"http://localhost/x",
	"http://169.254.169.254/latest/meta-data/",
	"http://10.0.0.5/",
	"http://192.168.1.1/",
	"http://[::1]/",
	"http://[fc00::1]/",
	"file:///etc/passwd",
	"ftp://example.com/",
	"https://user:pass@example.com/",
	"http://example.com:8080/",
];
for (const url of blocked) {
	try {
		await tool.execute("ssrf", { url });
		process.exitCode = 1;
		console.log(`[SSRF] FAIL 未拦截 ${url}`);
	} catch (error) {
		const kind = error?.kind ?? error?.name;
		if (kind !== "blocked_url" && kind !== "invalid_url") {
			process.exitCode = 1;
			console.log(`[SSRF] FAIL ${url} 分类为 ${kind}，预期 blocked_url`);
			continue;
		}
		console.log(`[SSRF] OK ${url} -> ${kind}`);
	}
}

console.log("\n[安全检查] 本脚本不读取任何密钥环境变量，也不访问系统密钥库。");
