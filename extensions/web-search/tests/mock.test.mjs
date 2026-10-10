/**
 * 离线单元测试：用 jiti 加载 index.ts，替换 globalThis.fetch 为 mock，
 * 覆盖注册契约、Exa / Parallel 解析、auto 回退、取消 / 超时 / 重试语义，
 * 以及正文截断与落盘清理行为。全部用例不触网。
 *
 * 运行：node --test tests/mock.test.mjs
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

/** 用 jiti 加载被测的 TypeScript 入口。 */
const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;
const { createChannelHealth } = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));

/** fake 密钥库：默认「不可用」，测试永不触碰真实 Keychain / Secret Service。 */
function createFakeStore(overrides = {}) {
	return {
		kind: "none",
		read: async () => ({ status: "unavailable", reason: "测试未注入密钥库" }),
		clear: async () => ({ status: "unavailable", reason: "测试未注入密钥库" }),
		...overrides,
	};
}

/**
 * 创建一个独立的扩展实例（工具 + 命令），并注入 fake 凭据存储。
 * 每个实例独立注册，避免用例之间互相污染。
 */
function setup(options = {}) {
	const tools = [];
	const commands = [];
	plugin(
		{
			registerTool: (tool) => tools.push(tool),
			registerCommand: (name, command) => commands.push({ name, ...command }),
		},
		{
			credentialStore: options.credentialStore ?? createFakeStore(),
			...(options.channelHealth ? { channelHealth: options.channelHealth } : {}),
			...(options.quotaClock ? { quotaClock: options.quotaClock } : {}),
		},
	);
	if (tools.length === 0) throw new Error("扩展没有注册任何工具");
	return { tool: tools[0], tools, commands };
}

/** 默认实例：供既有用例使用。 */
const { tool, commands } = setup();

/** 隔离正文落盘测试目录，避免触碰系统临时目录中的其他结果。 */
const TEST_TMPDIR = fileURLToPath(new URL("../.temp/mock-test-tmp/", import.meta.url));
const SPILL_DIR = join(TEST_TMPDIR, "pi-web-search");
/** 需要按用例注入并在结束后恢复的环境变量。 */
const ENV_KEYS = [
	"PI_WEB_SEARCH_TIMEOUT_MS", "PI_WEB_SEARCH_RETRIES", "PI_WEB_SEARCH_ROUTING",
	"PI_WEB_SEARCH_ALLOW_BILLABLE", "PI_WEB_SEARCH_ALLOW_PAID", "PI_WEB_SEARCH_FREE_COOLDOWN_MS", "PI_WEB_SEARCH_MAX_RESPONSE_BYTES",
	"EXA_API_KEY", "PARALLEL_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "SERPAPI_API_KEY",
];
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
	const usageCalls = [];
	globalThis.fetch = (url, init) => {
		const address = String(url);
		if (init?.method === "GET" && (address === "https://api.tavily.com/usage" || address === "https://api.firecrawl.dev/v2/team/credit-usage")) {
			usageCalls.push({ url: address, init });
			const body = address === "https://api.tavily.com/usage"
				? { key: { usage: 0, limit: 1000 }, account: { plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }
				: { success: true, data: { remainingCredits: 1000 } };
			return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
		}
		calls += 1;
		return impl(url, init, calls);
	};
	const getCalls = () => calls; // 返回值仅统计搜索请求；额度 GET 另存在 usageCalls。
	getCalls.usageCalls = usageCalls;
	try {
		return await fn(getCalls);
	} finally {
		globalThis.fetch = original;
	}
}

/** 注入环境变量，结束后恢复原值（含删除此前不存在的键）。 */
async function withEnv(vars, fn) {
	const merged = {
		PI_WEB_SEARCH_TIMEOUT_MS: "25000",
		PI_WEB_SEARCH_RETRIES: "1",
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_ALLOW_BILLABLE: undefined,
		PI_WEB_SEARCH_ALLOW_PAID: undefined,
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		PI_WEB_SEARCH_MAX_RESPONSE_BYTES: undefined,
		TMPDIR: TEST_TMPDIR,
		EXA_API_KEY: undefined,
		PARALLEL_API_KEY: undefined,
		TAVILY_API_KEY: undefined,
		FIRECRAWL_API_KEY: undefined,
		SERPAPI_API_KEY: undefined,
		...vars,
	};
	const saved = {};
	for (const key of Object.keys(merged)) saved[key] = process.env[key];
	for (const [key, value] of Object.entries(merged)) {
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
	await withEnv({}, () => withFetch(() => Promise.resolve(okResponse(exaSse(EXA_BODY))), async () => {
		const result = await tool.execute("t2", { query: "hello", provider: "exa" });
		assert.equal(result.details.provider, "exa");
		assert.equal(result.details.sources[0].url, "https://example.com/a");
		assert.match(result.content[0].text, /Title: T/);
		assert.match(result.content[0].text, /摘要/);
	}));
});

test("3. Parallel 直接 JSON 响应转 Markdown", async () => {
	await withEnv({}, () => withFetch(() => Promise.resolve(okResponse(jsonEnvelope(PARALLEL_INNER))), async () => {
		const result = await tool.execute("t3", { query: "parallel", maxResults: 3, provider: "parallel" });
		assert.equal(result.details.provider, "parallel");
		assert.ok(result.details.sourceCount <= 3);
		assert.equal(result.details.sources[0].url, "https://example.com/b");
		assert.match(result.content[0].text, /\[B\]\(https:\/\/example\.com\/b\)/);
		assert.match(result.content[0].text, /片段/);
	}));
});

test("4. auto 匿名通道 Parallel 故障后回退 Exa", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			(url) => (String(url).includes("search.parallel.ai") ? Promise.reject(new TypeError("network down")) : Promise.resolve(okResponse(exaSse(EXA_BODY)))),
			async () => {
				const result = await tool.execute("t4", { query: "fallback" });
				assert.equal(result.details.provider, "exa");
			},
		);
	});
});

test("5. 调用方取消：aborted 且快速返回", async () => {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 60);
	try {
		await withEnv({}, () => withFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				}),
			async () => {
				const startedAt = Date.now();
				await assert.rejects(
					tool.execute("t5", { query: "cancel", provider: "exa" }, controller.signal),
					(error) => {
						assert.ok(error instanceof DOMException);
						assert.match(error.message, /aborted/);
						assert.equal(error.name, "AbortError");
						return true;
					},
				);
				assert.ok(Date.now() - startedAt < 2000, "取消应在 2 秒内返回");
			},
		));
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
	// 自制响应流不随 fetch 的 signal 自动终止，验证有界 reader 能被预算超时打断。
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "100", PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			() => Promise.resolve({ ok: true, status: 200, body: new ReadableStream({}) }),
			async () => {
				await assert.rejects(tool.execute("t7", { query: "hang", provider: "exa" }), /timed out/);
			},
		);
	});
});

test("8. 429 立即冷却：Exa 同通道不得重试", async () => {
	await withEnv({ PI_WEB_SEARCH_TIMEOUT_MS: "2000", PI_WEB_SEARCH_RETRIES: "1" }, async () => {
		await withFetch(
			() => Promise.resolve(new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })),
			async (getCalls) => {
				await assert.rejects(tool.execute("t8", { query: "retry", provider: "exa" }), /429|rate limited/u);
				assert.equal(getCalls(), 1, "429 应仅请求一次并切换通道");
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

test("10. auto 默认禁止计费：全部匿名通道均失败时保留完整错误", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			() => Promise.resolve(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 503 })),
			async (getCalls) => {
				await assert.rejects(tool.execute("t10", { query: "both" }), (error) => {
					for (const backend of ["exa", "tavily", "parallel", "firecrawl", "tinyfish"]) {
						assert.match(error.message, new RegExp(backend));
					}
					return true;
				});
				assert.equal(getCalls(), 5, "无授权时只尝试匿名通道，不应吞掉失败或访问计费通道");
			},
		);
	});
});

test("11. 空 query 直接拒绝", async () => {
	await assert.rejects(tool.execute("t11", { query: "   " }), /query must not be empty/);
});

test("12. 超长正文截断并落盘（0600 / 完整写入）", async () => {
	const bigBody = `Title: Big\nURL: https://example.com/big\nHighlights:\n${"x".repeat(40000)}`;
	await withEnv({}, () => withFetch(() => Promise.resolve(okResponse(exaSse(bigBody))), async () => {
		const result = await tool.execute("t12", { query: "big", provider: "exa" });
		assert.equal(result.details.truncated, true);
		assert.equal(result.details.fullTextComplete, true);
		assert.equal(typeof result.details.fullTextPath, "string");
		const stats = statSync(result.details.fullTextPath);
		assert.equal(stats.mode & 0o777, 0o600, "落盘文件权限应为 0600");
		assert.ok(readFileSync(result.details.fullTextPath, "utf8").length >= 40000);
	}));
});

test("13. 落盘上限：超过 2MB 只写 2MB", async () => {
	const hugeBody = `Title: Huge\nURL: https://example.com/huge\nHighlights:\n${"z".repeat(2 * 1024 * 1024 + 8192)}`;
	await withEnv({}, () => withFetch(() => Promise.resolve(okResponse(exaSse(hugeBody))), async () => {
		const result = await tool.execute("t13", { query: "huge", provider: "exa" });
		assert.equal(result.details.truncated, true);
		assert.equal(result.details.fullTextComplete, false);
		assert.ok(statSync(result.details.fullTextPath).size <= 2 * 1024 * 1024);
	}));
});

test("14. 落盘目录只保留最近 20 个 results-*.txt", async () => {
	mkdirSync(SPILL_DIR, { recursive: true, mode: 0o700 });
	for (let i = 0; i < 25; i++) {
		writeFileSync(join(SPILL_DIR, `results-0000000000000-${String(i).padStart(4, "0")}.txt`), "stale");
	}
	const bigBody = `Title: Prune\nURL: https://example.com/prune\nHighlights:\n${"p".repeat(40000)}`;
	await withEnv({}, () => withFetch(() => Promise.resolve(okResponse(exaSse(bigBody))), async () => {
		await tool.execute("t14", { query: "prune", provider: "exa" });
	}));
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

// 18. 授权也先走匿名；匿名失败后才读取并尝试 Exa Key。
test("18. 匿名 Exa 失败后切换已授权密钥通道", async () => {
	const seen = [];
	await withEnv({ EXA_API_KEY: "test-key", PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		await withFetch(
			(url) => {
				seen.push(String(url));
				return String(url).includes("exaApiKey") ? okResponse(exaSse(EXA_BODY)) : new Response("anonymous unavailable", { status: 503 });
			},
			async () => {
				const result = await tool.execute("t18", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.channel, "key");
				assert.equal(result.details.provider, "exa");
				assert.equal(seen.length, 2);
				assert.ok(!seen[0].includes("exaApiKey"));
				assert.ok(seen[1].includes("exaApiKey=test-key"));
			},
		);
	});
});

// 19. 授权 Key 在匿名失败后使用；401 不重试，也不倒回已尝试匿名通道。
test("19. 匿名失败后 Key 401 不重试且不重复匿名", async () => {
	const seen = [];
	await withEnv({ PARALLEL_API_KEY: "bad-key", PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		await withFetch(
			(url, init) => {
				seen.push({ url: String(url), auth: init?.headers?.authorization });
				if (init?.headers?.authorization) return new Response("invalid api key", { status: 401 });
				return new Response("anonymous rate limited", { status: 429 });
			},
			async () => {
				await assert.rejects(tool.execute("t19", { query: "x", provider: "parallel" }, undefined, undefined, {}), /401/u);
				assert.equal(seen.length, 2);
				assert.equal(seen[0].auth, undefined);
				assert.equal(seen[1].auth, "Bearer bad-key");
			},
		);
	});
});

// 20. auto 必须跑完匿名数组，之后才按 Exa、Parallel 的付费顺序尝试已配置 Key。
test("20. 全部匿名优先，随后按计费顺序尝试已配置 Key", async () => {
	const seen = [];
	await withEnv(
		{ EXA_API_KEY: "k1", PARALLEL_API_KEY: "k2", PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" },
		async () => {
			await withFetch(
				(url, init) => {
					const address = String(url);
					const isExaCall = address.includes("mcp.exa.ai");
					const hasKey = isExaCall ? address.includes("exaApiKey") : Boolean(init?.headers?.authorization);
					const backend = isExaCall
						? "exa"
						: address.includes("api.tavily.com")
							? "tavily"
							: address.includes("firecrawl.dev")
								? "firecrawl"
								: address.includes("agent.tinyfish.ai")
									? "tinyfish"
									: "parallel";
					seen.push(hasKey ? `${backend}(key)` : backend);
					if (hasKey && backend === "parallel") return okResponse(jsonEnvelope(PARALLEL_INNER));
					return new Response("anonymous/key unavailable", { status: 503 });
				},
				async () => {
					const result = await tool.execute("t20", { query: "x" }, undefined, undefined, {});
					assert.deepEqual(seen, ["exa", "tavily", "parallel", "firecrawl", "tinyfish", "exa(key)", "parallel(key)"]);
					assert.equal(result.details.provider, "parallel");
					assert.equal(result.details.channel, "key");
				},
			);
		},
	);
});

// 21. 5xx 保留一次有界重试；429 的即时冷却由其他断言覆盖。
test("21. 5xx 退避后最多重试一次", async () => {
	const startedAt = Date.now();
	await withEnv({ PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_TIMEOUT_MS: "5000" }, async () => {
		await withFetch(
			(_url, _init, calls) => calls === 1
				? new Response("upstream unavailable", { status: 503 })
				: okResponse(exaSse(EXA_BODY)),
			async (getCalls) => {
				const result = await tool.execute("t21", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.provider, "exa");
				assert.equal(getCalls(), 2);
			},
		);
	});
	assert.ok(Date.now() - startedAt >= 350, "5xx 重试应使用有界退避");
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

// 26. details 必须能解释匿名失败后转入获授权密钥通道的原因。
test("26. details 记录匿名失败转入 Key 的 provider/channel/attemptCount/fallbackReason", async () => {
	await withEnv({ EXA_API_KEY: "test-key", PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		await withFetch(
			(url) => String(url).includes("exaApiKey")
				? okResponse(exaSse(EXA_BODY))
				: new Response("anonymous unavailable", { status: 503 }),
			async () => {
				const result = await tool.execute("t26", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.provider, "exa");
				assert.equal(result.details.channel, "key");
				assert.equal(result.details.attemptCount, 2);
				assert.match(String(result.details.fallbackReason), /exa\[server_error\]/);
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
					? new Response("upstream unavailable", { status: 503 })
					: okResponse(exaSse(EXA_BODY)),
			async () => {
				const result = await tool.execute("t27", { query: "x", provider: "exa" }, undefined, undefined, {});
				assert.equal(result.details.attemptCount, 2);
				assert.equal(result.details.fallbackReason, undefined);
			},
		);
	});
});

// 28. auto free-first 在显式授权后先尝试四个匿名通道，再按独立计费顺序尝试密钥。
test("28. auto free-first：四匿名优先，再按计费顺序尝试密钥", async () => {
	const order = [];
	await withEnv({
		EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "parallel-key",
		TAVILY_API_KEY: "tavily-key", FIRECRAWL_API_KEY: "firecrawl-key", SERPAPI_API_KEY: "serp-key",
		PI_WEB_SEARCH_ALLOW_BILLABLE: "true",
		PI_WEB_SEARCH_RETRIES: "0",
	}, async () => {
		await withFetch(
			(url, init) => {
				if (String(url).includes("mcp.exa.ai")) order.push(String(url).includes("exaApiKey") ? "exa(key)" : "exa");
				else if (String(url).includes("search.parallel.ai")) order.push(init.headers.authorization ? "parallel(key)" : "parallel");
				else if (String(url).includes("api.tavily.com")) order.push(init.headers.authorization ? "tavily(key)" : "tavily");
				else if (String(url).includes("firecrawl.dev")) order.push(init.headers.authorization ? "firecrawl(key)" : "firecrawl");
				else if (String(url).includes("agent.tinyfish.ai")) order.push(init.headers["X-TinyFish-Access-Mode"] === "keyless" ? "tinyfish" : "other");
				else order.push("serpapi(key)");
				return new Response("failure", { status: 500 });
			},
			async () => {
				await assert.rejects(tool.execute("t28", { query: "x" }));
				assert.deepEqual(order, ["exa", "tavily", "parallel", "firecrawl", "tinyfish", "exa(key)", "tavily(key)", "parallel(key)", "firecrawl(key)", "serpapi(key)"]);
			},
		);
	});
});

test("29. 显式 provider 始终匿名优先，授权 key-first 明确拒绝", async () => {
	await withEnv({ EXA_API_KEY: "exa-key", PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			(url) => {
				assert.ok(!String(url).includes("exaApiKey"));
				return okResponse(exaSse(EXA_BODY));
			},
			async (getCalls) => {
				const result = await tool.execute("t29", { query: "x", provider: "exa" });
				assert.equal(result.details.channel, "free");
				assert.equal(getCalls(), 1);
			},
		),
	);
	await withEnv({ EXA_API_KEY: "exa-key", PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ROUTING: "key-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, () =>
		withFetch(
			() => { throw new Error("冲突配置不得发送请求"); },
			async (getCalls) => {
				await assert.rejects(tool.execute("t29b", { query: "x", provider: "exa" }), /free-first/u);
				assert.equal(getCalls(), 0);
			},
		),
	);
});

test("30. Exa 免费额度提示归类为 quota_exhausted，近似普通文本不误判", async () => {
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0" }, async () => {
		await withFetch(
			() => okResponse(exaSse("You’ve hit Exa’s free MCP rate limit! Please retry later.")),
			async () => {
				await assert.rejects(
					tool.execute("t30", { query: "x", provider: "exa" }),
					/You’ve hit Exa’s free MCP rate limit/,
				);
			},
		);
		await withFetch(
			() => okResponse(exaSse("You've hit Exa's free MCP rate limiter details\n" + EXA_BODY)),
			async () => {
				const result = await tool.execute("t30b", { query: "x", provider: "exa" });
				assert.equal(result.details.sources[0].url, "https://example.com/a");
			},
		);
	});
});

test("31. 通道冷却跳过网络请求，到期后成功清除状态", async () => {
	let now = 1_000;
	const health = createChannelHealth({ clock: () => now });
	const isolatedTool = setup({ channelHealth: health, quotaClock: () => now }).tool;
	await withEnv({ PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "1000" }, async () => {
		await withFetch(
			() => okResponse(exaSse("You've hit Exa's free MCP rate limit.")),
			async () => assert.rejects(isolatedTool.execute("t31", { query: "x", provider: "exa" })),
		);
		assert.equal(health.snapshot().channels[0].backend, "exa");
		await withFetch(
			() => { throw new Error("冷却期间不应请求网络"); },
			async (getCalls) => {
				await assert.rejects(isolatedTool.execute("t31b", { query: "x", provider: "exa" }), /冷却/);
				assert.equal(getCalls(), 0);
			},
		);
		now += 1000;
		await withFetch(
			() => okResponse(exaSse(EXA_BODY)),
			async () => {
				const result = await isolatedTool.execute("t31c", { query: "x", provider: "exa" });
				assert.equal(result.details.channel, "free");
			},
		);
		assert.deepEqual(health.snapshot().channels, []);
	});
});

test("32. 429 只发一次搜索请求并按 Retry-After 立即冷却", async () => {
	let now = 0;
	const health = createChannelHealth({ clock: () => now });
	const isolatedTool = setup({ channelHealth: health }).tool;
	const waits = [];
	const originalSetTimeout = globalThis.setTimeout;
	globalThis.setTimeout = (callback, ms, ...args) => {
		if (ms >= 400 && ms <= 5000) waits.push(ms);
		return originalSetTimeout(callback, ms, ...args);
	};
	try {
		await withEnv({ PI_WEB_SEARCH_RETRIES: "1", PI_WEB_SEARCH_TIMEOUT_MS: "10000", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "300000" }, async () => {
			await withFetch(
				() => new Response("slow down", { status: 429, headers: { "retry-after": "60" } }),
				async (getCalls) => {
					await assert.rejects(isolatedTool.execute("t32", { query: "x", provider: "exa" }));
					assert.equal(getCalls(), 1);
				},
			);
		});
	} finally {
		globalThis.setTimeout = originalSetTimeout;
	}
	assert.deepEqual(waits, [], "429 不应等待同通道重试");
	assert.equal(health.snapshot().channels[0].remainingMs, 60_000);
});

test("33. 用户取消立即终止且不记录冷却状态", async () => {
	const health = createChannelHealth({ clock: () => 0 });
	const isolatedTool = setup({ channelHealth: health }).tool;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20);
	try {
		await withEnv({ PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_FREE_COOLDOWN_MS: "1000" }, () =>
			withFetch(
				(_url, init) => new Promise((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
				}),
				async () => {
					await assert.rejects(
						isolatedTool.execute("t33", { query: "x", provider: "exa" }, controller.signal),
					(error) => error.name === "AbortError",
					);
				},
			),
		);
	} finally {
		clearTimeout(timer);
	}
	assert.deepEqual(health.snapshot().channels, []);
});
