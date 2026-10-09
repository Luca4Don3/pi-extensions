/**
 * 离线单元测试：用 jiti 加载 index.ts，替换 globalThis.fetch 为 mock，
 * 覆盖注册契约、Exa / Parallel 解析、auto 回退、取消 / 超时 / 重试语义，
 * 以及正文截断与落盘清理行为。全部用例不触网。
 *
 * 运行：node --test tests/mock.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

/** 用 jiti 加载被测的 TypeScript 入口。 */
const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;

/** mock Pi 的 ExtensionAPI：只收集注册的工具。 */
const tools = [];
plugin({ registerTool: (tool) => tools.push(tool) });
const tool = tools[0];
if (tool === undefined) throw new Error("扩展没有注册任何工具");

/** 落盘目录，与 index.ts 中 join(tmpdir(), "pi-web-search") 保持一致。 */
const SPILL_DIR = join(tmpdir(), "pi-web-search");
/** 需要按用例注入并在结束后恢复的环境变量。 */
const ENV_KEYS = ["PI_WEB_SEARCH_TIMEOUT_MS", "PI_WEB_SEARCH_RETRIES"];
const ENV_BASELINE = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

/** 判断请求是否发往 Exa 端点。 */
const isExa = (url) => String(url).includes("mcp.exa.ai");

/** 把 MCP text 内容包成 SSE 帧（Exa 的响应形态）。 */
function exaSse(text) {
	return `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] } })}\n\n`;
}

/** 把 MCP text 内容包成直接 JSON 信封（Parallel 的响应形态）。 */
function jsonEnvelope(text) {
	return JSON.stringify({ result: { content: [{ type: "text", text }] } });
}

/** 构造一个 200 的 Response。 */
function okResponse(body) {
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** 替换 globalThis.fetch，回调里拿到 mock 与当前调用次数，结束后恢复。 */
async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (url, init) => {
		calls += 1;
		return impl(url, init, calls);
	};
	try {
		return await fn(() => calls);
	} finally {
		globalThis.fetch = original;
	}
}

/** 注入环境变量，结束后恢复原值（含删除此前不存在的键）。 */
async function withEnv(vars, fn) {
	const saved = {};
	for (const key of Object.keys(vars)) saved[key] = process.env[key];
	for (const [key, value] of Object.entries(vars)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = String(value);
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const EXA_BODY = "Title: T\nURL: https://example.com/a\nHighlights:\n摘要";
const PARALLEL_INNER = JSON.stringify({
	results: [
		{ url: "https://example.com/b", title: "B", publish_date: "2026-01-01", excerpts: ["片段"] },
		{ url: "https://example.com/c", title: "C", excerpts: ["另一段"] },
	],
});

test("1. 注册契约：名称 / 标签 / 参数 / 注解", () => {
	assert.equal(tool.name, "web_search");
	assert.equal(tool.label, "Web Search");
	const props = tool.parameters.properties;
	assert.ok(props.query, "缺少 query 参数");
	assert.equal(props.query.type, "string");
	assert.ok(props.maxResults, "缺少 maxResults 参数");
	assert.ok(props.provider, "缺少 provider 参数");
	const providerSchema = JSON.stringify(props.provider);
	for (const value of ["auto", "exa", "parallel"]) {
		assert.ok(providerSchema.includes(value), `provider 枚举缺少 ${value}`);
	}
	assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true, openWorldHint: true });
});

test("2. Exa SSE 响应解析", async () => {
	await withFetch(() => Promise.resolve(okResponse(exaSse(EXA_BODY))), async () => {
		const result = await tool.execute("t2", { query: "hello", provider: "exa" });
		assert.equal(result.details.provider, "exa");
		assert.equal(result.details.sources[0].url, "https://example.com/a");
		assert.match(result.content[0].text, /Title: T/);
		assert.match(result.content[0].text, /摘要/);
	});
});

test("3. Parallel 直接 JSON 响应转 Markdown", async () => {
	await withFetch(() => Promise.resolve(okResponse(jsonEnvelope(PARALLEL_INNER))), async () => {
		const result = await tool.execute("t3", { query: "parallel", maxResults: 3, provider: "parallel" });
		assert.equal(result.details.provider, "parallel");
		assert.ok(result.details.sourceCount <= 3);
		assert.equal(result.details.sources[0].url, "https://example.com/b");
		assert.match(result.content[0].text, /\[B\]\(https:\/\/example\.com\/b\)/);
		assert.match(result.content[0].text, /片段/);
	});
});

test("4. auto 模式 Exa 网络故障回退 Parallel", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			(url) => (isExa(url) ? Promise.reject(new TypeError("network down")) : Promise.resolve(okResponse(jsonEnvelope(PARALLEL_INNER)))),
			async () => {
				const result = await tool.execute("t4", { query: "fallback" });
				assert.equal(result.details.provider, "parallel");
			},
		);
	});
});

test("5. 调用方取消：aborted 且快速返回", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60);
	try {
		await withFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				}),
			async () => {
				const startedAt = Date.now();
				await assert.rejects(
					tool.execute("t5", { query: "cancel", provider: "exa" }, controller.signal),
					/aborted/,
				);
				assert.ok(Date.now() - startedAt < 2000, "取消应在 2 秒内返回");
			},
		);
	} finally {
		clearTimeout(timer);
	}
});

test("6. 超时：fetch 永不 resolve 时按预算中止", async () => {
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "100", PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				}),
			async () => {
				await assert.rejects(
					tool.execute("t6", { query: "slow", provider: "exa" }),
					/timed out after 100ms/,
				);
			},
		);
	});
});

test("7. 超时：HTTP 200 但响应体不结束", async () => {
	// mock fetch 不经过 undici，真实 Response 的 body 不会随内部 controller.abort 而结束，
	// 因此这里返回自制响应对象，让 text() 在内部 signal abort 时 reject。
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "100", PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			(_url, init) =>
				Promise.resolve({
					ok: true,
					status: 200,
					text: () =>
						new Promise((_resolve, reject) => {
							init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
								once: true,
							});
						}),
					json: () => Promise.reject(new Error("not json")),
				}),
			async () => {
				await assert.rejects(tool.execute("t7", { query: "hang", provider: "exa" }), /timed out/);
			},
		);
	});
});

test("8. 可重试：Exa 429 后第二次成功", async () => {
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "2000", PI_WEB_SEARCH_RETRIES: "1" }, async () => {
		await withFetch(
			(_url, _init, count) =>
				count === 1
					? Promise.resolve(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }))
					: Promise.resolve(okResponse(exaSse(EXA_BODY))),
			async (getCalls) => {
				const result = await tool.execute("t8", { query: "retry", provider: "exa" });
				assert.equal(result.details.provider, "exa");
				assert.equal(getCalls(), 2, "429 应触发一次重试");
			},
		);
	});
});

test("9. 不可重试：Exa 400 只请求一次", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1" }, async () => {
		await withFetch(
			() => Promise.resolve(new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 })),
			async (getCalls) => {
				await assert.rejects(tool.execute("t9", { query: "bad", provider: "exa" }), /HTTP 400/);
				assert.equal(getCalls(), 1, "400 不应重试");
			},
		);
	});
});

test("10. auto 双后端 5xx：错误同时包含 exa 与 parallel", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			() => Promise.resolve(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 })),
			async () => {
				await assert.rejects(tool.execute("t10", { query: "both" }), (error) => {
					assert.match(error.message, /exa/);
					assert.match(error.message, /parallel/);
					return true;
				});
			},
		);
	});
});

test("11. 空 query 直接拒绝", async () => {
	await assert.rejects(tool.execute("t11", { query: "   " }), /query must not be empty/);
});

test("12. 超长正文截断并落盘（0600 / 完整写入）", async () => {
	const bigBody = `Title: Big\nURL: https://example.com/big\nHighlights:\n${"x".repeat(40000)}`;
	await withFetch(() => Promise.resolve(okResponse(exaSse(bigBody))), async () => {
		const result = await tool.execute("t12", { query: "big", provider: "exa" });
		assert.equal(result.details.truncated, true);
		assert.equal(result.details.fullTextComplete, true);
		assert.equal(typeof result.details.fullTextPath, "string");
		const stats = statSync(result.details.fullTextPath);
		assert.equal(stats.mode & 0o777, 0o600, "落盘文件权限应为 0600");
		assert.ok(readFileSync(result.details.fullTextPath, "utf8").length >= 40000);
	});
});

test("13. 落盘上限：超过 2MB 只写 2MB", async () => {
	const hugeBody = "z".repeat(2 * 1024 * 1024 + 8192);
	await withFetch(() => Promise.resolve(okResponse(exaSse(hugeBody))), async () => {
		const result = await tool.execute("t13", { query: "huge", provider: "exa" });
		assert.equal(result.details.truncated, true);
		assert.equal(result.details.fullTextComplete, false);
		assert.ok(statSync(result.details.fullTextPath).size <= 2 * 1024 * 1024);
	});
});

test("14. 落盘目录只保留最近 20 个 results-*.txt", async () => {
	mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 });
	for (let i = 0; i < 25; i++) {
		writeFileSync(join(SPILL_DIR, `results-0000000000000-${String(i).padStart(4, "0")}.txt`), "stale");
	}
	const bigBody = `Title: Prune\nURL: https://example.com/prune\nHighlights:\n${"p".repeat(40000)}`;
	await withFetch(() => Promise.resolve(okResponse(exaSse(bigBody))), async () => {
		await tool.execute("t14", { query: "prune", provider: "exa" });
	});
	const names = readdirSync(SPILL_DIR).filter((name) => name.startsWith("results-") && name.endsWith(".txt"));
	assert.ok(names.length <= 20, `落盘目录残留 ${names.length} 个文件，应 <= 20`);
});

test("15. 环境变量在用例结束后已恢复", () => {
	for (const key of ENV_KEYS) {
		assert.equal(process.env[key], ENV_BASELINE[key], `${key} 未恢复`);
	}
});

// 16. 真实 undici 路径：HTTP 200 但响应体永不结束。
// 用例 7 用自制响应对象绕过了真实 fetch；这里改用本地 HTTP server，
// 只把端点地址换成 127.0.0.1，其余（fetch、AbortSignal、body 读取）全部真实，
// 用于证明「连接已建立但服务端不结束响应体」也能被预算中止。
test("16. 真实 undici：HTTP 200 但响应体不结束时按预算中止", async () => {
	const { createServer } = await import("node:http");
	const originalFetch = globalThis.fetch;
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write('event: message\ndata: {"result":{"content":[{"type":"text","text":"partial');
		// 故意不调用 res.end()，模拟响应体挂起。
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	globalThis.fetch = (_url, init) => originalFetch(`http://127.0.0.1:${port}/mcp`, init);
	try {
		await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "150", PI_WEB_SEARCH_RETRIES: "0" }, async () => {
			const startedAt = Date.now();
			await assert.rejects(
				tool.execute("t16", { query: "挂起响应体", provider: "exa" }, undefined, undefined, {}),
				/timed out after 150ms/,
			);
			assert.ok(Date.now() - startedAt < 3000, "超时应在预算附近中止");
		});
	} finally {
		globalThis.fetch = originalFetch;
		server.closeAllConnections?.();
		await new Promise((resolve) => server.close(resolve));
	}
});

// 17. MCP result.isError：HTTP 200 且 JSON-RPC 成功，但工具执行失败。
test("17. MCP result.isError 被当成错误而非搜索结果", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			() =>
				okResponse(
					JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "search tool failed hard" }] } }),
				),
			async () => {
				await assert.rejects(
					tool.execute("t17", { query: "x", provider: "exa" }, undefined, undefined, {}),
					/search tool failed hard/,
				);
			},
		);
	});
});

// 18. 额度耗尽：Exa Key 通道失败后降级到同后端的免费通道。
test("18. 额度耗尽：Exa Key 失败后降级免费通道，且不再重试 Key", async () => {
	const seen = [];
	await withEnv({ EXA_API_KEY: "test-key", PI_WEB_SEARCH_RETRIES: "1" }, async () => {
		await withFetch(
			(url) => {
				seen.push(String(url));
				if (String(url).includes("exaApiKey")) {
					return okResponse(
						JSON.stringify({
							result: { isError: true, content: [{ type: "text", text: "quota exhausted for this api key" }] },
						}),
					);
				}
				return okResponse(exaSse(EXA_BODY));
			},
			async () => {
				const result = await tool.execute("t18", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.channel, "free");
				assert.equal(result.details.provider, "exa");
				assert.equal(seen.length, 2, "额度错误不该被重试");
				assert.ok(seen[0].includes("exaApiKey=test-key"));
				assert.ok(!seen[1].includes("exaApiKey"));
			},
		);
	});
});

// 19. 鉴权失败：401 同样是「换通道」而不是「重试」。
test("19. 401 鉴权失败降级免费通道", async () => {
	const seen = [];
	await withEnv({ PARALLEL_API_KEY: "bad-key", PI_WEB_SEARCH_RETRIES: "1" }, async () => {
		await withFetch(
			(url, init) => {
				seen.push({ url: String(url), auth: init?.headers?.authorization });
				if (init?.headers?.authorization) return new Response("invalid api key", { status: 401 });
				return okResponse(jsonEnvelope(PARALLEL_INNER));
			},
			async () => {
				const result = await tool.execute("t19", { query: "x", provider: "parallel" }, undefined, undefined, {});
				assert.equal(result.details.channel, "free");
				assert.equal(seen.length, 2);
				assert.equal(seen[0].auth, "Bearer bad-key");
				assert.equal(seen[1].auth, undefined);
			},
		);
	});
});

// 20. 完整四通道顺序：Exa Key → Exa Free → Parallel Key → Parallel Free。
test("20. 四通道顺序：Exa Key → Exa Free → Parallel Key → Parallel Free", async () => {
	const seen = [];
	await withEnv(
		{ EXA_API_KEY: "k1", PARALLEL_API_KEY: "k2", PI_WEB_SEARCH_RETRIES: "0" },
		async () => {
			await withFetch(
				(url, init) => {
					const isExaCall = String(url).includes("mcp.exa.ai");
					const hasKey = isExaCall ? String(url).includes("exaApiKey") : Boolean(init?.headers?.authorization);
					seen.push(hasKey ? `${isExaCall ? "exa" : "parallel"}(key)` : isExaCall ? "exa" : "parallel");
					if (hasKey || isExaCall) return new Response("nope", { status: 500 });
					return okResponse(jsonEnvelope(PARALLEL_INNER));
				},
				async () => {
					const result = await tool.execute("t20", { query: "x" }, undefined, undefined, {});
					assert.deepEqual(seen, ["exa(key)", "exa", "parallel(key)", "parallel"]);
					assert.equal(result.details.provider, "parallel");
					assert.equal(result.details.channel, "free");
				},
			);
		},
	);
});

// 21. 429 的 Retry-After 会被尊重。
test("21. 429 的 Retry-After 体现在退避等待上", async () => {
	const startedAt = Date.now();
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_TIMEOUT_MS: "5000" }, async () => {
		await withFetch(
			(_url, _init, calls) =>
				calls === 1
					? new Response("slow down", { status: 429, headers: { "retry-after": "1" } })
					: okResponse(exaSse(EXA_BODY)),
			async () => {
				const result = await tool.execute("t21", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.provider, "exa");
			},
		);
	});
	assert.ok(Date.now() - startedAt >= 1000, "应至少等待 Retry-After 指定的 1 秒");
});

// 22. 退避等待必须可以被取消立即打断。
test("22. 重试等待期间取消会立即终止", async () => {
	const controller = new AbortController();
	await withEnv({ PI_WEB_SEARCH_RETRIES: "3", PI_WEB_SEARCH_TIMEOUT_MS: "5000" }, async () => {
		await withFetch(
			() => new Response("boom", { status: 503 }),
			async () => {
				const startedAt = Date.now();
				const pending = tool.execute("t22", { query: "x", provider: "exa" }, controller.signal, undefined, {});
				setTimeout(() => controller.abort(), 120);
				await assert.rejects(pending, /aborted/);
				assert.ok(Date.now() - startedAt < 1200, "取消不应等完退避");
			},
		);
	});
});

// 23. 回归：全局正则 URL_RE 的 lastIndex 不能污染行扫描结果。
test("23. 来源行扫描：多行 URL 全部被识别（正则状态回归）", async () => {
	// 连续三条 URL 行，不做任何分隔：旧实现里 isUrlLine() 的全局 test() 会把 lastIndex
	// 推过下一行，导致第 2、3 条 URL 被 matchAll 漏掉，这个用例正是为了卡住它。
	const body = ["https://example.com/1", "https://example.com/2", "https://example.com/3"].join("\n");
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			() => okResponse(exaSse(body)),
			async () => {
				const result = await tool.execute("t23", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.deepEqual(
					result.details.sources.map((source) => source.url),
					["https://example.com/1", "https://example.com/2", "https://example.com/3"],
				);
			},
		);
	});
});

// 24. maxResults 必须是整数。
test("24. maxResults 使用整数 schema", () => {
	assert.equal(tool.parameters?.properties?.maxResults?.type, "integer");
});

// 25. 未配置 key 时不应产生 key 通道请求。
test("25. 未配置 key 时不发起带凭据的请求", async () => {
	const seen = [];
	await withEnv(
		{ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_RETRIES: "0" },
		async () => {
			await withFetch(
				(url) => {
					seen.push(String(url));
					return okResponse(exaSse(EXA_BODY));
				},
				async () => {
					await tool.execute("t25", { query: "x", provider: "exa" }, undefined, undefined, {});
					assert.equal(seen.length, 1);
					assert.ok(!seen[0].includes("exaApiKey"));
				},
			);
		},
	);
});

// 26. details 必须能解释「这次搜索走的是哪条通道、为什么降级」。
test("26. details 记录 provider/channel/attemptCount/fallbackReason", async () => {
	await withEnv({ EXA_API_KEY: "test-key", PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			(url) => {
				if (String(url).includes("exaApiKey")) {
					return okResponse(
						JSON.stringify({
							result: { isError: true, content: [{ type: "text", text: "quota exhausted for this key" }] },
						}),
					);
				}
				return okResponse(exaSse(EXA_BODY));
			},
			async () => {
				const result = await tool.execute("t26", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.provider, "exa");
				assert.equal(result.details.channel, "free");
				assert.equal(result.details.attemptCount, 2);
				assert.match(String(result.details.fallbackReason), /exa\(key\)\[quota_exhausted\]/);
			},
		);
	});
});

// 27. 重试场景下 attemptCount 反映真实请求次数，且没有降级时不给 fallbackReason。
test("27. attemptCount 统计重试次数，未降级时无 fallbackReason", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_TIMEOUT_MS: "5000" }, async () => {
		await withFetch(
			(_url, _init, calls) =>
				calls === 1
					? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
					: okResponse(exaSse(EXA_BODY)),
			async () => {
				const result = await tool.execute("t27", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.attemptCount, 2);
				assert.equal(result.details.fallbackReason, undefined);
			},
		);
	});
});
