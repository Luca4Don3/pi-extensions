/** 整次调用总时间预算：与单请求超时区分，耗尽后不再尝试后续通道，取消优先。 */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;

const ENV_KEYS = [
	"PI_WEB_SEARCH_TIMEOUT_MS", "PI_WEB_SEARCH_RETRIES", "PI_WEB_SEARCH_TOTAL_TIMEOUT_MS",
	"PI_WEB_SEARCH_ROUTING", "PI_WEB_SEARCH_ALLOW_BILLABLE", "PI_WEB_SEARCH_ALLOW_PAID",
	"PI_WEB_SEARCH_FREE_COOLDOWN_MS", "TMPDIR",
	"EXA_API_KEY", "PARALLEL_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_API_KEY", "SERPAPI_API_KEY",
];

async function withEnv(vars, fn) {
	const merged = {
		PI_WEB_SEARCH_TIMEOUT_MS: undefined,
		PI_WEB_SEARCH_RETRIES: undefined,
		PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: undefined,
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_ALLOW_BILLABLE: undefined,
		PI_WEB_SEARCH_ALLOW_PAID: undefined,
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		TMPDIR: undefined,
		EXA_API_KEY: undefined,
		PARALLEL_API_KEY: undefined,
		TAVILY_API_KEY: undefined,
		FIRECRAWL_API_KEY: undefined,
		SERPAPI_API_KEY: undefined,
		...vars,
	};
	const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
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

/** 永不结束的请求：不遵守 AbortSignal，只能靠预算与取消中断。 */
const hangingFetch = () => new Promise(() => undefined);

async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = impl === "hang"
		? () => { calls += 1; return hangingFetch(); }
		: (url, init) => { calls += 1; return impl(url, init); };
	try {
		return await fn(() => calls);
	} finally {
		globalThis.fetch = original;
	}
}

/** 注册独立实例；凭据库不可用且读取被计数，用于验证预算早于凭据读取。 */
function registerTool() {
	let reads = 0;
	const tools = [];
	plugin({ registerTool: (value) => { tools.push(value); }, registerCommand() {} }, {
		credentialStore: {
			kind: "none",
			read: async () => { reads += 1; throw new Error("不得在预算校验前读取凭据"); },
		},
	});
	return { tool: tools[0], reads: () => reads };
}

const sse = (text) => `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: "text", text }] } })}\n\n`;

test("极小总预算：多个匿名通道均挂起时请求次数与总耗时有界并报预算耗尽", async () => {
	await withEnv({ PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: "1000", PI_WEB_SEARCH_TIMEOUT_MS: "400", PI_WEB_SEARCH_RETRIES: "0" },
		async () => await withFetch("hang", async (getCalls) => {
			const { tool } = registerTool();
			const startedAt = Date.now();
			await assert.rejects(tool.execute("budget", { query: "慢", provider: "auto" }), (error) => {
				// 最终失败归类为预算耗尽，而非单请求超时。
				assert.match(error.message, /总时间预算已用尽/);
				assert.match(error.message, /\[budget_exhausted\]/);
				return true;
			});
			const elapsed = Date.now() - startedAt;
			assert.ok(getCalls() <= 4, `请求次数 ${getCalls()} 应有界`);
			assert.ok(elapsed < 10_000, `总耗时 ${elapsed}ms 应有界`);
		}));
});

test("单通道打满总预算即停止，不再尝试后续通道", async () => {
	await withEnv({ PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: "1000", PI_WEB_SEARCH_TIMEOUT_MS: "5000", PI_WEB_SEARCH_RETRIES: "0" },
		async () => await withFetch("hang", async (getCalls) => {
			const { tool } = registerTool();
			const startedAt = Date.now();
			await assert.rejects(tool.execute("budget", { query: "慢", provider: "auto" }), /总时间预算已用尽/);
			assert.equal(getCalls(), 1, "预算耗尽后不得尝试下一通道");
			assert.ok(Date.now() - startedAt < 8_000, "应在预算用尽时立即停止");
		}));
});

test("累计退避可被总预算中断，不做无界 sleep", async () => {
	await withEnv({ PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: "1000", PI_WEB_SEARCH_TIMEOUT_MS: "300", PI_WEB_SEARCH_RETRIES: "3" },
		async () => await withFetch(() => Promise.resolve(new Response("server unavailable", { status: 503 })), async (getCalls) => {
			const { tool } = registerTool();
			const startedAt = Date.now();
			await assert.rejects(tool.execute("budget", { query: "退避", provider: "exa" }), /总时间预算已用尽/);
			assert.ok(getCalls() <= 2, `退避被预算中断后不得继续请求，实际 ${getCalls()}`);
			assert.ok(Date.now() - startedAt < 8_000, "退避等待不得无界延长");
		}));
});

test("非法总预算在任何网络与凭据读取之前显式报错且不回显", async () => {
	for (const value of ["999", "500", "600001", "-1", "abc", "1.5", "Infinity", "非法标记"]) {
		await withEnv({ PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: value }, async () => {
			await withFetch("hang", async (getCalls) => {
				const { tool, reads } = registerTool();
				await assert.rejects(tool.execute("budget", { query: "配置", provider: "exa" }), (error) => {
					assert.match(error.message, /^PI_WEB_SEARCH_TOTAL_TIMEOUT_MS 配置无效：必须是 1000\.\.600000 范围内的安全整数$/u);
					assert.equal(error.message.includes(String(value)), false, "不得回显原值");
					return true;
				});
				assert.equal(getCalls(), 0, "不得发出网络请求");
				assert.equal(reads(), 0, "不得读取凭据");
			});
		});
	}
});

test("默认总预算不改变既有成功路径", async () => {
	await withEnv({}, async () => await withFetch(() => Promise.resolve(new Response(sse("Title: T\nURL: https://example.com/a\nHighlights:\n摘要"), { status: 200 })), async (getCalls) => {
		const { tool } = registerTool();
		const result = await tool.execute("budget", { query: "默认", provider: "exa" });
		assert.equal(result.details.provider, "exa");
		assert.equal(result.details.attemptCount, 1);
		assert.equal(getCalls(), 1);
	}));
});

test("外部取消优先级高于总预算", async () => {
	await withEnv({ PI_WEB_SEARCH_TOTAL_TIMEOUT_MS: "3000", PI_WEB_SEARCH_TIMEOUT_MS: "2000", PI_WEB_SEARCH_RETRIES: "0" },
		async () => await withFetch("hang", async (getCalls) => {
			const { tool } = registerTool();
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 60);
			try {
				const startedAt = Date.now();
				await assert.rejects(tool.execute("budget", { query: "取消", provider: "exa" }, controller.signal), (error) => {
					assert.equal(error.name, "AbortError");
					return true;
				});
				assert.ok(Date.now() - startedAt < 1_500, "取消应立即返回");
			} finally {
				clearTimeout(timer);
			}
			assert.equal(getCalls(), 1);
		}));
});
