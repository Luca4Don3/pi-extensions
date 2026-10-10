/** 生产 MaskedInput 的离线交互与安全渲染测试。 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

for (const key of [
	"EXA_API_KEY",
	"PARALLEL_API_KEY",
	"TAVILY_API_KEY",
	"SERPAPI_API_KEY",
	"PI_WEB_SEARCH_ROUTING",
	"PI_WEB_SEARCH_ALLOW_PAID",
]) {
	delete process.env[key];
}

const jiti = createJiti(import.meta.url);
const { MaskedInput } = await jiti.import(fileURLToPath(new URL("../masked-input.ts", import.meta.url)));
const { visibleWidth } = await jiti.import("@earendil-works/pi-tui");

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const SECRET = "mask_test_SUPER_SECRET_42";

function rendered(component, width = 80) {
	return component.render(width).join("\n");
}

test("MaskedInput：字符编辑、退格、左右光标与清空后可提交", () => {
	let submitted;
	const input = new MaskedInput("标题中的 key 字样不是秘密", (value) => (submitted = value));
	for (const char of SECRET) input.handleInput(char);
	assert.ok(!rendered(input).includes(SECRET), "渲染中不能出现明文");
	assert.match(rendered(input), /\*/u, "输入应显示掩码");

	input.handleInput("\x1b[D"); // 左
	input.handleInput("\x7f"); // 退格
	input.handleInput("\x1b[C"); // 右
	input.handleInput("Z");
	input.handleInput("\x15"); // Ctrl+U 清空
	input.handleInput("final-token");
	input.handleInput("\r");
	assert.equal(submitted, "final-token");
	assert.ok(!rendered(input).includes("final-token"), "提交后组件应已清除输入状态");
});

test("MaskedInput：终端 0、1、2、5、80 列及异常宽度均不越界", () => {
	const input = new MaskedInput("very long API key title for narrow terminals", () => undefined);
	input.focused = true;
	input.handleInput("x".repeat(180));
	for (const width of [0, 1, 2, 5, 80, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		for (const [index, line] of input.render(width).entries()) {
			assert.ok(visibleWidth(line) <= Math.max(0, Number.isFinite(width) ? Math.floor(width) : 0), `第 ${index} 行越过 ${width} 列`);
		}
	}
});

test("MaskedInput：Kitty 可打印输入会解码为凭据字符", () => {
	let submitted;
	const input = new MaskedInput("Kitty key", (value) => (submitted = value));
	input.handleInput("\x1b[107;1u"); // Kitty CSI-u 中的字母 k
	assert.ok(!input.render(80)[1].includes("k"), "可打印输入也只能显示掩码");
	input.handleInput("\r");
	assert.equal(submitted, "k");
});

test("MaskedInput：粘贴结束标记跨数据块时完整识别并提交", () => {
	let submitted;
	const input = new MaskedInput("粘贴 key", (value) => (submitted = value));
	input.handleInput(`${PASTE_START}${SECRET}\x1b[20`);
	assert.equal(submitted, undefined, "结束标记未完整到达前不能提交");
	assert.ok(!rendered(input).includes(SECRET), "粘贴缓存不能进入渲染");
	input.handleInput("1~");
	assert.equal(submitted, undefined, "粘贴完成不应绕过回车确认");
	input.handleInput("\r");
	assert.equal(submitted, SECRET);
	assert.ok(!rendered(input).includes(SECRET));
});

test("MaskedInput：粘贴中的控制字符和换行整体拒绝且不提交", () => {
	for (const invalid of [`line1\nline2`, `control\x01char`, `line1\rline2`]) {
		let submissions = 0;
		const input = new MaskedInput("paste key", () => (submissions += 1));
		input.handleInput(`${PASTE_START}${invalid}${PASTE_END}`);
		input.handleInput("\r");
		assert.equal(submissions, 0, "非法粘贴不能提交");
		assert.match(rendered(input), /密钥须为非空/u);
	}
});

test("MaskedInput：超长粘贴整体拒绝，不截断为部分密钥", () => {
	let submitted;
	const input = new MaskedInput("oversized key", (value) => (submitted = value));
	input.handleInput(`${PASTE_START}${"x".repeat(4097)}${PASTE_END}`);
	input.handleInput("\r");
	assert.equal(submitted, undefined);
	assert.ok(!input.render(80)[1].includes("*"), "拒绝后不能留下被截断的部分密钥掩码");
	assert.match(rendered(input), /最多 4096 个字符/u);
});

test("MaskedInput：取消或 dispose 后 render 不含明文及残留掩码", () => {
	let cancelled;
	const input = new MaskedInput("标题包含 key 字样", (value) => (cancelled = value));
	input.handleInput(SECRET);
	assert.ok(input.render(80)[1].includes("*"));
	input.handleInput("\x1b");
	assert.equal(cancelled, undefined);
	assert.ok(!rendered(input).includes(SECRET));
	assert.ok(!input.render(80)[1].includes("*"), "取消后不能残留掩码");
	input.handleInput("late-input");
	assert.ok(!input.render(80)[1].includes("*"), "关闭后输入不能重新留下掩码");

	const disposed = new MaskedInput("dispose key", () => undefined);
	disposed.handleInput(SECRET);
	disposed.dispose();
	assert.ok(!rendered(disposed).includes(SECRET));
	assert.ok(!disposed.render(80)[1].includes("*"), "dispose 后不能残留掩码");
});

test("生产 MaskedInput 不依赖普通 Input 或 undo", () => {
	const source = readFileSync(new URL("../masked-input.ts", import.meta.url), "utf8");
	assert.ok(!/\bnew\s+Input\b|\.undo\s*\(/u.test(source));
});
