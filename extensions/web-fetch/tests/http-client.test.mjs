/**
 * 安全 HTTP 传输测试：全部使用本机 localhost 测试服务器，不访问外网与真实站点。
 *
 * `httpFetch` 只接受已经过校验的目标；测试通过 `resolveTarget` 注入本地目标，
 * 但不跳过任何后续安全逻辑——重定向仍会逐跳重新校验，请求头白名单仍生效。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const client = await jiti.import(fileURLToPath(new URL("../transport/http-client.ts", import.meta.url)));
const body = await jiti.import(fileURLToPath(new URL("../transport/response-body.ts", import.meta.url)));
const errors = await jiti.import(fileURLToPath(new URL("../errors.ts", import.meta.url)));

/** 启动本地服务器并把基址交给用例。 */
async function withServer(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	try {
		await fn(`http://127.0.0.1:${port}`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

/** 本地目标解析：只允许指向本测试服务器，其余地址一律按真实策略拒绝。 */
function localResolver(base) {
	return async (rawUrl) => {
		const url = new URL(rawUrl);
		if (url.origin !== new URL(base).origin) throw new errors.FetchError("目标不是公网地址", "blocked_url");
		return { url, address: "127.0.0.1", family: 4 };
	};
}

function send(response, payload, status = 200, headers = {}) {
	const isText = typeof payload === "string";
	response.writeHead(status, { "content-type": isText ? "text/plain; charset=utf-8" : "application/json", ...headers });
	response.end(isText ? payload : JSON.stringify(payload));
}

const baseRequest = (base) => ({
	url: new URL(base),
	target: { url: new URL(base), address: "127.0.0.1", family: 4 },
	timeoutMs: 3_000,
	maxResponseBytes: 64 * 1024,
});

test("200 返回正文、状态与最终地址", async () => {
	await withServer((request, response) => send(response, "# 标题\n\n正文"), async (base) => {
		const result = await client.httpFetch({ ...baseRequest(base), resolveTarget: localResolver(base) });
		assert.equal(result.status, 200);
		assert.equal(result.body, "# 标题\n\n正文");
		assert.equal(result.redirectCount, 0);
		assert.equal(new URL(result.finalUrl).pathname, "/");
	});
});

test("重定向逐跳重新校验；跳向内网元数据被拒绝", async () => {
	await withServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		if (path === "/to-final") return send(response, "", 302, { location: "/final" });
		if (path === "/to-metadata") return send(response, "", 302, { location: "http://169.254.169.254/latest/meta-data/" });
		if (path === "/final") return send(response, "final body");
		send(response, "not found", 404);
	}, async (base) => {
		const ok = await client.httpFetch({ ...baseRequest(base), url: new URL(`${base}/to-final`), target: { url: new URL(`${base}/to-final`), address: "127.0.0.1", family: 4 }, resolveTarget: localResolver(base) });
		assert.equal(ok.body, "final body");
		assert.equal(ok.redirectCount, 1);

		await assert.rejects(client.httpFetch({ ...baseRequest(base), url: new URL(`${base}/to-metadata`), target: { url: new URL(`${base}/to-metadata`), address: "127.0.0.1", family: 4 }, resolveTarget: localResolver(base) }), (error) => {
			assert.equal(error.kind, "blocked_url");
			return true;
		});
	});
});

test("重定向循环在限定次数后失败", async () => {
	await withServer((request, response) => send(response, "", 302, { location: "/loop" }), async (base) => {
		await assert.rejects(client.httpFetch({ ...baseRequest(base), url: new URL(`${base}/loop`), target: { url: new URL(`${base}/loop`), address: "127.0.0.1", family: 4 }, resolveTarget: localResolver(base) }), (error) => {
			assert.equal(error.kind, "blocked_url");
			assert.match(error.message, /重定向/u);
			return true;
		});
	});
});

test("maxRedirects 可配置为 1 或 5", async () => {
	await withServer((request, response) => {
		const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const index = Number(path.slice(1) || 0);
		if (index < 4) return send(response, "", 302, { location: `/${index + 1}` });
		send(response, "final chain body");
	}, async (base) => {
		const first = `${base}/0`;
		await assert.rejects(client.httpFetch({ ...baseRequest(base), url: new URL(first), target: { url: new URL(first), address: "127.0.0.1", family: 4 }, maxRedirects: 1, resolveTarget: localResolver(base) }), (error) => error.kind === "blocked_url");
		const fifth = await client.httpFetch({ ...baseRequest(base), url: new URL(first), target: { url: new URL(first), address: "127.0.0.1", family: 4 }, maxRedirects: 5, resolveTarget: localResolver(base) });
		assert.equal(fifth.redirectCount, 4);
		assert.equal(fifth.body, "final chain body");
	});
});

test("只把真正的重定向状态码当作跳转", async () => {
	let requests = 0;
	await withServer((request, response) => {
		requests += 1;
		send(response, "not a redirect", 300, { location: "/elsewhere" });
	}, async (base) => {
		await assert.rejects(client.httpFetch({ ...baseRequest(base), resolveTarget: localResolver(base) }), (error) => {
			assert.equal(error.kind, "http_error");
			assert.equal(error.options?.statusCode, 300);
			return true;
		});
		assert.equal(requests, 1);
	});
});

test("多跳共享一个总超时预算", async () => {
	let requests = 0;
	await withServer((request, response) => {
		requests += 1;
		const index = Number(new URL(request.url ?? "/", "http://127.0.0.1").pathname.slice(1) || 0);
		setTimeout(() => {
			if (response.destroyed) return;
			if (index < 5) send(response, "", 302, { location: `/${index + 1}` });
			else send(response, "late final");
		}, 65);
	}, async (base) => {
		const first = `${base}/0`;
		await assert.rejects(client.httpFetch({ ...baseRequest(base), url: new URL(first), target: { url: new URL(first), address: "127.0.0.1", family: 4 }, timeoutMs: 110, resolveTarget: localResolver(base) }), (error) => error.kind === "timeout");
		assert.ok(requests >= 2, `应已进入后续跳转，实际请求 ${requests} 次`);
	});
});

test("跳转 DNS 等待被取消后不建连，迟到拒绝被消费", async () => {
	let requests = 0;
	let rejectResolver;
	let resolveCalled = false;
	await withServer((request, response) => {
		requests += 1;
		send(response, "", 302, { location: "/never-connect" });
	}, async (base) => {
		const controller = new AbortController();
		const resolveTarget = () => {
			resolveCalled = true;
			return new Promise((_, reject) => { rejectResolver = reject; });
		};
		const pending = client.httpFetch({ ...baseRequest(base), url: new URL(`${base}/`), target: { url: new URL(`${base}/`), address: "127.0.0.1", family: 4 }, resolveTarget, signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(resolveCalled, true);
		controller.abort();
		await assert.rejects(pending, (error) => error.kind === "aborted");
		assert.equal(requests, 1);
		rejectResolver(new Error("late resolver rejection"));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
});

test("404、403、429、500 归入 http_error 并带上状态码", async () => {
	for (const [status, pattern] of [[404, /不存在/u], [403, /认证/u], [429, /限流/u], [500, /服务端/u]]) {
		await withServer((request, response) => send(response, "detail", status), async (base) => {
			await assert.rejects(client.httpFetch({ ...baseRequest(base), resolveTarget: localResolver(base) }), (error) => {
				assert.equal(error.kind, "http_error");
				assert.equal(error.options?.statusCode, status);
				assert.match(error.message, pattern);
				return true;
			});
		});
	}
});

test("429 的 Retry-After 被解析为毫秒", async () => {
	await withServer((request, response) => send(response, "slow down", 429, { "retry-after": "12" }), async (base) => {
		await assert.rejects(client.httpFetch({ ...baseRequest(base), resolveTarget: localResolver(base) }), (error) => {
			assert.equal(error.options?.retryAfterMs, 12_000);
			return true;
		});
	});
});

test("响应体超限立即失败，不返回部分内容", async () => {
	await withServer((request, response) => send(response, "x".repeat(4096)), async (base) => {
		await assert.rejects(client.httpFetch({ ...baseRequest(base), maxResponseBytes: 64, resolveTarget: localResolver(base) }), (error) => {
			assert.equal(error.kind, "response_too_large");
			return true;
		});
	});
});

test("超时与外部取消分别归类，且不再继续读取", async () => {
	await withServer((request, response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.write("x".repeat(1024));
		// 故意不结束响应，让读取方等待。
	}, async (base) => {
		await assert.rejects(client.httpFetch({ ...baseRequest(base), timeoutMs: 120, resolveTarget: localResolver(base) }), (error) => {
			assert.equal(error.kind, "timeout");
			return true;
		});
		const controller = new AbortController();
		const pending = client.httpFetch({ ...baseRequest(base), resolveTarget: localResolver(base), signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		await assert.rejects(pending, (error) => {
			assert.equal(error.kind, "aborted");
			return true;
		});
	});
});

test("请求头白名单不含 Cookie 与 Authorization", async () => {
	await withServer((request, response) => {
		assert.equal(request.headers.cookie, undefined);
		assert.equal(request.headers.authorization, undefined);
		assert.equal(request.headers["user-agent"], "pi-web-fetch/0.1.0-beta.2");
		send(response, "ok");
	}, async (base) => {
		const result = await client.httpFetch({ ...baseRequest(base), resolveTarget: localResolver(base) });
		assert.equal(result.body, "ok");
	});
	const headers = client.buildHeaders(new URL("https://example.com/a"));
	assert.ok(!Object.keys(headers).some((name) => name.toLowerCase() === "cookie" || name.toLowerCase() === "authorization"));
});

test("有界读取：恰好达到上限通过，超出失败，跨块中文完整", async () => {
	assert.equal(await body.readResponseTextLimited(new Response("abc"), 3), "abc");
	assert.equal(await body.readResponseTextLimited(new Response(null, { status: 204 }), 3), "");
	await assert.rejects(body.readResponseTextLimited(new Response("abcd"), 3), (error) => {
		assert.equal(error.kind, "response_too_large");
		return true;
	});
	const bytes = Buffer.from("中文技术文档".repeat(64), "utf8");
	const chunks = [];
	for (let index = 0; index < bytes.byteLength; index += 7) chunks.push(bytes.subarray(index, index + 7));
	const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk)); controller.close(); } });
	assert.equal(await body.readResponseTextLimited(new Response(stream), bytes.byteLength), "中文技术文档".repeat(64));
});

test("有界读取：读取前取消立即拒绝", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(body.readResponseTextLimited(new Response("abc"), 3, controller), { name: "FetchError" });
});
