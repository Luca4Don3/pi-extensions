import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import testRunner from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const test = (name, fn) => testRunner(name, { concurrency: false }, fn);
const jiti = createJiti(import.meta.url);
const bodyModule = await jiti.import(fileURLToPath(new URL("../response-body.ts", import.meta.url)));
const core = await jiti.import(fileURLToPath(new URL("../search-core.ts", import.meta.url)));
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const { createChannelHealth } = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const { PROVIDER_IDS } = await jiti.import(fileURLToPath(new URL("../search/registry.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const {
	DEFAULT_MAX_RESPONSE_BYTES,
	MAX_RESPONSE_BYTES,
	readMaxResponseBytes,
	readResponseTextLimited,
} = bodyModule;
const KEY_NAMES = ["EXA_API_KEY", "PARALLEL_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "SERPAPI_API_KEY"];
const TEMP_DIR = fileURLToPath(new URL("../.temp/", import.meta.url));
const encoder = new TextEncoder();

function fakeStore() {
	const reads = Object.fromEntries(PROVIDER_IDS.map((id) => [id, 0]));
	return {
		reads,
		store: {
			kind: "none",
			read: async (backend) => { reads[backend]++; return { status: "missing" }; },
			write: async () => ({ status: "unavailable", reason: "FAKE_TEST_STORE" }),
			clear: async () => ({ status: "missing" }),
		},
	};
}

function setup(health = createChannelHealth(), store = fakeStore().store) {
	const tools = [];
	plugin({ registerTool: (tool) => tools.push(tool), registerCommand: () => undefined }, {
		credentialStore: store,
		channelHealth: health,
	});
	return tools[0];
}

async function withIsolatedEnv(vars, fn) {
	const previous = process.env;
	const values = {
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		PI_WEB_SEARCH_TIMEOUT_MS: "1000",
		TMPDIR: TEMP_DIR,
		...Object.fromEntries(KEY_NAMES.map((name) => [name, `FAKE_RESPONSE_BODY_${name}`])),
	};
	for (const [name, value] of Object.entries(vars)) {
		if (value === undefined) delete values[name];
		else values[name] = String(value);
	}
	const keyReads = { count: 0 };
	process.env = new Proxy(values, {
		get(target, name, receiver) {
			if (KEY_NAMES.includes(name)) keyReads.count++;
			return Reflect.get(target, name, receiver);
		},
	});
	try {
		return await fn(keyReads);
	} finally {
		process.env = previous;
	}
}

async function withFetch(implementation, fn) {
	const original = globalThis.fetch;
	const calls = [];
	globalThis.fetch = (url, init) => {
		calls.push({ url: String(url), init });
		return implementation(String(url), init, calls.length);
	};
	try {
		return await fn(calls);
	} finally {
		globalThis.fetch = original;
	}
}

function responseFromChunks(chunks, options = {}) {
	let index = 0;
	const stream = new ReadableStream({
		pull(controller) {
			if (index < chunks.length) controller.enqueue(chunks[index++]);
			else if (!options.keepOpen) controller.close();
		},
		cancel: options.cancel,
	});
	return new Response(stream, { status: options.status ?? 200, headers: options.headers });
}

function assertTooLarge(error) {
	assert.ok(error instanceof core.BackendError, `应为 BackendError，实际为 ${error}`);
	assert.equal(error.kind, "response_too_large");
	assert.equal(error.retryable, false);
	return true;
}

async function withLocalServer(handler, fn) {
	const server = createServer(handler);
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address();
	try {
		return await fn(`http://127.0.0.1:${port}`);
	} finally {
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
}

function assertDiagnostic(error, kind) {
	assert.match(String(error?.message ?? error), new RegExp(kind, "u"));
}

test("默认配置与正整数边界严格校验，非法输入不回显", () => {
	assert.equal(DEFAULT_MAX_RESPONSE_BYTES, 5 * 1024 * 1024);
	assert.equal(MAX_RESPONSE_BYTES, 20 * 1024 * 1024);
	assert.equal(readMaxResponseBytes({}), DEFAULT_MAX_RESPONSE_BYTES);
	assert.equal(readMaxResponseBytes({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: undefined }), DEFAULT_MAX_RESPONSE_BYTES);
	assert.equal(readMaxResponseBytes({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: " 1 " }), 1);
	assert.equal(readMaxResponseBytes({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: String(MAX_RESPONSE_BYTES) }), MAX_RESPONSE_BYTES);
	for (const value of ["0", "-1", "+1", "1.0", "1e3", "0x10", "", "   ", String(MAX_RESPONSE_BYTES + 1)]) {
		assert.throws(() => readMaxResponseBytes({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: value }));
	}
	const secret = "FAKE_SECRET_RESPONSE_LIMIT_DO_NOT_ECHO";
	assert.throws(
		() => readMaxResponseBytes({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: secret }),
		(error) => !String(error.message).includes(secret),
	);
});

test("默认 5 MiB 下小于、恰好、超过真实字节边界", async () => {
	const controller = new AbortController();
	const under = new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES - 1).fill(0x61);
	assert.equal((await readResponseTextLimited(responseFromChunks([under]), DEFAULT_MAX_RESPONSE_BYTES, controller)).length, DEFAULT_MAX_RESPONSE_BYTES - 1);
	const exact = new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES).fill(0x62);
	assert.equal((await readResponseTextLimited(responseFromChunks([exact]), DEFAULT_MAX_RESPONSE_BYTES, new AbortController())).length, DEFAULT_MAX_RESPONSE_BYTES);
	const over = new Uint8Array(DEFAULT_MAX_RESPONSE_BYTES + 1).fill(0x63);
	const response = responseFromChunks([over]);
	await assert.rejects(readResponseTextLimited(response, DEFAULT_MAX_RESPONSE_BYTES, new AbortController()), assertTooLarge);
	assert.equal(response.body.locked, false, "超限后必须释放 reader 锁");
});

test("按 Uint8Array 字节数限额，不信任缺失或虚假的 Content-Length", async () => {
	const cap = 4;
	const understated = responseFromChunks([encoder.encode("汉AB")], { headers: { "content-length": "1" } });
	await assert.rejects(readResponseTextLimited(understated, cap, new AbortController()), assertTooLarge);
	const overstated = responseFromChunks([encoder.encode("汉A")], { headers: { "content-length": "999999" } });
	assert.equal(await readResponseTextLimited(overstated, cap, new AbortController()), "汉A");
	const missing = responseFromChunks([encoder.encode("abcde")]);
	await assert.rejects(readResponseTextLimited(missing, cap, new AbortController()), assertTooLarge);
});

test("分块 UTF-8、中文多字节、BOM 与字节数均正确", async () => {
	const bytes = encoder.encode("\uFEFF中文🙂");
	const chunks = [bytes.slice(0, 1), bytes.slice(1, 3), bytes.slice(3, 6), bytes.slice(6, 8), bytes.slice(8)];
	const result = await readResponseTextLimited(responseFromChunks(chunks), bytes.byteLength, new AbortController());
	assert.equal(result, new TextDecoder().decode(bytes));
	assert.equal(encoder.encode("汉A").byteLength, 4);
	await assert.rejects(readResponseTextLimited(responseFromChunks([encoder.encode("汉A")]), 3, new AbortController()), assertTooLarge);
	assert.equal(await readResponseTextLimited(responseFromChunks([encoder.encode("汉A")]), 4, new AbortController()), "汉A");
});

test("null body 与空 body 返回空串；已取消信号优先失败", async () => {
	assert.equal(await readResponseTextLimited(new Response(null), 1, new AbortController()), "");
	assert.equal(await readResponseTextLimited(responseFromChunks([]), 1, new AbortController()), "");
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(readResponseTextLimited(new Response(null), 1, controller));
});

test("读取前、中、结束竞争时的 abort 均不能伪装为成功", async () => {
	const before = new AbortController();
	before.abort();
	await assert.rejects(readResponseTextLimited(responseFromChunks([encoder.encode("x")]), 8, before));

	let cancelled = 0;
	const during = new AbortController();
	const pending = new Response(new ReadableStream({
		pull: () => new Promise(() => undefined),
		cancel: () => { cancelled++; },
	}));
	const read = readResponseTextLimited(pending, 8, during);
	during.abort();
	await assert.rejects(read);
	assert.equal(cancelled, 1);
	assert.equal(pending.body.locked, false);

	const after = new AbortController();
	const completedAtSource = new Response(new ReadableStream({
		pull(stream) {
			stream.enqueue(encoder.encode("done"));
			stream.close();
			after.abort();
		},
	}));
	await assert.rejects(readResponseTextLimited(completedAtSource, 8, after));
});

test("底层读取异常原样传播", async () => {
	const original = new Error("FAKE_STREAM_READ_FAILURE");
	const response = new Response(new ReadableStream({ pull(stream) { stream.error(original); } }));
	await assert.rejects(readResponseTextLimited(response, 32, new AbortController()), (error) => error === original);
});

test("超限清理不等待迟延 cancel，迟到拒绝也不会成为未处理异常", async () => {
	let rejectCancel;
	let wasCancelled = false;
	const unhandled = [];
	const listener = (error) => unhandled.push(error);
	process.on("unhandledRejection", listener);
	const response = new Response(new ReadableStream({
		pull(stream) { stream.enqueue(encoder.encode("oversized")); },
		cancel() {
			wasCancelled = true;
			return new Promise((_resolve, reject) => { rejectCancel = reject; });
		},
	}));
	try {
		const result = await Promise.race([
			readResponseTextLimited(response, 2, new AbortController()).then(
				() => { throw new Error("超限正文不应成功"); },
				(error) => error,
			),
			new Promise((_resolve, reject) => setTimeout(() => reject(new Error("超限取消挂起")), 300)),
		]);
		assertTooLarge(result);
		assert.equal(wasCancelled, true);
		rejectCancel(new Error("FAKE_LATE_CANCEL_REJECTION"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.deepEqual(unhandled, []);
	} finally {
		process.removeListener("unhandledRejection", listener);
		if (rejectCancel) rejectCancel(new Error("FAKE_TEST_CLEANUP"));
	}
});

test("最多合法分块可累计至上限且不漏块", async () => {
	const chunks = Array.from({ length: 128 }, (_, index) => new Uint8Array([97 + (index % 26)]));
	assert.equal(await readResponseTextLimited(responseFromChunks(chunks), chunks.length, new AbortController()),
		chunks.map((chunk) => String.fromCharCode(chunk[0])).join(""));
});

test("默认上限会限制五个后端的成功与 HTTP 错误响应，超限不重试或冷却", async () => {
	for (const backend of PROVIDER_IDS) {
		for (const status of [200, 429, 500]) {
			const health = createChannelHealth();
			const tool = setup(health);
				await withIsolatedEnv({
				PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "32",
				PI_WEB_SEARCH_RETRIES: "1",
				PI_WEB_SEARCH_FREE_COOLDOWN_MS: "60000",
				PI_WEB_SEARCH_ALLOW_BILLABLE: backend === "serpapi" ? "true" : undefined,
				PI_WEB_SEARCH_ALLOW_PAID: undefined,
				PI_WEB_SEARCH_ROUTING: "free-first",
			}, async () => {
				await withFetch(() => new Response("x".repeat(40), { status }), async (calls) => {
					await assert.rejects(tool.execute(`size-${backend}-${status}`, { query: "限额", provider: backend }), (error) => {
						assertDiagnostic(error, "response_too_large");
						return true;
					});
					assert.equal(calls.length, 1, `${backend} HTTP ${status} 超限不得重试`);
				});
			});
			assert.deepEqual(health.snapshot().channels, [], `${backend} HTTP ${status} 超限不得影响额度/健康状态`);
		}
	}
});

test("未超限 HTTP 429/500 保留原状态分类", async () => {
	for (const [status, kind, detail] of [[429, "rate_limited", "rate limit"], [500, "server_error", "upstream failure"]]) {
		const tool = setup();
		await withIsolatedEnv({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "256", PI_WEB_SEARCH_RETRIES: "0" }, async () => {
			await withFetch(() => new Response(JSON.stringify({ error: { message: detail } }), { status }), async (calls) => {
				await assert.rejects(tool.execute(`status-${status}`, { query: "状态分类", provider: "exa" }), (error) => {
					assertDiagnostic(error, kind);
					assert.doesNotMatch(error.message, /response_too_large/u);
					return true;
				});
				assert.equal(calls.length, 1);
			});
		});
	}
});

test("真实 Node fetch 自动解压 gzip 后仍按解码字节数限额", async () => {
	const expanded = Buffer.from("z".repeat(DEFAULT_MAX_RESPONSE_BYTES + 1));
	const compressed = gzipSync(expanded);
	assert.ok(compressed.byteLength < DEFAULT_MAX_RESPONSE_BYTES);
	let requests = 0;
	await withLocalServer((_request, response) => {
		requests++;
		response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": compressed.byteLength });
		response.end(compressed);
	}, async (origin) => {
		const tool = setup();
		await withIsolatedEnv({ PI_WEB_SEARCH_RETRIES: "1" }, async () => {
			const originalFetch = globalThis.fetch;
			globalThis.fetch = (_url, init) => originalFetch(`${origin}/gzip`, init);
			try {
				await assert.rejects(tool.execute("gzip-limit", { query: "压缩响应", provider: "exa" }), (error) => {
					assertDiagnostic(error, "response_too_large");
					return true;
				});
			} finally {
				globalThis.fetch = originalFetch;
			}
		});
	});
	assert.equal(requests, 1);
});

test("真实 Node fetch 流式成功及超大 429/500 正文都只请求一次且不冷却", async () => {
	let requests = 0;
	await withLocalServer((request, response) => {
		requests++;
		const status = request.url === "/429" ? 429 : request.url === "/500" ? 500 : 200;
		response.writeHead(status, { "content-type": "text/plain" });
		for (let index = 0; index < 8; index++) response.write(Buffer.alloc(1024, 0x61));
		response.end();
	}, async (origin) => {
		for (const route of ["/success", "/429", "/500"]) {
			const health = createChannelHealth();
			const tool = setup(health);
			const before = requests;
			await withIsolatedEnv({
				PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "4096",
				PI_WEB_SEARCH_RETRIES: "1",
				PI_WEB_SEARCH_FREE_COOLDOWN_MS: "60000",
			}, async () => {
				const originalFetch = globalThis.fetch;
				globalThis.fetch = (_url, init) => originalFetch(`${origin}${route}`, init);
				try {
					await assert.rejects(tool.execute(`local-${route}`, { query: "本地流", provider: "exa" }), (error) => {
						assertDiagnostic(error, "response_too_large");
						return true;
					});
				} finally {
					globalThis.fetch = originalFetch;
				}
			});
			assert.equal(requests - before, 1, `${route} 超限只能产生一个请求`);
			assert.deepEqual(health.snapshot().channels, [], `${route} 不得记录额度或冷却状态`);
		}
	});
});

test("auto 遇 Parallel 超限后按匿名顺序回退 Exa，不读取 Keys 或密钥库", async () => {
	const health = createChannelHealth();
	const store = fakeStore();
	let tool;
	const tools = [];
	plugin({ registerTool: (entry) => tools.push(entry), registerCommand: () => undefined }, { credentialStore: store.store, channelHealth: health });
	tool = tools[0];
	await withIsolatedEnv({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "512", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "60000" }, async (keyReads) => {
		await withFetch((url) => url.includes("search.parallel.ai")
			? new Response("p".repeat(513))
			: new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: 合法来源\nURL: https://example.com/hit\nHighlights:\n正文" }] } })), async (calls) => {
			const result = await tool.execute("auto-size-fallback", { query: "匿名回退" });
			assert.equal(result.details.provider, "exa");
			assert.equal(result.details.channel, "free");
			assert.equal(result.details.accessTier, "anonymous");
			assert.deepEqual(calls.map(({ url }) => url.includes("search.parallel.ai") ? "parallel" : "exa"), ["parallel", "exa"]);
			assert.equal(keyReads.count, 0);
			assert.deepEqual(Object.values(store.reads), [0, 0, 0, 0, 0]);
		});
	});
	assert.deepEqual(health.snapshot().channels, []);
});

test("读取响应期间预算超时保留超时诊断与原有匿名回退", async () => {
	const health = createChannelHealth();
	const store = fakeStore();
	const tool = setup(health, store.store);
	await withIsolatedEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "100", PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "512", PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "60000" }, async (keyReads) => {
		await withFetch(() => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })), async (calls) => {
			await assert.rejects(tool.execute("read-timeout", { query: "预算", provider: "parallel" }), (error) => {
				assert.match(error.message, /timed out after 100ms/u);
				assert.doesNotMatch(error.message, /response_too_large/u);
				return true;
			});
			assert.equal(calls.length, 1);
		});
		await withFetch((_url, _init, count) => count === 1
			? new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }))
			: new Response(JSON.stringify({ result: { content: [{ type: "text", text: "Title: 超时后的有效来源\nURL: https://example.com/timeout-fallback" }] } })), async (calls) => {
			const result = await tool.execute("read-timeout-fallback", { query: "预算", provider: "auto" });
			assert.equal(result.details.provider, "exa");
			assert.equal(result.details.attemptCount, 2);
			assert.deepEqual(calls.map(({ url }) => new URL(url).hostname), ["search.parallel.ai", "mcp.exa.ai"]);
		});
		assert.equal(keyReads.count, 0);
	});
	assert.deepEqual(health.snapshot().channels, []);
	assert.deepEqual(Object.values(store.reads), [0, 0, 0, 0, 0]);
});

test("读取响应期间外部取消保留取消错误且不触发回退或计费", async () => {
	const store = fakeStore();
	const tool = setup(createChannelHealth(), store.store);
	await withIsolatedEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "1000", PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "16" }, async (keyReads) => {
		await withFetch(() => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) })), async (calls) => {
			const external = new AbortController();
			const pending = tool.execute("external-cancel", { query: "外部取消", provider: "auto" }, external.signal);
			setTimeout(() => external.abort(), 20);
			await assert.rejects(pending, (error) => error.name === "AbortError" && !/response_too_large/u.test(error.message));
			assert.equal(calls.length, 1);
			assert.equal(keyReads.count, 0);
		});
	});
	assert.deepEqual(Object.values(store.reads), [0, 0, 0, 0, 0]);
});

test("非法上限配置在读 Keys 或发送请求之前失败，且不泄漏配置值", async () => {
	const tool = setup();
	await withIsolatedEnv({
		PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "0",
		PI_WEB_SEARCH_ALLOW_BILLABLE: "true",
		PI_WEB_SEARCH_ALLOW_PAID: "true",
		PI_WEB_SEARCH_ROUTING: "key-first",
	}, async (keyReads) => {
		await withFetch(() => { throw new Error("不应发送请求"); }, async (calls) => {
			await assert.rejects(tool.execute("invalid-limit", { query: "非法配置", provider: "exa" }), (error) => {
				assert.doesNotMatch(error.message, /PI_WEB_SEARCH_MAX_RESPONSE_BYTES[:= ]+0/u);
				return true;
			});
			assert.equal(calls.length, 0);
			assert.equal(keyReads.count, 0);
		});
	});
});

test("helpers 默认只读隔离后的限额设置，不探测本机 Keys", async () => {
	await withIsolatedEnv({ PI_WEB_SEARCH_MAX_RESPONSE_BYTES: "4096" }, async (keyReads) => {
		assert.equal(readMaxResponseBytes(), 4096);
		assert.equal(keyReads.count, 0);
		assert.equal(process.env.HOME, undefined);
	});
});
