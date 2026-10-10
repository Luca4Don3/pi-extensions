import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const credentials = await jiti.import(fileURLToPath(new URL("../credentials.ts", import.meta.url)));
const BACKENDS = ["exa", "parallel", "tavily", "serpapi"];
const SECRET = "fake_token_NEVER_OUTPUT_123";

function makeMacRunner() {
	const values = new Map();
	const calls = [];
	const run = async (bin, args, stdin, timeoutMs) => {
		calls.push({ bin, args: [...args], stdin, timeoutMs });
		if (bin === "/usr/bin/swift") {
			assert.match(args[0], /macos-keychain\.swift$/u);
			assert.equal(args[1], "test-account");
			assert.equal(stdin === SECRET, true);
			assert.equal(timeoutMs, 30_000);
			values.set(`${args[1]}\0${args[2]}`, stdin);
			return { code: 0, stdout: "", stderr: "" };
		}
		assert.equal(bin, "/usr/bin/security");
		assert.equal(args[0], "find-generic-password");
		const value = values.get(`${args[2]}\0${args[4]}`);
		return value === undefined
			? { code: 44, stdout: "", stderr: "" }
			: { code: 0, stdout: `${value}\n`, stderr: "" };
	};
	return { run, calls };
}

function makeLinuxRunner() {
	const values = new Map();
	const calls = [];
	const run = async (bin, args, stdin, timeoutMs) => {
		calls.push({ bin, args: [...args], stdin, timeoutMs });
		assert.equal(bin, "secret-tool");
		if (args[0] === "store") {
			assert.equal(stdin === SECRET, true);
			values.set(args[5], stdin);
			return { code: 0, stdout: "", stderr: "" };
		}
		assert.deepEqual(args.slice(0, 5), ["lookup", "service", "pi-web-search", "provider", args[4]]);
		const value = values.get(args[4]);
		return value === undefined
			? { code: 1, stdout: "", stderr: "" }
			: { code: 0, stdout: `${value}\n`, stderr: "" };
	};
	return { run, calls };
}

test("写入四个后端：凭据只经 stdin，写后重读验证且结果不含凭据", async () => {
	const mac = makeMacRunner();
	const macStore = new credentials.MacKeychainStore(mac.run, "test-account");
	for (const backend of BACKENDS) {
		const result = await macStore.write(backend, SECRET);
		assert.deepEqual(result, { status: "written" });
		assert.equal(Object.hasOwn(result, "value"), false);
	}
	const swiftCalls = mac.calls.filter((call) => call.bin === "/usr/bin/swift");
	assert.equal(swiftCalls.length, 4);
	for (const [index, call] of swiftCalls.entries()) {
		assert.equal(call.args[2], `pi-web-search-${BACKENDS[index]}`);
	}
	for (const call of mac.calls) {
		assert.ok(!call.args.includes(SECRET));
		if (call.bin === "/usr/bin/security") assert.equal(call.stdin, undefined);
	}

	const linux = makeLinuxRunner();
	const linuxStore = new credentials.SecretToolStore(linux.run);
	for (const backend of BACKENDS) {
		const result = await linuxStore.write(backend, SECRET);
		assert.deepEqual(result, { status: "written" });
		assert.ok(!JSON.stringify(result).includes(SECRET));
	}
	for (const backend of BACKENDS) {
		const call = linux.calls.find((item) => item.args[0] === "store" && item.args[5] === backend);
		assert.ok(call);
		assert.deepEqual(call.args, ["store", `--label=Pi web search: ${backend}`, "service", "pi-web-search", "provider", backend]);
		assert.equal(call.stdin === SECRET, true);
		assert.ok(!call.args.includes(SECRET));
	}
	assert.equal(linux.calls.filter((call) => call.args[0] === "lookup").length, 4);
});

test("统一凭据校验拒绝空白、非 ASCII 和超长内容，不隐式截断", async () => {
	assert.equal(credentials.MAX_SECRET_CHARS, 4096);
	assert.equal(credentials.isValidSecretValue("A".repeat(4096)), true);
	assert.equal(credentials.isValidSecretValue("A".repeat(4097)), false);
	for (const invalid of ["", "contains space", "line\nbreak", "非ASCII", "tab\tvalue"]) {
		assert.equal(credentials.isValidSecretValue(invalid), false);
		const result = await new credentials.SecretToolStore(async () => {
			throw new Error("无效凭据不应启动命令");
		}).write("exa", invalid);
		assert.equal(result.status, "unavailable");
		if (invalid.length > 0) assert.ok(!JSON.stringify(result).includes(invalid));
	}
});

test("写入后内容不匹配时不可报告成功", async () => {
	const wrong = "different_fake_value";
	const macStore = new credentials.MacKeychainStore(async (bin, args) =>
		bin === "/usr/bin/swift"
			? { code: 0, stdout: "", stderr: "" }
			: { code: 0, stdout: `${wrong}\n`, stderr: "" },
		"test-account",
	);
	assert.equal((await macStore.write("exa", SECRET)).status, "unavailable");

	const linuxStore = new credentials.SecretToolStore(async (_bin, args) =>
		args[0] === "store"
			? { code: 0, stdout: "", stderr: "" }
			: { code: 0, stdout: `${wrong}\n`, stderr: "" },
	);
	assert.equal((await linuxStore.write("exa", SECRET)).status, "unavailable");
});

test("runner 异常与超时的诊断不包含 stderr 或凭据", async () => {
	for (const failure of [new Error(`spawn failed: stderr ${SECRET}`), new Error(`凭据库命令超时（stderr ${SECRET}）`)]) {
		const macStore = new credentials.MacKeychainStore(async () => {
			throw failure;
		}, "test-account");
		const linuxStore = new credentials.SecretToolStore(async () => {
			throw failure;
		});
		for (const result of [await macStore.write("exa", SECRET), await linuxStore.write("exa", SECRET)]) {
			assert.equal(result.status, "unavailable");
			assert.ok(!JSON.stringify(result).includes(SECRET));
			assert.ok(!JSON.stringify(result).includes("stderr"));
		}
	}
});

test("无系统密钥库的平台拒绝写入", async () => {
	const store = new credentials.NoopSecretStore("freebsd");
	assert.deepEqual(await store.write("exa", SECRET), {
		status: "unavailable",
		reason: "平台 freebsd 没有支持的系统密钥库",
	});
});
