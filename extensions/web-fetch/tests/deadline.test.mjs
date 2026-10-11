import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const deadlineModule = await jiti.import(fileURLToPath(new URL("../transport/deadline.ts", import.meta.url)));
const errors = await jiti.import(fileURLToPath(new URL("../errors.ts", import.meta.url)));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

test("超时会 race 不配合 signal 的永不完成操作", async () => {
	const deadline = deadlineModule.createFetchDeadline(20);
	const started = Date.now();
	await assert.rejects(deadline.run(() => new Promise(() => undefined)), (error) => error.kind === "timeout");
	assert.ok(Date.now() - started < 300);
	assert.equal(deadline.signal.reason.kind, "timeout");
	deadline.dispose();
});

test("外部取消时不启动操作，并给 signal 写入安全 FetchError", async () => {
	const external = new AbortController();
	external.abort(new Error("secret upstream reason"));
	const deadline = deadlineModule.createFetchDeadline(1_000, external.signal);
	let started = false;
	assert.throws(() => deadline.check(), (error) => error.kind === "aborted");
	await assert.rejects(deadline.run(() => { started = true; return 1; }), (error) => error.kind === "aborted");
	assert.equal(started, false);
	assert.ok(deadline.signal.reason instanceof errors.FetchError);
	assert.equal(deadline.signal.reason.kind, "aborted");
	deadline.dispose();
});

test("父截止信号以 timeout 取消时，子 deadline 保留 timeout 分类", () => {
	const parent = new AbortController();
	parent.abort(new errors.FetchError("timeout", "timeout"));
	const child = deadlineModule.createFetchDeadline(1_000, parent.signal);
	assert.throws(() => child.check(), (error) => error.kind === "timeout");
	assert.equal(child.signal.reason.kind, "timeout");
	child.dispose();
});

test("绝对 deadlineMs 不因再次创建 deadline 而重置", async () => {
	const absolute = performance.now() + 35;
	const deadline = deadlineModule.createFetchDeadline(10_000, undefined, absolute);
	assert.equal(deadline.deadlineMs, absolute);
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.throws(() => deadline.check(), (error) => error.kind === "timeout");
	deadline.dispose();
});

test("迟到拒绝会被消费，且取消后 run 立即失败", async () => {
	const operation = deferred();
	const deadline = deadlineModule.createFetchDeadline(15);
	await assert.rejects(deadline.run(() => operation.promise), (error) => error.kind === "timeout");
	operation.reject(new Error("late rejection"));
	await new Promise((resolve) => setTimeout(resolve, 10));
	deadline.dispose();
});

test("同步成功、同步抛错与 dispose 正常工作", async () => {
	const deadline = deadlineModule.createFetchDeadline(1_000);
	assert.equal(await deadline.run(() => 42), 42);
	await assert.rejects(deadline.run(() => { throw new Error("operation failed"); }), /operation failed/u);
	deadline.dispose();
});
