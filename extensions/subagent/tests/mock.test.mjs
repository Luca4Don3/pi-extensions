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
