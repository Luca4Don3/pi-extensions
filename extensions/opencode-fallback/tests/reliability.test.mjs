import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createOpencodeFallbackFetch, ROUTING_BODY_MAX_BYTES, ROUTING_BODY_TIMEOUT_MS } = await createJiti(import.meta.url).import("../index.ts");
const messages = "https://opencode.ai/v1/messages";
const models = "https://opencode.ai/v1/models";
const json = (model) => JSON.stringify({ model });
const coded = (code) => Object.assign(new Error(code), { cause: { code } });
function setup(error) {
	const seen = [];
	const wrapped = createOpencodeFallbackFetch(async (input, init) => {
		seen.push({ input, init });
		if (error) throw error;
		return new Response("ok");
	}, { name: "direct" }, { name: "proxy" });
	return { seen, wrapped };
}

for (const error of [
	...['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'].map(coded),
	new TypeError("fetch failed"), new Error("unknown"),
]) {
	test(`POST 错误只发送一次：${error.message}`, async () => {
		const { seen, wrapped } = setup(error);
		await assert.rejects(wrapped(messages, { method: "POST", body: json("minimax-m3") }), (value) => value === error);
		assert.equal(seen.length, 1);
		assert.equal(seen[0].init.dispatcher.name, "direct");
	});
}

for (const method of ["GET", "HEAD", "OPTIONS"]) {
	test(`安全方法允许明确建连前错误回退：${method}`, async () => {
		const seen = [];
		const wrapped = createOpencodeFallbackFetch(async (_input, init) => {
			seen.push(init.dispatcher.name);
			if (seen.length === 1) throw coded("ECONNREFUSED");
			return new Response();
		}, {}, {});
		await wrapped(new Request(models, { method }));
		assert.equal(seen.length, 2);
	});
}

for (const code of ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET']) {
	test(`安全方法不重试不确定错误：${code}`, async () => {
		const { seen, wrapped } = setup(coded(code));
		await assert.rejects(wrapped(models));
		assert.equal(seen.length, 1);
	});
}

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
	test(`非安全方法不回退：${method}`, async () => {
		const { seen, wrapped } = setup(coded("ECONNREFUSED"));
		await assert.rejects(wrapped(models, { method }));
		assert.equal(seen.length, 1);
	});
}

test("已消费或锁定 Request 正文在路由前失败", async () => {
	for (const locked of [false, true]) {
		const request = new Request(messages, { method: "POST", body: json("claude-opus-4") });
		const reader = locked ? request.body.getReader() : undefined;
		if (!locked) await request.text();
		const { seen, wrapped } = setup();
		await assert.rejects(wrapped(request));
		assert.equal(seen.length, 0);
		reader?.releaseLock();
	}
});

test("不可复用的 Request 和安全方法附带正文不回退", async () => {
	const request = new Request(models, { method: "POST", body: "x" });
	await request.text();
	for (const [input, init] of [[request, { method: "GET" }], [models, { method: "GET", body: "x" }]]) {
		const { seen, wrapped } = setup(coded("ECONNREFUSED"));
		await assert.rejects(wrapped(input, init));
		assert.equal(seen.length, 1);
	}
});

for (const encode of [value => value, value => Buffer.from(value), value => new Uint8Array(Buffer.from(value)), value => new Blob([value])]) {
	test("常见正文类型与覆盖语义", async () => {
		for (const [model, expected] of [["claude-opus-4", "proxy"], ["qwen3.8-max", "direct"]]) {
			const request = new Request(messages, { method: "POST", body: json("minimax-m3") });
			const body = encode(json(model));
			const { seen, wrapped } = setup();
			await wrapped(request, { body });
			assert.equal(seen[0].init.dispatcher.name, expected);
			assert.equal(seen[0].init.body, body);
			assert.equal(await request.text(), json("minimax-m3"));
		}
	});
}

test("null 或 undefined 正文覆盖继承 Request 正文", async () => {
	for (const body of [null, undefined]) {
		const { seen, wrapped } = setup();
		await wrapped(new Request(messages, { method: "POST", body: json("claude-opus-4") }), { body });
		assert.equal(seen[0].init.dispatcher.name, "proxy");
	}
});

test("缺失、未知与不可识别模型固定代理", async () => {
	for (const body of [undefined, "bad", "null", "{}", json("future-model"), new URLSearchParams("model=claude-opus-4"), new ReadableStream()]) {
		const { seen, wrapped } = setup();
		await wrapped(messages, { method: "POST", body });
		assert.equal(seen[0].init.dispatcher.name, "proxy");
	}
});

test("各种正文形态超限均不发请求", async () => {
	const oversized = "x".repeat(ROUTING_BODY_MAX_BYTES + 1);
	for (const body of [oversized, Buffer.from(oversized), new Blob([oversized])]) {
		const { seen, wrapped } = setup();
		await assert.rejects(wrapped(messages, { method: "POST", body }), /too large/);
		assert.equal(seen.length, 0);
	}
	const { seen, wrapped } = setup();
	await assert.rejects(wrapped(new Request(messages, { method: "POST", body: oversized })), /too large/);
	assert.equal(seen.length, 0);
});

class StreamBlob extends Blob {
	constructor(stream) { super([]); this.source = stream; }
	stream() { return this.source; }
}

test("迟滞正文按独立期限退出，取消永不完成也不阻塞", async () => {
	let cancelled = false;
	const body = new StreamBlob(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }));
	const { seen, wrapped } = setup();
	const start = Date.now();
	await assert.rejects(wrapped(messages, { method: "POST", body }), /timeout/);
	assert.ok(Date.now() - start < ROUTING_BODY_TIMEOUT_MS + 1000);
	assert.equal(cancelled, true);
	assert.equal(seen.length, 0);
});

test("正文等待期间取消，迟到读取及取消拒绝均被处理", async () => {
	const controller = new AbortController();
	const body = new StreamBlob(new ReadableStream({ cancel() { return Promise.reject(new Error("late cancel")); } }));
	const { seen, wrapped } = setup();
	const pending = wrapped(messages, { method: "POST", body, signal: controller.signal });
	controller.abort();
	await assert.rejects(pending, /abort/i);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(seen.length, 0);
});

for (const failure of ["timeout", "too large", "abort", "fragmented"]) {
	test(`Request 路由失败 ${failure} 自动取消源并清理生产器`, async () => {
		let cancelled = false;
		let producer;
		const source = new ReadableStream({
			start() { producer = setInterval(() => {}, 10); },
			pull(controller) {
				if (failure === "too large") controller.enqueue(new Uint8Array(ROUTING_BODY_MAX_BYTES + 1));
				if (failure === "fragmented") controller.enqueue(new Uint8Array());
			},
			cancel() {
				cancelled = true;
				clearInterval(producer);
				return failure === "timeout" ? new Promise(() => {}) : Promise.reject(new Error("late source cancel"));
			},
		});
		const request = new Request(messages, { method: "POST", body: source, duplex: "half" });
		const controller = new AbortController();
		const { seen, wrapped } = setup();
		try {
			const pending = wrapped(request, { signal: controller.signal });
			if (failure === "abort") setImmediate(() => controller.abort());
			await assert.rejects(pending, new RegExp(failure, "i"));
			await new Promise(resolve => setImmediate(resolve));
			assert.equal(cancelled, true);
			assert.equal(seen.length, 0);
		} finally {
			clearInterval(producer);
		}
	});
}

test("init.signal 为 null 覆盖 Request 的已取消信号并保留可发送正文", async () => {
	const controller = new AbortController();
	const request = new Request(messages, { method: "POST", body: json("claude-opus-4"), signal: controller.signal });
	controller.abort();
	const { seen, wrapped } = setup();
	await wrapped(request, { signal: null });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].init.signal, null);
	assert.equal(seen[0].init.dispatcher.name, "proxy");
	assert.equal(await request.text(), json("claude-opus-4"));
});

test("init.signal 为 null 时已取消的 Request 仍允许安全请求回退", async () => {
	const controller = new AbortController();
	const request = new Request(models, { signal: controller.signal });
	controller.abort();
	const seen = [];
	const wrapped = createOpencodeFallbackFetch(async (_input, init) => {
		seen.push(init);
		if (seen.length === 1) throw coded("ECONNREFUSED");
		return new Response("ok");
	}, { name: "direct" }, { name: "proxy" });
	await wrapped(request, { signal: null });
	assert.deepEqual(seen.map(init => init.dispatcher.name), ["direct", "proxy"]);
	assert.ok(seen.every(init => init.signal === null));
});

test("无限空分块受到分块数或期限限制", async () => {
	const body = new StreamBlob(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array()); } }));
	const { seen, wrapped } = setup();
	await assert.rejects(wrapped(messages, { method: "POST", body }), /fragmented|timeout/);
	assert.equal(seen.length, 0);
});

test("字符串按字节而不是字符限制，字节视图只读取有效范围", async () => {
	const { seen, wrapped } = setup();
	await assert.rejects(wrapped(messages, { method: "POST", body: "中".repeat(Math.ceil(ROUTING_BODY_MAX_BYTES / 3)) }), /too large/);
	assert.equal(seen.length, 0);
	const payload = Buffer.from(json("claude-opus-4"));
	const storage = Buffer.concat([Buffer.from("prefix"), payload, Buffer.from("suffix")]);
	await wrapped(messages, { method: "POST", body: storage.subarray(6, 6 + payload.length) });
	assert.equal(seen[0].init.dispatcher.name, "proxy");
});
