/**
 * subagent 的 agent 发现逻辑离线测试（agents.ts）
 *
 * 只测 discoverAgents / formatAgentList 这两个纯函数，
 * 不加载 index.ts（避免依赖 spawn pi 进程与 TUI）。
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const module_ = await jiti.import(fileURLToPath(new URL("../agents.ts", import.meta.url)));
const { discoverAgents, formatAgentList } = module_;

function agentMarkdown(name, extraFrontmatter = "") {
	return `---\nname: ${name}\ndescription: ${name} desc\ntools: read, grep\nmaxOutputChars: 1234\n${extraFrontmatter}---\n\n你是一个测试 agent。\n`;
}

function makeProject(files) {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content, "utf8");
	return root;
}

test("1. project scope 解析 frontmatter 各字段", () => {
	const root = makeProject({
		"alpha.md": agentMarkdown("alpha"),
		"beta.md": agentMarkdown("beta", "model: test/model\n"),
	});
	const result = discoverAgents(root, "project");
	assert.deepEqual(
		result.agents.map((agent) => agent.name).sort(),
		["alpha", "beta"],
	);
	const beta = result.agents.find((agent) => agent.name === "beta");
	assert.equal(beta.model, "test/model");
	assert.deepEqual(beta.tools, ["read", "grep"]);
	assert.equal(beta.maxOutputChars, 1234);
	assert.equal(beta.source, "project");
	assert.match(beta.systemPrompt, /你是一个测试 agent/);
});

test("2. 缺少 name 或 description 的文件被跳过", () => {
	const root = makeProject({
		"ok.md": agentMarkdown("ok"),
		"bad.md": "---\ndescription: 只有描述\n---\n正文\n",
	});
	const result = discoverAgents(root, "project");
	assert.deepEqual(
		result.agents.map((agent) => agent.name),
		["ok"],
	);
});

test("3. 非 md 文件被忽略", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
	const dir = join(root, ".pi", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "notes.txt"), "x", "utf8");
	writeFileSync(join(dir, "a.md"), agentMarkdown("a"), "utf8");
	const result = discoverAgents(root, "project");
	assert.deepEqual(
		result.agents.map((agent) => agent.name),
		["a"],
	);
});

test("4. 从深层目录向上查找 .pi/agents", () => {
	const root = makeProject({ "up.md": agentMarkdown("up") });
	const nested = join(root, "a", "b", "c");
	mkdirSync(nested, { recursive: true });
	const result = discoverAgents(nested, "project");
	assert.deepEqual(
		result.agents.map((agent) => agent.name),
		["up"],
	);
	assert.equal(result.projectAgentsDir, join(root, ".pi", "agents"));
});

test("5. scope=user 时不返回 project agents", () => {
	const root = makeProject({ "p.md": agentMarkdown("p") });
	const result = discoverAgents(root, "user");
	assert.equal(
		result.agents.some((agent) => agent.name === "p"),
		false,
	);
});

test("6. 没有 agents 目录时返回空列表且不抛错", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
	const result = discoverAgents(root, "project");
	assert.deepEqual(result.agents, []);
	assert.equal(result.projectAgentsDir, null);
});

test("7. formatAgentList 的列表与剩余计数", () => {
	const agents = Array.from({ length: 5 }, (_, index) => ({
		name: `a${index}`,
		description: `d${index}`,
		source: "user",
		systemPrompt: "",
		filePath: "",
	}));
	const all = formatAgentList(agents, 10);
	assert.match(all.text, /a0/);
	assert.equal(all.remaining, 0);

	const limited = formatAgentList(agents, 2);
	assert.equal(limited.remaining, 3);
	assert.equal(limited.text.split("; ").length, 2);

	assert.deepEqual(formatAgentList([], 5), { text: "none", remaining: 0 });
});

// ---- 注册契约：调用决策指南必须保持双向（既有「何时用」也有「何时不用」）----

const indexModule = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const registeredTools = [];
indexModule.default({ registerTool: (tool) => registeredTools.push(tool) });
const subagentTool = registeredTools[0];

test("8. 注册 subagent 工具并暴露决策指南", () => {
	assert.equal(subagentTool.name, "subagent");
	assert.equal(typeof subagentTool.promptSnippet, "string");
	assert.ok(Array.isArray(subagentTool.promptGuidelines));
	assert.ok(subagentTool.promptGuidelines.length >= 6, "指南条目过少，判断标准不完整");
});

test("9. 指南必须同时给出「该用」与「不该用」的判据", () => {
	const text = [subagentTool.promptSnippet, subagentTool.description, ...subagentTool.promptGuidelines].join("\n");
	assert.match(text, /do the work directly|Do it yourself/i, "缺少「直接自己做」的判据");
	assert.match(text, /already in your context/i, "缺少「答案已在上下文」的判据");
	assert.match(text, /cannot see your conversation/i, "缺少「子 agent 看不到主对话」的提示");
	assert.match(text, /Do not delegate|Do not run a chain/i, "缺少反向约束");
});

test("10. 指南不得再出现过强鼓励委派的措辞", () => {
	const text = [subagentTool.promptSnippet, subagentTool.description, ...subagentTool.promptGuidelines].join("\n");
	assert.doesNotMatch(text, /use subagents freely/i, "不应鼓励无条件使用");
	assert.doesNotMatch(text, /default flow for any feature work/i, "不应把 chain 当成默认流程");
	assert.doesNotMatch(text, /before making changes/i, "不应要求改动前一律委派");
});

test("11. description 必须包含成本与自包含要求", () => {
	assert.match(subagentTool.description, /cannot see your conversation/i);
	assert.match(subagentTool.description, /compressed summary/i);
	assert.match(subagentTool.description, /self-contained/i);
});

// ---- usage.ts：token 用量统计（纯函数，抽取后可独立测试）----

const usageModule = await jiti.import(fileURLToPath(new URL("../usage.ts", import.meta.url)));

test("12. createUsageStats 返回全零", () => {
	assert.deepEqual(usageModule.createUsageStats(), {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
		turns: 0,
	});
});

test("13. accumulateUsage 累加计数，上下文占用为覆盖而非累加", () => {
	const usage = usageModule.createUsageStats();
	usageModule.accumulateUsage(usage, {
		input: 100,
		output: 20,
		cacheRead: 5,
		cacheWrite: 3,
		cost: { total: 0.01 },
		totalTokens: 500,
	});
	usageModule.accumulateUsage(usage, { input: 50, output: 10, totalTokens: 700 });
	usageModule.accumulateUsage(usage, undefined); // 缺 usage 也要计一轮
	assert.equal(usage.turns, 3);
	assert.equal(usage.input, 150);
	assert.equal(usage.output, 30);
	assert.equal(usage.cacheRead, 5);
	assert.equal(usage.cacheWrite, 3);
	assert.equal(usage.cost, 0.01);
	assert.equal(usage.contextTokens, 700, "上下文占用应取最后一条消息的值");
});

test("14. aggregateUsage 汇总多次运行，且不累加上下文占用", () => {
	const a = usageModule.createUsageStats();
	usageModule.accumulateUsage(a, { input: 10, output: 1, cost: { total: 0.001 }, totalTokens: 100 });
	const b = usageModule.createUsageStats();
	usageModule.accumulateUsage(b, { input: 20, output: 2, cost: { total: 0.002 }, totalTokens: 200 });
	const total = usageModule.aggregateUsage([{ usage: a }, { usage: b }]);
	assert.equal(total.input, 30);
	assert.equal(total.output, 3);
	assert.equal(total.turns, 2);
	assert.ok(Math.abs(total.cost - 0.003) < 1e-9);
	assert.equal(total.contextTokens, 0);
});

test("15. formatUsageStats 输出各项且不产生空段", () => {
	const usage = usageModule.createUsageStats();
	usageModule.accumulateUsage(usage, {
		input: 3200,
		output: 840,
		cacheRead: 12000,
		cost: { total: 0.0031 },
		totalTokens: 16000,
	});
	const text = usageModule.formatUsageStats(usage, "test/model");
	assert.match(text, /1 turn\b/);
	assert.match(text, /↑3\.2k/);
	assert.match(text, /↓840/);
	assert.match(text, /R12k/);
	assert.match(text, /\$0\.0031/);
	assert.match(text, /ctx:16k/);
	assert.match(text, /test\/model/);
	assert.doesNotMatch(text, /\s{2,}/, "不应出现连续空格");
	assert.equal(usageModule.formatUsageStats(usageModule.createUsageStats()), "", "全零时返回空串");
});

test("16. formatTokens 的进制边界", () => {
	const f = usageModule.formatTokens;
	assert.equal(f(0), "0");
	assert.equal(f(999), "999");
	assert.equal(f(1000), "1.0k");
	assert.equal(f(9999), "10.0k");
	assert.equal(f(10000), "10k");
	assert.equal(f(999999), "1000k");
	assert.equal(f(1000000), "1.0M");
});
