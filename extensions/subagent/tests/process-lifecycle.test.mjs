/**
 * process-lifecycle 的离线单元测试。
 *
 * 只测等待与取消这一小段生命周期契约，不启动真实 pi 进程：
 * 取消时必须先发 SIGTERM、只在进程仍未退出时才升级 SIGKILL，
 * 并且任何情况下都不能把已结束的进程改写成「已取消」。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { waitForProcess } = await jiti.import(fileURLToPath(new URL("../process-lifecycle.ts", import.meta.url)));

/** 伪造的最小 ChildProcess：只保留退出码、信号码与信号上报三个语义。 */
function createFakeProcess() {
	const proc = new EventEmitter();
	proc.signalCalls = [];
	proc.exitCode = null;
	proc.signalCode = null;
	// `killed` 只表示发过信号，不能据此判断是否退出，所以这里跟踪真实状态。
	proc.killed = false;
	proc.kill = (signal) => {
		proc.signalCalls.push(signal);
		proc.killed = true;
		return true;
	};
	proc.close = (code, signal = null) => {
		proc.exitCode = code;
		proc.signalCode = signal;
		proc.emit("exit", code, signal);
		proc.emit("close", code, signal);
	};
	return proc;
}

test("进程正常退出时按退出码 resolve，onClose 只回调一次", async () => {
	const proc = createFakeProcess();
	let closes = 0;
	const pending = waitForProcess(proc, undefined, () => {
		closes += 1;
	});
	proc.close(3);
	assert.equal(await pending, 3);
	assert.equal(closes, 1);
});

test("传入时进程已退出，直接按退出码结算", async () => {
	const proc = createFakeProcess();
	proc.close(7);
	// exit / close 事件在注册监听之前就丢了，只剩退出码可用。
	const pending = waitForProcess(proc);
	assert.equal(await pending, 7);
});

test("spawn 失败记为退出码 1，不伪装成成功", async () => {
	const proc = createFakeProcess();
	const pending = waitForProcess(proc);
	proc.emit("error", new Error("spawn ENOENT"));
	assert.equal(await pending, 1);
});

test("取消时先发 SIGTERM，进程仍未退出才升级 SIGKILL", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const proc = createFakeProcess();
	const controller = new AbortController();
	const pending = waitForProcess(proc, controller.signal);
	controller.abort();
	assert.deepEqual(proc.signalCalls, ["SIGTERM"]);

	t.mock.timers.tick(4999);
	assert.deepEqual(proc.signalCalls, ["SIGTERM"], "宽限期未满不应升级");

	t.mock.timers.tick(1);
	assert.deepEqual(proc.signalCalls, ["SIGTERM", "SIGKILL"], "忽略 SIGTERM 的进程必须被升级强杀");

	proc.close(null, "SIGKILL");
	await assert.rejects(pending, /Subagent was aborted/);
});

test("取消后进程在宽限期内退出，不再补发信号", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const proc = createFakeProcess();
	const controller = new AbortController();
	const pending = waitForProcess(proc, controller.signal);
	controller.abort();
	proc.close(0);
	assert.deepEqual(proc.signalCalls, ["SIGTERM"]);

	t.mock.timers.tick(6000);
	assert.deepEqual(proc.signalCalls, ["SIGTERM"], "已退出的进程不应再收到信号");
	await assert.rejects(pending, /Subagent was aborted/);
});

test("进程退出之后的取消不再改写结果，也不再发信号", async () => {
	const proc = createFakeProcess();
	const controller = new AbortController();
	const pending = waitForProcess(proc, controller.signal);
	proc.close(0);
	assert.equal(await pending, 0);

	controller.abort();
	assert.equal(await pending, 0, "结束后的取消不能推翻退出结果");
	assert.deepEqual(proc.signalCalls, [], "结束后的取消不应再触达进程");
});

test("启动时信号已取消，立即发起终止并拒绝", async () => {
	const proc = createFakeProcess();
	const controller = new AbortController();
	controller.abort();
	const pending = waitForProcess(proc, controller.signal);
	assert.deepEqual(proc.signalCalls, ["SIGTERM"]);
	proc.close(0);
	await assert.rejects(pending, /Subagent was aborted/);
});
