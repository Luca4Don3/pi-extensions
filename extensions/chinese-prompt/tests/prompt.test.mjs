/**
 * chinese-prompt 离线测试
 *
 * 只加载 index.ts，捕获 before_agent_start 处理器，验证：
 * - user / custom 两种事件都注入规则（Pi 1.2 起的联合类型）
 * - 已注入的 systemPrompt 不重复追加
 * - 空 systemPrompt 也能安全注入
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const module_ = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));

let handler;
module_.default({
	on: (event, fn) => {
		if (event === "before_agent_start") handler = fn;
	},
});

assert.equal(typeof handler, "function", "必须注册 before_agent_start 处理器");

test("user 事件追加中文规则", async () => {
	const result = await handler({ messageType: "user", systemPrompt: "base", prompt: "hi" });
	assert.match(result.systemPrompt, /## 语言铁律/);
	assert.match(result.systemPrompt, /简体中文/);
});

test("custom 事件同样追加中文规则", async () => {
	const result = await handler({ messageType: "custom", systemPrompt: "base", message: {} });
	assert.match(result.systemPrompt, /## 语言铁律/);
});

test("已注入时不重复追加", async () => {
	const once = await handler({ messageType: "user", systemPrompt: "base", prompt: "hi" });
	const twice = await handler({ messageType: "user", systemPrompt: once.systemPrompt, prompt: "again" });
	assert.equal(twice.systemPrompt, once.systemPrompt);
});

test("空 systemPrompt 也能安全注入", async () => {
	const result = await handler({ messageType: "user", systemPrompt: undefined, prompt: "hi" });
	assert.equal(typeof result.systemPrompt, "string");
	assert.match(result.systemPrompt, /## 语言铁律/);
});
