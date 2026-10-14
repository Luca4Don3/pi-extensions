/**
 * spawn 失败诊断的离线单元测试。
 *
 * 这些是纯函数，不启动任何进程，也不需要 TUI / 真实 Pi 安装。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { describeSpawnFailure } = await jiti.import(fileURLToPath(new URL("../spawn-failure.ts", import.meta.url)));

test("找不到 pi 时给出可行动诊断，而不是裸错误", () => {
	const message = describeSpawnFailure(Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" }), "pi");
	assert.match(message, /找不到可执行文件 pi/);
	assert.match(message, /PATH/);
	assert.doesNotMatch(message, /spawn pi ENOENT/, "不应原样回显系统错误文本");
});

test("权限问题与其它错误分别归类，都点明命令名", () => {
	assert.match(
		describeSpawnFailure(Object.assign(new Error("spawn pi EACCES"), { code: "EACCES" }), "pi"),
		/pi.*没有执行权限/,
	);
	const other = describeSpawnFailure(Object.assign(new Error("boom"), { code: "UNKNOWN" }), "node");
	assert.match(other, /无法启动 node/);
});

test("没有 message 的错误也不会打印 undefined", () => {
	const message = describeSpawnFailure(undefined, "pi");
	assert.match(message, /无法启动 pi/);
	assert.doesNotMatch(message, /undefined/);
});
