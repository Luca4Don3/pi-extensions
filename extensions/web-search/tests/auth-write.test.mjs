/** `/web-search-auth` 写入流程测试：真实 custom factory 与生产 MaskedInput，全部存储均为 fake。 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const ENV_KEYS = [
	"EXA_API_KEY",
	"PARALLEL_API_KEY",
	"TAVILY_API_KEY",
	"SERPAPI_API_KEY",
	"FIRECRAWL_API_KEY",
	"PI_WEB_SEARCH_ROUTING",
	"PI_WEB_SEARCH_ALLOW_BILLABLE",
	"PI_WEB_SEARCH_ALLOW_PAID",
];
for (const key of ENV_KEYS) delete process.env[key];

const jiti = createJiti(import.meta.url);
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
const plugin = loaded.default ?? loaded;

const SECRET = "write_test_FAKE_SECRET_987";
const BACKENDS = ["exa", "parallel", "tavily", "firecrawl", "serpapi"];

async function withEnv(vars, fn) {
	const merged = { ...Object.fromEntries(ENV_KEYS.map((key) => [key, undefined])), ...vars };
	const saved = Object.fromEntries(Object.keys(merged).map((key) => [key, process.env[key]]));
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

function fakeStore({ kind = "keychain", write } = {}) {
	return {
		kind,
		read: async () => ({ status: "missing" }),
		write: write ?? (async () => ({ status: "written" })),
		clear: async () => ({ status: "missing" }),
	};
}

function setup(store) {
	const commands = [];
	plugin(
		{
			registerTool: () => undefined,
			registerCommand: (name, command) => commands.push({ name, ...command }),
			on: () => undefined,
		},
		{ credentialStore: store },
	);
	const authCommand = commands.find((command) => command.name === "web-search-auth");
	assert.ok(authCommand, "应注册真实认证命令");
	return authCommand;
}

function fakeCtx({ selections = [], confirms = [], mode = "tui", hasUI = true, customRunner } = {}) {
	const selectQueue = [...selections];
	const confirmQueue = [...confirms];
	const notes = [];
	const calls = { custom: 0, input: 0, select: 0, confirm: 0 };
	const ui = {
		select: async () => {
			calls.select += 1;
			return selectQueue.shift();
		},
		confirm: async () => {
			calls.confirm += 1;
			return confirmQueue.shift() ?? false;
		},
		notify: (message, type) => notes.push({ message, type: type ?? "info" }),
		input: async () => {
			calls.input += 1;
			return SECRET;
		},
	};
	if (customRunner !== undefined) {
		ui.custom = (factory) => {
			calls.custom += 1;
			return customRunner(factory);
		};
	}
	return { hasUI, mode, ui, notes, calls };
}

/** 执行真实 factory 返回的组件，真实喂入按键，并保存每次重绘内容。 */
function runRealMaskedInput(chunks, snapshots = []) {
	return (factory) =>
		new Promise((resolve) => {
			let component;
			const capture = () => {
				if (component !== undefined) snapshots.push(component.render(80).join("\n"));
			};
			const tui = { requestRender: capture };
			component = factory(tui, {}, {}, resolve);
			assert.equal(component.constructor.name, "MaskedInput", "custom 必须调用生产 MaskedInput factory");
			for (const chunk of chunks) {
				component.handleInput(chunk);
				capture();
			}
		});
}

async function beginWrite({ store = fakeStore(), backend = "exa", mode = "tui", hasUI = true, confirms = [true], chunks = [SECRET, "\r"], customRunner } = {}) {
	const authCommand = setup(store);
	const ctx = fakeCtx({
		selections: ["添加或修改密钥", backend],
		confirms,
		mode,
		hasUI,
		customRunner,
	});
	await authCommand.handler("", ctx);
	return ctx;
}

test("写入：真实 custom factory 喂入 MaskedInput，所有渲染均无 secret，成功提示验证与 env 优先", async () => {
	const writes = [];
	const store = fakeStore({ write: async (backend, value) => (writes.push({ backend, value }), { status: "written" }) });
	const snapshots = [];
	await withEnv(
		{ EXA_API_KEY: "environment-precedence-value" },
		async () => {
			const ctx = await beginWrite({
				store,
				customRunner: runRealMaskedInput([SECRET, "\r"], snapshots),
			});
			assert.deepEqual(writes, [{ backend: "exa", value: SECRET }]);
			assert.ok(snapshots.length > 0, "应记录真实组件的每次重绘");
			for (const frame of snapshots) assert.ok(!frame.includes(SECRET), "任何渲染都不能包含 fake secret");
			assert.equal(ctx.calls.custom, 1);
			assert.equal(ctx.calls.input, 0);
			const notice = ctx.notes.map((note) => note.message).join("\n");
			assert.match(notice, /通过重读验证/u);
			assert.match(notice, /EXA_API_KEY/u);
			assert.match(notice, /仍以环境变量为准/u);
		},
	);
});

test("写入：确认取消、非法 backend、组件取消及无系统密钥库均不写入", async () => {
	let writes = 0;
	let customCalls = 0;
	const store = fakeStore({ write: async () => (writes += 1, { status: "written" }) });

	const cancelledConfirm = await beginWrite({ store, confirms: [false], customRunner: runRealMaskedInput([SECRET, "\r"]) });
	assert.equal(writes, 0);
	assert.equal(cancelledConfirm.calls.custom, 0, "确认取消后不能打开输入组件");
	assert.match(cancelledConfirm.notes.at(-1).message, /已取消/u);

	const cancelCommand = setup(store);
	const cancelledBackend = fakeCtx({ selections: ["添加或修改密钥", undefined], confirms: [true], customRunner: runRealMaskedInput([SECRET, "\r"]) });
	await cancelCommand.handler("", cancelledBackend);
	assert.equal(writes, 0);
	assert.equal(cancelledBackend.calls.confirm, 0, "后端选择器取消时不能继续确认");
	assert.equal(cancelledBackend.calls.custom, 0);
	assert.match(cancelledBackend.notes.at(-1).message, /已取消/u);

	const invalidBackend = await beginWrite({ store, backend: "bogus", customRunner: runRealMaskedInput([SECRET, "\r"]) });
	assert.equal(writes, 0);
	assert.equal(invalidBackend.calls.confirm, 0);
	assert.equal(invalidBackend.calls.custom, 0);
	assert.match(invalidBackend.notes.at(-1).message, /已取消/u);

	const componentCancelled = await beginWrite({ store, chunks: [SECRET, "\x1b"], customRunner: runRealMaskedInput([SECRET, "\x1b"]) });
	assert.equal(writes, 0);
	assert.match(componentCancelled.notes.at(-1).message, /已取消/u);
	assert.ok(!componentCancelled.notes.some((note) => note.message.includes(SECRET)));

	const noStore = fakeStore({ kind: "none", write: async () => (writes += 1, { status: "written" }) });
	const unavailable = await beginWrite({ store: noStore, customRunner: (factory) => (customCalls += 1, runRealMaskedInput([SECRET, "\r"])(factory)) });
	assert.equal(writes, 0);
	assert.equal(customCalls, 0, "无系统密钥库时不能创建输入组件");
	assert.equal(unavailable.calls.custom, 0);
	assert.match(unavailable.notes.at(-1).message, /不能保存密钥/u);
});

test("写入：rpc 模式即使 hasUI=true 也不调用 custom 或普通 input", async () => {
	let writes = 0;
	const store = fakeStore({ write: async () => (writes += 1, { status: "written" }) });
	const ctx = await beginWrite({ store, mode: "rpc", hasUI: true });
	assert.equal(writes, 0);
	assert.equal(ctx.calls.custom, 0);
	assert.equal(ctx.calls.input, 0, "不应退化为 ui.input 明文输入");
	assert.match(ctx.notes.at(-1).message, /不支持安全掩码输入/u);
});

test("写入：五个 backend 均可经真实掩码组件写入", async () => {
	const writes = [];
	const store = fakeStore({ write: async (backend, value) => (writes.push({ backend, value }), { status: "written" }) });
	for (const backend of BACKENDS) {
		const ctx = await beginWrite({ store, backend, customRunner: runRealMaskedInput([SECRET, "\r"]) });
		assert.equal(ctx.calls.custom, 1);
		assert.equal(ctx.calls.input, 0);
	}
	assert.deepEqual(writes, BACKENDS.map((backend) => ({ backend, value: SECRET })));
});

test("写入：存储失败或异常回显 secret 时只通知安全诊断", async () => {
	for (const write of [
		async () => ({ status: "unavailable", reason: `storage error ${SECRET}` }),
		async () => {
			throw new Error(`backend echoed ${SECRET}`);
		},
	]) {
		const store = fakeStore({ write });
		const snapshots = [];
		const ctx = await beginWrite({ store, customRunner: runRealMaskedInput([SECRET, "\r"], snapshots) });
		assert.ok(snapshots.every((frame) => !frame.includes(SECRET)), "失败场景渲染也不能泄露 secret");
		const notification = ctx.notes.at(-1);
		assert.equal(notification.type, "error");
		assert.ok(!notification.message.includes(SECRET), "错误通知不能回显密钥");
		assert.match(notification.message, /未验证成功/u);
	}
});
