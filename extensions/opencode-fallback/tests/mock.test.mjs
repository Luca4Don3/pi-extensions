/**
 * opencode-fallback 离线测试
 *
 * 覆盖纯决策函数：请求识别、连接失败判定、direct → proxy 回退、以及代理地址解析。
 * 不发起任何真实网络请求。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const module_ = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const { isOpencodeRequest, isConnectionFailure, createOpencodeFallbackFetch, resolveProxyUrl, needsPinnedProxy } = module_;

const errWithCode = (code) => Object.assign(new Error("boom"), { code });

test("1. isOpencodeRequest 识别主机与子域，拒绝相似域名", () => {
	assert.equal(isOpencodeRequest("https://opencode.ai/zen/go/v1/chat/completions"), true);
	assert.equal(isOpencodeRequest("https://api.opencode.ai/v1"), true);
	assert.equal(isOpencodeRequest("https://opencode.ai."), true);
	assert.equal(isOpencodeRequest(new URL("https://opencode.ai/x")), true);
	assert.equal(isOpencodeRequest({ url: "https://opencode.ai/y" }), true);
	assert.equal(isOpencodeRequest("https://opencode.ai.evil.com/v1"), false);
	assert.equal(isOpencodeRequest("https://example.com"), false);
	assert.equal(isOpencodeRequest("not a url"), false);
});

test("2. isConnectionFailure 只认连接类错误", () => {
	for (const code of [
		"ECONNREFUSED",
		"ECONNRESET",
		"EAI_AGAIN",
		"ENETUNREACH",
		"ENOTFOUND",
		"ETIMEDOUT",
		"UND_ERR_CONNECT_TIMEOUT",
		"UND_ERR_HEADERS_TIMEOUT",
		"UND_ERR_SOCKET",
	]) {
		assert.equal(isConnectionFailure(errWithCode(code)), true, code);
	}
	assert.equal(isConnectionFailure(Object.assign(new Error("x"), { cause: { code: "ECONNREFUSED" } })), true);
	assert.equal(isConnectionFailure(new TypeError("fetch failed")), true);
	assert.equal(isConnectionFailure(errWithCode("EPROTO")), false);
	assert.equal(isConnectionFailure(new TypeError("other")), false);
	assert.equal(isConnectionFailure(undefined), false);
});

test("3. 非 opencode 请求直接透传，不附加 dispatcher", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://example.com/api", {});
	assert.deepEqual(seen, [undefined]);
});

test("4. opencode 请求直连成功时只用 direct dispatcher", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/v1/models", {});
	assert.deepEqual(seen, ["direct"]);
});

test("5. 直连连接失败时回退 proxy dispatcher", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		if (init?.dispatcher?.name === "direct") throw errWithCode("ECONNREFUSED");
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	const response = await wrapped("https://opencode.ai/v1/models", {});
	assert.equal(response.status, 200);
	assert.deepEqual(seen, ["direct", "proxy"]);
});

test("6. 非连接类错误不触发回退", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		throw errWithCode("EPROTO");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await assert.rejects(wrapped("https://opencode.ai/v1/models", {}), /boom/);
	assert.deepEqual(seen, ["direct"]);
});

test("7. 已取消的请求不触发回退", async () => {
	const controller = new AbortController();
	controller.abort();
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		throw errWithCode("ECONNREFUSED");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await assert.rejects(wrapped("https://opencode.ai/v1/models", { signal: controller.signal }));
	assert.deepEqual(seen, ["direct"]);
});

test("8. resolveProxyUrl 优先读 PI_OPENCODE_PROXY", () => {
	const original = process.env.PI_OPENCODE_PROXY;
	try {
		process.env.PI_OPENCODE_PROXY = "http://127.0.0.1:9999";
		assert.equal(resolveProxyUrl(), "http://127.0.0.1:9999");

		process.env.PI_OPENCODE_PROXY = "   ";
		assert.match(resolveProxyUrl(), /^https?:\/\//, "空白值应回退默认地址");

		delete process.env.PI_OPENCODE_PROXY;
		assert.match(resolveProxyUrl(), /^https?:\/\//);
	} finally {
		if (original === undefined) delete process.env.PI_OPENCODE_PROXY;
		else process.env.PI_OPENCODE_PROXY = original;
	}
});

test("9. 只追加 dispatcher，不改动原始 init 字段", async () => {
	let captured;
	const fetchLike = async (_input, init) => {
		captured = init;
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/v1", { method: "POST", body: "x", headers: { a: "b" } });
	assert.equal(captured.method, "POST");
	assert.equal(captured.body, "x");
	assert.deepEqual(captured.headers, { a: "b" });
	assert.equal(captured.dispatcher?.name, "direct");
});

// ---- GPT / Grok / Muse / Claude 的固定代理路由 ----

const jsonInit = (model) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ model, input: "hi" }),
});

test("10. /responses（GPT/Grok/Muse）强制走代理，不先试探直连", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/zen/go/v1/responses", jsonInit("muse-spark-1.3-contributor"));
	assert.deepEqual(seen, ["proxy"], "不应出现 direct 尝试");
});

test("11. /messages + claude 强制走代理", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/zen/go/v1/messages", jsonInit("claude-haiku-5-5"));
	assert.deepEqual(seen, ["proxy"]);
});

test("12. /messages + minimax 不误伤，保持直连优先", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		if (init?.dispatcher?.name === "direct") throw errWithCode("ECONNREFUSED");
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/zen/go/v1/messages", jsonInit("minimax-m3"));
	assert.deepEqual(seen, ["direct", "proxy"], "应先直连、失败后才回退");
});

test("13. /messages + qwen 不误伤，直连成功即结束", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/zen/go/v1/messages", jsonInit("qwen3.8-max"));
	assert.deepEqual(seen, ["direct"]);
});

test("14. /chat/completions（deepseek 等）保持原行为", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/zen/go/v1/chat/completions", jsonInit("deepseek-v4.1-flash"));
	assert.deepEqual(seen, ["direct"]);
});

test("15. /messages 的 body 不可解析时不误判为 Claude", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped("https://opencode.ai/zen/go/v1/messages", { body: new Uint8Array([1, 2, 3]) });
	assert.deepEqual(seen, ["direct"]);
});

test("16. 强制代理失败时不回退直连（出口不漂移）", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		throw errWithCode("ECONNREFUSED");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await assert.rejects(wrapped("https://opencode.ai/zen/go/v1/responses", jsonInit("grok-4.7")), /boom/);
	assert.deepEqual(seen, ["proxy"], "代理失败也必须硬失败，不能悄悄改用直连");
});

test("17. needsPinnedProxy 的端点与模型判定", () => {
	assert.equal(needsPinnedProxy("https://opencode.ai/zen/go/v1/responses"), true);
	assert.equal(needsPinnedProxy("https://opencode.ai/zen/go/v1/messages", jsonInit("claude-opus-4")), true);
	assert.equal(needsPinnedProxy("https://opencode.ai/zen/go/v1/messages", jsonInit("minimax-m3")), false);
	assert.equal(needsPinnedProxy("https://opencode.ai/zen/go/v1/chat/completions", jsonInit("deepseek-v4.1-flash")), false);
	assert.equal(needsPinnedProxy("https://example.com/zen/go/v1/responses"), false);
});

// ---- 正文放在 Request 对象里的路由判定 ----

const requestModel = (model, signal) =>
	new Request("https://opencode.ai/zen/go/v1/messages", { ...jsonInit(model), ...(signal ? { signal } : {}) });

test("18. Request 形式的 /messages + claude 固定走代理，且不消耗原正文", async () => {
	const seen = [];
	const fetchLike = async (input, init) => {
		seen.push(init?.dispatcher?.name);
		// 原请求的正文必须仍然可读：被消费掉就说明 clone 没有做到只读副本。
		assert.match(await input.text(), /claude/);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped(requestModel("claude-haiku-5-5"));
	assert.deepEqual(seen, ["proxy"]);
});

test("19. Request 形式的 /messages + 非 claude 保持直连优先", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped(requestModel("minimax-m3"));
	assert.deepEqual(seen, ["direct"]);
});

test("20. init.body 覆盖 Request 正文，仍按同步路径判定", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	// 原 Request 是 claude，但 init 给出 minimax：按覆盖语义不应固定代理。
	await wrapped(requestModel("claude-opus-4"), jsonInit("minimax-m3"));
	assert.deepEqual(seen, ["direct"]);
});

test("21. Request 形式的 /responses 仍按端点固定代理，不读正文", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped(new Request("https://opencode.ai/zen/go/v1/responses", jsonInit("muse-spark-1.3-contributor")));
	assert.deepEqual(seen, ["proxy"]);
});

test("22. init.signal 已取消时不读取正文也不发请求", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(wrapped(requestModel("claude-opus-4"), { signal: controller.signal }), /abort/i);
	assert.deepEqual(seen, [], "已取消的请求不应发出");
});

test("23. Request 自带 signal 已取消时同样立即失败", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(wrapped(requestModel("claude-opus-4", controller.signal)), /abort/i);
	assert.deepEqual(seen, []);
});

test("24. 非 opencode 的 Request 原样透传，不加 dispatcher", async () => {
	const seen = [];
	const fetchLike = async (_input, init) => {
		seen.push(init?.dispatcher?.name);
		return new Response("ok");
	};
	const wrapped = createOpencodeFallbackFetch(fetchLike, { name: "direct" }, { name: "proxy" });
	await wrapped(new Request("https://example.com/v1/messages", jsonInit("claude-opus-4")));
	assert.deepEqual(seen, [undefined]);
});

test("25. 取消时 clone 的迟到正文读取不会成为未处理拒绝", async () => {
	const wrapped = createOpencodeFallbackFetch(async () => new Response("ok"), { name: "direct" }, { name: "proxy" });
	const controller = new AbortController();
	const request = new Request("https://opencode.ai/zen/go/v1/messages", {
		...jsonInit("claude-opus-4"),
		signal: controller.signal,
	});
	const rejections = [];
	const onUnhandled = (reason) => rejections.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		// 在副本正文尚未读完时取消：race 先失败，clone 的读取随后才会失败。
		const pending = wrapped(request);
		controller.abort();
		await assert.rejects(pending, /abort/i);
		await new Promise((resolve) => setImmediate(resolve));
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
	assert.deepEqual(rejections, [], "clone 的迟到 rejection 必须被消费");
});
