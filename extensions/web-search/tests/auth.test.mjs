/**
 * 离线认证测试：加载 auth.ts / credentials.ts / auth-ui.ts / index.ts，
 * 用 fake 密钥库与 fake fetch 覆盖「key 解析、状态三态、脱敏、菜单交互、
 * 平台命令拼装」。全部用例不触网、不访问真实 Keychain / Secret Service。
 *
 * 运行：node --test tests/auth.test.mjs
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

for (const key of [
	"EXA_API_KEY",
	"PARALLEL_API_KEY",
	"TAVILY_API_KEY",
	"SERPAPI_API_KEY",
	"FIRECRAWL_API_KEY",
	"PI_WEB_SEARCH_ROUTING",
	"PI_WEB_SEARCH_ALLOW_BILLABLE",
	"PI_WEB_SEARCH_ALLOW_PAID",
	"PI_WEB_SEARCH_FREE_COOLDOWN_MS",
	"PI_WEB_SEARCH_TIMEOUT_MS",
	"PI_WEB_SEARCH_RETRIES",
	"PI_WEB_SEARCH_MAX_RESPONSE_BYTES",
]) {
	delete process.env[key];
}

const jiti = createJiti(import.meta.url);
const auth = await jiti.import(fileURLToPath(new URL("../auth.ts", import.meta.url)));
const credentials = await jiti.import(fileURLToPath(new URL("../credentials.ts", import.meta.url)));
const channelHealthModule = await jiti.import(fileURLToPath(new URL("../channel-health.ts", import.meta.url)));
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;

/** 测试用的超敏 key：任何对外文本都不应出现它。 */
const SECRET = "exa_test_SUPER_SECRET_123";
/** 含特殊字符的 key，用于验证 URL 编码形式也被脱敏。 */
const SPECIAL_SECRET = "exa+test/SUPER SECRET=123";

/** 构造一个 fake 密钥库。 */
function fakeStore({ kind = "keychain", read, write, clear } = {}) {
	return {
		kind,
		read: read ?? (async () => ({ status: "missing" })),
		write: write ?? (async () => ({ status: "unavailable", reason: "fake 未配置写入" })),
		clear: clear ?? (async () => ({ status: "missing" })),
	};
}

/** 注册扩展并返回工具与命令；注入 fake 密钥库。 */
function setup(store = fakeStore(), options = {}) {
	const tools = [];
	const commands = [];
	plugin(
		{
			registerTool: (tool) => tools.push(tool),
			registerCommand: (name, command) => commands.push({ name, ...command }),
			on: () => undefined,
		},
		{ credentialStore: store, ...options },
	);
	if (tools.length === 0) throw new Error("扩展没有注册任何工具");
	return { tool: tools[0], commands, authCommand: commands.find((c) => c.name === "web-search-auth") };
}

/** 注入环境变量，结束后恢复原值（含删除此前不存在的键）。 */
async function withEnv(vars, fn) {
	const merged = {
		PI_WEB_SEARCH_ROUTING: "free-first",
		PI_WEB_SEARCH_ALLOW_BILLABLE: undefined,
		PI_WEB_SEARCH_ALLOW_PAID: undefined,
		PI_WEB_SEARCH_FREE_COOLDOWN_MS: "0",
		PI_WEB_SEARCH_RETRIES: "0",
		PI_WEB_SEARCH_TIMEOUT_MS: "25000",
		PI_WEB_SEARCH_MAX_RESPONSE_BYTES: undefined,
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

/** 替换 globalThis.fetch，结束后恢复。 */
async function withFetch(impl, fn) {
	const original = globalThis.fetch;
	const usageCalls = []; // 额度 GET 独立记录并返回 fixture，不交给搜索回调。
	globalThis.fetch = (url, init) => {
		const address = String(url);
		if (init?.method === "GET" && (address === "https://api.tavily.com/usage" || address === "https://api.firecrawl.dev/v2/team/credit-usage")) {
			usageCalls.push({ url: address, init });
			const body = address === "https://api.tavily.com/usage"
				? { key: { usage: 0, limit: 1000 }, account: { plan_usage: 0, plan_limit: 1000, paygo_usage: 0, paygo_limit: 0 } }
				: { success: true, data: { remainingCredits: 1000 } };
			return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
		}
		return impl(url, init);
	};
	try {
		return await fn();
	} finally {
		globalThis.fetch = original;
	}
}

/** fake 命令上下文：select / confirm / notify 都由脚本驱动，并记录通知。 */
function fakeCtx({ selections = [], confirms = [], hasUI = true } = {}) {
	const selectQueue = [...selections];
	const confirmQueue = [...confirms];
	const notes = [];
	return {
		hasUI,
		mode: hasUI ? "tui" : "print",
		ui: {
			select: async () => selectQueue.shift(),
			confirm: async () => confirmQueue.shift() ?? false,
			notify: (message, type) => notes.push({ message, type: type ?? "info" }),
		},
		notes,
	};
}

const EXA_PARAMS = { query: "q", provider: "exa" };

// 1. 环境变量优先于系统密钥库。
test("auth: 环境变量优先于系统密钥库", async () => {
	const store = fakeStore({ read: async () => ({ status: "found", value: "from-store" }) });
	await withEnv({ EXA_API_KEY: "from-env", FIRECRAWL_API_KEY: "firecrawl-from-env", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		assert.equal(await auth.resolveBackendKey("exa", store), "from-env");
		assert.equal(await auth.resolveBackendKey("firecrawl", store), "firecrawl-from-env");
		const status = await auth.probeBackendStatus("exa", store);
		assert.equal(status.state, "configured");
		assert.equal(status.source, "env");
	});
});

// 2. 状态必须区分 configured / not_configured / unavailable。
test("auth: 状态区分 configured / not_configured / unavailable", async () => {
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined }, async () => {
		const configured = await auth.probeBackendStatus(
			"exa",
			fakeStore({ read: async () => ({ status: "found", value: "k" }) }),
		);
		assert.equal(configured.state, "configured");
		assert.equal(configured.source, "keychain");

		const missing = await auth.probeBackendStatus("exa", fakeStore({ read: async () => ({ status: "missing" }) }));
		assert.equal(missing.state, "not_configured");

		const unavailable = await auth.probeBackendStatus(
			"parallel",
			fakeStore({ read: async () => ({ status: "unavailable", reason: "密钥库已锁定" }) }),
		);
		assert.equal(unavailable.state, "unavailable");
		assert.match(unavailable.reason, /锁定/);
	});
});

// 3. 读取失败不阻断匿名搜索：resolve 返回 undefined，但状态是 unavailable。
test("auth: 密钥库读取异常不阻断匿名搜索", async () => {
	const store = fakeStore({
		read: async () => {
			throw new Error(`keychain exploded ${SECRET}`);
		},
	});
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined }, async () => {
		assert.equal(await auth.resolveBackendKey("exa", store), undefined);
		const status = await auth.probeBackendStatus("exa", store);
		assert.equal(status.state, "unavailable");
		assert.ok(!String(status.reason).includes(SECRET), "状态不应泄露 key");
	});
});

// 4. 配置说明推荐掩码菜单与静态 Swift 适配器，不建议 argv 密钥或明文文件。
test("auth: 配置说明推荐安全掩码写入且不建议 argv 密钥或明文文件", () => {
	const mac = auth.configGuide("exa", "keychain").lines.join("\n");
	assert.match(mac, /\/web-search-auth/u);
	assert.match(mac, /掩码/u);
	assert.match(mac, /macos-keychain\.swift|Swift.{0,12}(?:静态|适配器)|(?:静态|适配器).{0,12}Swift/iu);
	assert.ok(!/security add-generic-password/u.test(mac), "不应再推荐 security -w 命令");
	assert.ok(!/\bexport\s+[A-Z0-9_]+_API_KEY\s*=/u.test(mac), "不应建议把 key 写入 shell 文件");
	assert.ok(!/^\s*(?:echo|printf|tee)\b[^\n]*(?:>>?\s*~\/|\.zshrc|\.bashrc|\.profile|\.env)/imu.test(mac), "不应建议写入明文配置文件");
	assert.ok(!mac.includes(SECRET), "配置说明不应包含任何 key");

	const linux = auth.configGuide("parallel", "secret-tool").lines.join("\n");
	assert.match(linux, /\/web-search-auth/u);
	assert.ok(!/secret-tool store[^\n]*\b(?:key|secret)\s*=/iu.test(linux), "key 不能作为参数");
	assert.ok(!/\bexport\s+[A-Z0-9_]+_API_KEY\s*=/u.test(linux), "不应建议把 key 写入 shell 文件");
	assert.ok(!/^\s*(?:echo|printf|tee)\b[^\n]*(?:>>?\s*~\/|\.zshrc|\.bashrc|\.profile|\.env)/imu.test(linux), "不应建议写入明文配置文件");
});

// 5. 脱敏覆盖原文与 URL 编码形式。
test("auth: redactSecrets 覆盖原文与 URL 编码形式", () => {
	const encoded = encodeURIComponent(SPECIAL_SECRET);
	const lowercaseEncoded = encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
	const formEncoded = new URLSearchParams({ key: SPECIAL_SECRET }).toString().slice("key=".length);
	const text = `raw=${SECRET} special=${SPECIAL_SECRET} url=${encoded} lower=${lowercaseEncoded} form=${formEncoded}`;
	const safe = auth.redactSecrets(text, [SECRET, SPECIAL_SECRET]);
	assert.ok(!safe.includes(SECRET));
	assert.ok(!safe.includes(SPECIAL_SECRET));
	assert.ok(!safe.includes(encoded));
	assert.ok(!safe.includes(lowercaseEncoded));
	assert.ok(!safe.includes(formEncoded));
	assert.match(safe, /\*\*\*/);
});

// 6. macOS 密钥库命令与退出码语义（runner 注入，不碰真实 Keychain）。
test("credentials: macOS 读 / 删命令与退出码语义", async () => {
	const calls = [];
	const run = async (bin, args) => {
		calls.push({ bin, args });
		return { code: 0, stdout: "stored-secret\n", stderr: "" };
	};
	const store = new credentials.MacKeychainStore(run, "tester");
	assert.equal(store.kind, "keychain");
	const found = await store.read("exa");
	assert.deepEqual(found, { status: "found", value: "stored-secret" });
	assert.deepEqual(calls[0].args, ["find-generic-password", "-a", "tester", "-s", "pi-web-search-exa", "-w"]);

	const missingRun = async () => ({ code: 44, stdout: "", stderr: "not found" });
	assert.equal((await new credentials.MacKeychainStore(missingRun, "tester").read("exa")).status, "missing");
	const brokenRun = async () => ({ code: 1, stdout: "", stderr: "locked" });
	assert.equal((await new credentials.MacKeychainStore(brokenRun, "tester").read("exa")).status, "unavailable");
	assert.equal((await new credentials.MacKeychainStore(brokenRun, "tester").clear("exa")).status, "unavailable");
});

// 7. Linux secret-tool 命令拼装与三态。
test("credentials: Linux secret-tool 命令与三态", async () => {
	const calls = [];
	const run = async (bin, args) => {
		calls.push({ bin, args });
		return { code: 0, stdout: "linux-secret\n", stderr: "" };
	};
	const store = new credentials.SecretToolStore(run);
	assert.equal(store.kind, "secret-tool");
	assert.equal((await store.read("parallel")).status, "found");
	assert.deepEqual(calls[0].args, ["lookup", "service", "pi-web-search", "provider", "parallel"]);
	assert.equal((await store.clear("parallel")).status, "deleted");
	assert.deepEqual(calls[2].args, ["clear", "service", "pi-web-search", "provider", "parallel"]);

	const notFound = new credentials.SecretToolStore(async () => ({ code: 1, stdout: "", stderr: "" }));
	assert.equal((await notFound.read("exa")).status, "missing");
	const gone = new credentials.SecretToolStore(async () => ({ code: 0, stdout: "", stderr: "" }));
	assert.equal((await gone.read("exa")).status, "missing");
});

// 8. 无系统密钥库的平台：只读 env / free。
test("credentials: 不支持的平台返回 unavailable", async () => {
	for (const platform of ["win32", "freebsd"]) {
		const store = credentials.createSecretStore(platform, async () => ({ code: 0, stdout: "x", stderr: "" }));
		assert.equal(store.kind, "none");
		assert.equal((await store.read("exa")).status, "unavailable");
		assert.equal((await store.clear("exa")).status, "unavailable");
	}
	assert.equal(credentials.createSecretStore("darwin", async () => ({ code: 0, stdout: "", stderr: "" })).kind, "keychain");
	assert.equal(credentials.createSecretStore("linux", async () => ({ code: 0, stdout: "", stderr: "" })).kind, "secret-tool");
});

// 9. 系统密钥库里的 Exa key 会进入 URL，且每次搜索只解析一次。
test("auth: Exa key 进入 URL，每次搜索只读一次密钥库", async () => {
	let reads = 0;
	const store = fakeStore({
		read: async (backend) => {
			reads += 1;
			return backend === "exa" ? { status: "found", value: SECRET } : { status: "missing" };
		},
	});
	const { tool } = setup(store);
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		const seen = [];
		await withFetch(
			async (url) => {
				seen.push(String(url));
				return new Response("boom", { status: 500 });
			},
			async () => {
				await assert.rejects(tool.execute("a9", EXA_PARAMS, undefined, undefined, {}));
			},
		);
		assert.equal(reads, 1, "匿名失败后 provider=exa 才解析一次密钥库");
		assert.ok(!seen[0].includes("exaApiKey"), "匿名阶段不得携带凭据");
		assert.ok(seen[1].includes(`exaApiKey=${encodeURIComponent(SECRET)}`));
	});
});

// 10. 系统密钥库里的 Parallel key 会进入 Authorization 头。
test("auth: Parallel key 从密钥库进入 Authorization 头", async () => {
	const store = fakeStore({
		read: async (backend) => (backend === "parallel" ? { status: "found", value: "parallel-store-key" } : { status: "missing" }),
	});
	const { tool } = setup(store);
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		const seen = [];
		await withFetch(
			async (_url, init) => {
				seen.push(init?.headers?.authorization);
				if (init?.headers?.authorization !== undefined) return new Response("invalid api key", { status: 401 });
				return new Response("anonymous unavailable", { status: 503 });
			},
			async () => {
				await assert.rejects(tool.execute("a10", { query: "q", provider: "parallel" }, undefined, undefined, {}), /401/u);
			},
		);
		assert.equal(seen[0], undefined, "先尝试匿名通道");
		assert.equal(seen[1], "Bearer parallel-store-key");
	});
});

// 11. 网络错误里的直接 key / URL 编码 key 都必须被脱敏。
test("auth: 网络错误不泄露 key（原文与 URL 编码）", async () => {
	const store = fakeStore({
		read: async (backend) => (backend === "exa" ? { status: "found", value: SPECIAL_SECRET } : { status: "missing" }),
	});
	const { tool } = setup(store);
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		await withFetch(
			async (url) => {
				throw new TypeError(`request to ${String(url)} failed (raw=${SPECIAL_SECRET})`);
			},
			async () => {
				await assert.rejects(tool.execute("a11", EXA_PARAMS, undefined, undefined, {}), (error) => {
					const message = String(error.message);
					assert.ok(!message.includes(SPECIAL_SECRET), "不应出现原文 key");
					assert.ok(!message.includes(encodeURIComponent(SPECIAL_SECRET)), "不应出现 URL 编码 key");
					assert.match(message, /\*\*\*/);
					return true;
				});
			},
		);
	});
});

// 12. 只有实际读取的 key 才进入错误脱敏范围，HTTP / MCP 回显都不得泄漏。
test("auth: 匿名失败后读取的 Key 在 HTTP / MCP 回显中均脱敏", async () => {
	const store = fakeStore({
		read: async (backend) => (backend === "exa" ? { status: "found", value: SECRET } : { status: "missing" }),
	});
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ROUTING: "free-first", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		// 12a. 匿名失败后读取 Key；Key 通道 500 回显时最终错误不得泄漏 key。
		{
			const { tool } = setup(store);
			await withFetch(
				async (url) => {
					if (String(url).includes("exaApiKey")) {
						return new Response(JSON.stringify({ error: { message: `quota exhausted for ${SECRET}` } }), { status: 500 });
					}
					return new Response("anonymous unavailable", { status: 503 });
				},
				async () => {
					await assert.rejects(tool.execute("a12a", EXA_PARAMS, undefined, undefined, {}), (error) => {
						assert.ok(!String(error.message).includes(SECRET), "最终错误不应泄露已读取的 key");
						assert.match(String(error.message), /\*\*\*/);
						return true;
					});
				},
			);
		}
		// 12b. 匿名与授权通道都失败 → 最终 throw 不含 MCP isError 回显的 key。
		{
			const { tool } = setup(store);
			await withFetch(
				async () =>
					new Response(
						JSON.stringify({ result: { isError: true, content: [{ type: "text", text: `auth failed for ${SECRET}` }] } }),
						{ status: 200 },
					),
				async () => {
					await assert.rejects(tool.execute("a12b", { query: "q", provider: "auto" }, undefined, undefined, {}), (error) => {
						assert.ok(!String(error.message).includes(SECRET));
						assert.match(String(error.message), /\*\*\*/);
						return true;
					});
				},
			);
		}
	});
});

// 13. 菜单：配置说明推荐掩码输入，不建议 argv 密钥或明文文件。
test("auth-ui: 配置说明推荐掩码输入且不建议 argv 密钥或明文文件", async () => {
	const { authCommand } = setup(fakeStore());
	assert.ok(authCommand, "应注册 /web-search-auth");
	const ctx = fakeCtx({ selections: ["查看配置说明"] });
	await authCommand.handler("", ctx);
	const text = ctx.notes.map((note) => note.message).join("\n");
	assert.match(text, /\/web-search-auth/u);
	assert.match(text, /掩码/u);
	assert.match(text, /macos-keychain\.swift|Swift.{0,12}(?:静态|适配器)|(?:静态|适配器).{0,12}Swift/iu);
	assert.ok(!/security add-generic-password/u.test(text), "不应再推荐 security -w 命令");
	assert.ok(!/\bexport\s+[A-Z0-9_]+_API_KEY\s*=/u.test(text), "不应建议明文 shell 配置");
	assert.ok(!/^\s*(?:echo|printf|tee)\b[^\n]*(?:>>?\s*~\/|\.zshrc|\.bashrc|\.profile|\.env)/imu.test(text), "不应建议写入明文配置文件");
});

// 14. 菜单：状态同时报告两个后端，并区分不可用。
test("auth-ui: 状态报告区分 configured 与 unavailable", async () => {
	const store = fakeStore({
		kind: "keychain",
		read: async (backend) =>
			backend === "exa"
				? { status: "found", value: "k" }
				: { status: "unavailable", reason: "密钥库已锁定" },
	});
	const { authCommand } = setup(store);
	const ctx = fakeCtx({ selections: ["查看状态"] });
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined }, async () => {
		await authCommand.handler("", ctx);
	});
	const text = ctx.notes.map((note) => note.message).join("\n");
	assert.match(text, /exa：已配置/);
	assert.match(text, /parallel：系统密钥库不可用/);
	assert.match(text, /firecrawl：系统密钥库不可用/);
	assert.match(text, /锁定/);
});

// 15. 菜单：删除需二次确认，成功 / 未找到 / 失败都有明确诊断。
test("auth-ui: 删除流程给出成功 / 未找到 / 失败诊断", async () => {
	// 15a. 成功删除。
	{
		const store = fakeStore({ clear: async () => ({ status: "deleted" }) });
		const { authCommand } = setup(store);
		const ctx = fakeCtx({ selections: ["删除系统密钥库中的密钥", "exa"], confirms: [true] });
		await authCommand.handler("", ctx);
		assert.match(ctx.notes.at(-1).message, /已删除/);
	}
	// 15b. 取消确认则不删除。
	{
		let cleared = 0;
		const store = fakeStore({ clear: async () => ((cleared += 1), { status: "deleted" }) });
		const { authCommand } = setup(store);
		const ctx = fakeCtx({ selections: ["删除系统密钥库中的密钥", "exa"], confirms: [false] });
		await authCommand.handler("", ctx);
		assert.equal(cleared, 0);
		assert.match(ctx.notes.at(-1).message, /已取消/);
	}
	// 15c. 未找到。
	{
		const store = fakeStore({ clear: async () => ({ status: "missing" }) });
		const { authCommand } = setup(store);
		const ctx = fakeCtx({ selections: ["删除系统密钥库中的密钥", "parallel"], confirms: [true] });
		await authCommand.handler("", ctx);
		const last = ctx.notes.at(-1);
		assert.match(last.message, /没有保存/);
		assert.equal(last.type, "warning");
	}
	// 15d. 失败给出原因（且不含 key）。
	{
		const store = fakeStore({ clear: async () => ({ status: "unavailable", reason: "密钥库已锁定" }) });
		const { authCommand } = setup(store);
		const ctx = fakeCtx({ selections: ["删除系统密钥库中的密钥", "exa"], confirms: [true] });
		await authCommand.handler("", ctx);
		const last = ctx.notes.at(-1);
		assert.equal(last.type, "error");
		assert.match(last.message, /失败/);
		assert.match(last.message, /锁定/);
	}
});

// 16. 生产认证 UI 实际使用掩码组件，不使用普通 Input；index 委托注册认证命令。
test("生产认证 UI 引用 MaskedInput 且不使用普通 Input", () => {
	const authUi = readFileSync(new URL("../auth-ui.ts", import.meta.url), "utf8");
	const index = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(authUi, /from ["']\.\/masked-input\.js["']/u);
	assert.ok(!/\bnew\s+Input\b|\bui\.input\s*\(/u.test(authUi), "认证 UI 不应退化为普通 Input");
	assert.ok(!/\bundo\b/iu.test(authUi), "认证 UI 不应暴露撤销输入组件");
	assert.match(index, /registerAuthCommand/u);
	assert.ok(!index.includes("masked-input"), "index.ts 应由 auth-ui 间接使用 MaskedInput");
	assert.ok(!/\bpi\.registerCommand\s*\(/u.test(index), "命令注册应由 auth-ui 负责");
	assert.ok(!index.includes("web-search-config"), "旧命令名应已移除");
});

// 17. 成功响应回显 key：content / details / 落盘都不得出现 key（原文与 URL 编码）。
test("auth: 成功 MCP 200 回显 key 时 content / details / spill 均脱敏", async () => {
	const store = fakeStore({
		read: async (backend) => (backend === "exa" ? { status: "found", value: SPECIAL_SECRET } : { status: "missing" }),
	});
	const { tool } = setup(store);
	const leaked = `raw=${SPECIAL_SECRET} url=${encodeURIComponent(SPECIAL_SECRET)}`;
	const body = `Title: T\nURL: https://example.com/a\nHighlights:\n${"y".repeat(30000)} ${leaked}`;
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		await withFetch(
			() =>
				new Response(
					JSON.stringify({ result: { content: [{ type: "text", text: body }] } }),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
			async () => {
				const result = await tool.execute("a17", { query: "回显 key", provider: "exa" }, undefined, undefined, {});
				const serialized = JSON.stringify(result.details);
				for (const secret of [SPECIAL_SECRET, encodeURIComponent(SPECIAL_SECRET)]) {
					assert.ok(!serialized.includes(secret), "details 不应泄露 key");
					assert.ok(!result.content[0].text.includes(secret), "content 不应泄露 key");
				}
				assert.equal(result.details.truncated, true);
				const spilled = readFileSync(result.details.fullTextPath, "utf8");
				assert.ok(!spilled.includes(SPECIAL_SECRET), "落盘内容不应泄露 key");
				assert.ok(!spilled.includes(encodeURIComponent(SPECIAL_SECRET)), "落盘内容不应泄露编码 key");
			});
	});
});

// 18. 长错误中的 key 跨越原先 300 字符截断边界时，不能只脱敏一半。
test("auth: 长错误 key 跨原 300 字符边界无部分泄露", async () => {
	const longSecret = "SECRET_PREFIX_ABCDEFGHIJKLMNOP";
	const store = fakeStore({
		read: async (backend) => (backend === "exa" ? { status: "found", value: longSecret } : { status: "missing" }),
	});
	const { tool } = setup(store);
	// key 起始于约第 294 字符，正好跨过旧的 300 字符预截断边界。
	const detail = `${"x".repeat(280)}${longSecret}`;
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined, PI_WEB_SEARCH_RETRIES: "0", PI_WEB_SEARCH_ALLOW_BILLABLE: "true" }, async () => {
		await withFetch(
			() => new Response(JSON.stringify({ error: { message: detail } }), { status: 500 }),
			async () => {
				await assert.rejects(
					tool.execute("a18", { query: "x", provider: "exa" }, undefined, undefined, {}),
					(error) => {
						const message = String(error.message);
						assert.ok(!message.includes(longSecret), "不应出现完整 key");
						assert.ok(!message.includes(longSecret.slice(0, 12)), "不应泄露 key 前缀");
						assert.match(message, /\*\*\*/);
						return true;
					},
				);
			},
		);
	});
});

// 19. Linux secret-tool：exit 1 + stderr 非空是密钥库不可用，不是「未配置」。
test("credentials: secret-tool exit1+stderr 判为 unavailable，空 stderr 仍为 missing", async () => {
	const broken = new credentials.SecretToolStore(async () => ({ code: 1, stdout: "", stderr: "cannot open session" }));
	const result = await broken.read("exa");
	assert.equal(result.status, "unavailable");
	assert.ok(!String(result.reason).includes("cannot open session"), "reason 不应包含 stderr 内容");
	assert.equal((await broken.clear("exa")).status, "unavailable");
	const empty = new credentials.SecretToolStore(async () => ({ code: 1, stdout: "", stderr: "" }));
	assert.equal((await empty.read("exa")).status, "missing");
	const explicitMissing = new credentials.SecretToolStore(async () => ({ code: 1, stdout: "", stderr: "No such secret" }));
	assert.equal((await explicitMissing.read("exa")).status, "missing");
});

// 20. spawnExec 超时：注入短预算并验证 kill，读取失败归为 unavailable。
test("credentials: spawnExec 超时后 kill 并按不可用处理", async () => {
	const startedAt = Date.now();
	await assert.rejects(
		credentials.spawnExec(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], undefined, 80),
		/超时/,
	);
	assert.ok(Date.now() - startedAt < 3000, "超时应快速返回");
	const store = new credentials.SecretToolStore(async () => {
		throw new Error("凭据库命令超时");
	});
	const timedOut = await store.read("exa");
	assert.equal(timedOut.status, "unavailable");
	assert.match(timedOut.reason, /超时/);
	assert.equal((await store.clear("exa")).status, "unavailable");
});

// 21. 菜单：状态 / 说明各自合并为单条通知，且复用已 probe 的状态。
test("auth-ui: 状态与说明各合并为单条通知并复用已 probe 状态", async () => {
	let reads = 0;
	const store = fakeStore({
		kind: "keychain",
		read: async () => (reads += 1, { status: "missing" }),
	});
	const { authCommand } = setup(store);
	await withEnv({ EXA_API_KEY: undefined, PARALLEL_API_KEY: undefined }, async () => {
		const statusCtx = fakeCtx({ selections: ["查看状态"] });
		await authCommand.handler("", statusCtx);
		assert.equal(statusCtx.notes.length, 1, "状态应合并为单条通知");
		assert.equal(reads, 5, "五个后端各 probe 一次，选择「查看状态」不应重复 probe 密钥库");
		const guideCtx = fakeCtx({ selections: ["查看配置说明"] });
		await authCommand.handler("", guideCtx);
		assert.equal(guideCtx.notes.length, 1, "说明应合并为单条通知");
	});
});

// 22. 非交互模式不假装 notify 可见；删除选择器对非法值视为取消。
test("auth-ui: 非交互模式保持 no-op，删除选择器验证运行时的值", async () => {
	const { authCommand } = setup(fakeStore());
	const nonInteractive = fakeCtx({ hasUI: false });
	await authCommand.handler("", nonInteractive);
	assert.equal(nonInteractive.notes.length, 0, "无 UI 时不应调用 notify");

	let cleared = 0;
	const store = fakeStore({ clear: async () => (cleared += 1, { status: "deleted" }) });
	const { authCommand: deleteCommand } = setup(store);
	const ctx = fakeCtx({ selections: ["删除系统密钥库中的密钥", "bogus"], confirms: [true] });
	await deleteCommand.handler("", ctx);
	assert.equal(cleared, 0, "非法选择值不应触发删除");
	assert.match(ctx.notes.at(-1).message, /已取消/);
});

// 23. 无系统密钥库的平台：不再建议写 shell 配置文件明文。
test("auth: 无系统密钥库时不建议写 shell 配置文件", () => {
	const guide = auth.configGuide("exa", "none").lines.join("\n");
	assert.ok(!guide.includes("zshrc"), "不应建议写 shell 启动文件明文");
	assert.ok(!guide.includes("export EXA_API_KEY"), "不应建议将 key 放入 shell 命令历史");
	assert.match(guide, /secret manager/);
	assert.match(guide, /免 key 通道/);
});

// 24. 菜单与搜索共用同一 channelHealth：搜索触发冷却后，认证菜单可见。
test("auth-ui: 路由菜单读取插件共享的搜索通道健康状态", async () => {
	const health = channelHealthModule.createChannelHealth({ clock: () => 10_000 });
	const { tool, authCommand } = setup(fakeStore(), { channelHealth: health });
	await withEnv(
		{
			EXA_API_KEY: undefined,
			PARALLEL_API_KEY: undefined,
			TAVILY_API_KEY: undefined,
			SERPAPI_API_KEY: undefined,
			FIRECRAWL_API_KEY: undefined,
			PI_WEB_SEARCH_ROUTING: "free-first",
			PI_WEB_SEARCH_ALLOW_BILLABLE: "false",
			PI_WEB_SEARCH_FREE_COOLDOWN_MS: "5000",
			PI_WEB_SEARCH_RETRIES: "0",
		},
		async () => {
			await withFetch(
				async () => new Response("rate limited", { status: 429, headers: { "retry-after": "5" } }),
				async () => {
					await assert.rejects(tool.execute("a24", EXA_PARAMS, undefined, undefined, {}));
				},
			);
			const ctx = fakeCtx({ selections: ["查看路由与冷却状态"] });
			await authCommand.handler("", ctx);
			const message = ctx.notes.map((note) => note.message).join("\n");
			assert.match(message, /exa（匿名通道，限流）：冷却剩余约 5 秒/u);
			assert.ok(!message.includes(SECRET));
		},
	);
});
