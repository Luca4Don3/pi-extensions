import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const body = await jiti.import(fileURLToPath(new URL("../transport/response-body.ts", import.meta.url)));

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

test("GB18030 字符跨数据块增量解码", async () => {
	const chunks = [0xd6, 0xd0, 0xce, 0xc4].map((byte) => new Uint8Array([byte]));
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
	const response = new Response(stream, { headers: { "content-type": "text/plain; charset=GB18030" } });
	assert.equal(await body.readResponseTextLimited(response, 8), "中文");
});

test("无效字符集和 UTF-8 尾部残缺均明确失败", async () => {
	await assert.rejects(body.readResponseTextLimited(
		new Response("text", { headers: { "content-type": "text/plain; charset=no-such-charset" } }), 32,
	), (error) => error.kind === "unsupported_content");
	const truncated = new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array([0xe4, 0xb8])); controller.close(); },
	});
	await assert.rejects(body.readResponseTextLimited(new Response(truncated), 8), (error) => error.kind === "unsupported_content");
});

test("永不完成的 read 与 cancel 不阻塞外部取消", async () => {
	let cancelCalled = false;
	const stream = new ReadableStream({
		pull() { return new Promise(() => undefined); },
		cancel() { cancelCalled = true; return new Promise(() => undefined); },
	});
	const controller = new AbortController();
	const pending = body.readResponseTextLimited(new Response(stream), 8, controller);
	setTimeout(() => controller.abort(), 15);
	await assert.rejects(Promise.race([
		pending,
		new Promise((_, reject) => setTimeout(() => reject(new Error("读取未及时取消")), 150)),
	]), (error) => error.kind === "aborted");
	assert.equal(cancelCalled, true);
});

test("超限立即 abort 并调用 reader.cancel，不等待其挂起", async () => {
	let cancelCalled = false;
	const stream = new ReadableStream({
		start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
		cancel() { cancelCalled = true; return new Promise(() => undefined); },
	});
	const controller = new AbortController();
	await assert.rejects(Promise.race([
		body.readResponseTextLimited(new Response(stream), 1, controller),
		new Promise((_, reject) => setTimeout(() => reject(new Error("超限取消被挂起")), 150)),
	]), (error) => error.kind === "response_too_large");
	assert.equal(controller.signal.aborted, true);
	assert.equal(cancelCalled, true);
});

test("getReader 失败时中止底层请求并归类", async () => {
	const response = new Response("locked");
	const reader = response.body.getReader();
	const controller = new AbortController();
	await assert.rejects(body.readResponseTextLimited(response, 16, controller), (error) => error.kind === "network_error");
	assert.equal(controller.signal.aborted, true);
	reader.releaseLock();
});

test("读取前已取消时清理正文且不启动读取", async () => {
	let cancelCalled = false;
	const response = new Response(new ReadableStream({ cancel() { cancelCalled = true; } }));
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(body.readResponseTextLimited(response, 16, controller), (error) => error.kind === "aborted");
	assert.equal(cancelCalled, true);
});

test("read 的迟到拒绝在取消竞态后仍被消费", async () => {
	const pendingRead = deferred();
	let cancelCalled = false;
	const stream = new ReadableStream({
		pull() { return pendingRead.promise; },
		cancel() { cancelCalled = true; return new Promise(() => undefined); },
	});
	const controller = new AbortController();
	const pending = body.readResponseTextLimited(new Response(stream), 8, controller);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending, (error) => error.kind === "aborted");
	assert.equal(cancelCalled, true);
	pendingRead.reject(new Error("迟到的 read 错误"));
	await new Promise((resolve) => setTimeout(resolve, 10));
});
