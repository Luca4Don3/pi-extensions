import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const credentials = await jiti.import(fileURLToPath(new URL("../credentials.ts", import.meta.url)));
const auth = await jiti.import(fileURLToPath(new URL("../auth.ts", import.meta.url)));
const loaded = await jiti.import(fileURLToPath(new URL("../index.ts", import.meta.url)));
for (const backend of auth.BACKENDS) delete process.env[auth.envVarName(backend)];
for (const name of ["PI_WEB_SEARCH_ALLOW_PAID", "PI_WEB_SEARCH_ROUTING", "PI_WEB_SEARCH_FREE_COOLDOWN_MS"]) delete process.env[name];
const SECRET = "abort_test_SECRET_must_not_escape";

function isFixedAbortError(error) {
	return error instanceof DOMException && error.name === "AbortError" && error.message === "操作已取消";
}

async function waitUntil(check, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail("等待本地子进程状态超时");
}

async function assertFast(promise, timeoutMs = 500) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error("取消等待过慢")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error.code === "ESRCH") return false;
		throw error;
	}
}

test("预取消时不启动子进程或调用凭据 runner", async () => {
	const controller = new AbortController();
	controller.abort(new Error(`敏感取消原因 ${SECRET}`));
	await assert.rejects(
		credentials.spawnExec("/path/that/must/not/be-spawned", [], undefined, 5_000, controller.signal),
		isFixedAbortError,
	);

	let calls = 0;
	const store = new credentials.SecretToolStore(async () => {
		calls++;
		return { code: 1, stdout: "", stderr: "" };
	});
	await assert.rejects(auth.resolveBackendKey("exa", store, controller.signal), isFixedAbortError);
	assert.equal(calls, 0);
});

test("取消 spawnExec 会及时杀死本地子进程且不留下活进程", async () => {
	const parent = fileURLToPath(new URL("../../../.temp/", import.meta.url));
	mkdirSync(parent, { recursive: true });
	const directory = mkdtempSync(join(parent, "credentials-abort-"));
	const pidFile = join(directory, "child.pid");
	let pid;
	const controller = new AbortController();
	const source = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
	const pending = credentials.spawnExec(process.execPath, ["-e", source], undefined, 5_000, controller.signal);
	try {
		await waitUntil(() => existsSync(pidFile));
		pid = Number(readFileSync(pidFile, "utf8"));
		assert.ok(Number.isInteger(pid) && pid > 0);
		controller.abort(new Error(`敏感取消原因 ${SECRET}`));
		await assert.rejects(pending, isFixedAbortError);
		await waitUntil(() => !isAlive(pid));
	} finally {
		if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
		// 验收文件仅留在项目忽略的临时目录中，不自动删除用户文件。
	}
});

test("Mac 与 Linux 读取将取消信号传给 runner，读取失败仍返回三态", async () => {
	const controller = new AbortController();
	const signals = [];
	const mac = new credentials.MacKeychainStore(async (_bin, _args, _stdin, _timeout, signal) => {
		signals.push(signal);
		return { code: 44, stdout: "", stderr: "" };
	}, "test-account");
	const linux = new credentials.SecretToolStore(async (_bin, _args, _stdin, _timeout, signal) => {
		signals.push(signal);
		return { code: 1, stdout: "", stderr: "" };
	});
	assert.deepEqual(await mac.read("exa", controller.signal), { status: "missing" });
	assert.deepEqual(await linux.read("exa", controller.signal), { status: "missing" });
	assert.deepEqual(signals, [controller.signal, controller.signal]);
});

test("不可中断的 fake read 也能令 resolvePlanKeys 快速拒绝且不泄露迟到的 key", async () => {
	const controller = new AbortController();
	const deferred = [];
	let reads = 0;
	let otherOperations = 0;
	const store = {
		kind: "none",
		read(_backend, signal) {
			assert.equal(signal, controller.signal);
			reads++;
			return new Promise((resolve) => deferred.push(resolve));
		},
		async write() {
			otherOperations++;
			return { status: "unavailable", reason: "不应执行" };
		},
		async clear() {
			otherOperations++;
			return { status: "unavailable", reason: "不应执行" };
		},
	};
	const pending = auth.resolvePlanKeys("auto", store, controller.signal);
	assert.equal(reads, 4);
	const rejected = assert.rejects(pending, (error) => {
		assert.ok(isFixedAbortError(error));
		assert.ok(!String(error).includes(SECRET));
		return true;
	});
	controller.abort(new Error(`敏感取消原因 ${SECRET}`));
	await assertFast(rejected);
	for (const resolve of deferred) resolve({ status: "found", value: SECRET });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(otherOperations, 0);
});

test("搜索在密钥库等待期间取消，立即拒绝且不发网络请求", async () => {
	const controller = new AbortController();
	let tool;
	let reads = 0;
	const store = {
		kind: "none",
		read: () => {
			reads++;
			return new Promise(() => {});
		},
		write: async () => ({ status: "unavailable", reason: "不应执行" }),
		clear: async () => ({ status: "missing" }),
	};
	(loaded.default ?? loaded)({ registerTool: (value) => { tool = value; }, registerCommand: () => {} }, { credentialStore: store });
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = async () => { requests++; throw new Error("不应发请求"); };
	try {
		const pending = tool.execute("cancel", { query: "取消验收", provider: "exa" }, controller.signal);
		assert.equal(reads, 1);
		controller.abort();
		await assertFast(assert.rejects(pending, (error) => error.name === "AbortError"));
		assert.equal(requests, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("凭据读取同步触发取消后，迟到拒绝仍被消费", async () => {
	const controller = new AbortController();
	const store = {
		kind: "none",
		read: async () => {
			controller.abort();
			throw new Error("模拟同步取消");
		},
		write: async () => ({ status: "unavailable", reason: "不应执行" }),
		clear: async () => ({ status: "missing" }),
	};
	await assert.rejects(auth.resolvePlanKeys("auto", store, controller.signal), isFixedAbortError);
	await new Promise((resolve) => setImmediate(resolve));
});

test("读取异常在取消时转换为固定 AbortError，不暴露异常中的凭据", async () => {
	const controller = new AbortController();
	const store = {
		kind: "none",
		read: async () => {
			controller.abort(new Error(`读取失败 ${SECRET}`));
			throw new Error(`读取失败 ${SECRET}`);
		},
		async write() { return { status: "unavailable", reason: "不应执行" }; },
		async clear() { return { status: "unavailable", reason: "不应执行" }; },
	};
	await assert.rejects(auth.resolveBackendKey("exa", store, controller.signal), (error) => {
		assert.ok(isFixedAbortError(error));
		assert.ok(!String(error).includes(SECRET));
		return true;
	});
});
