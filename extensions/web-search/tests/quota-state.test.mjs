/** 私有状态仓库测试：全部文件仅创建在项目 .temp/quota-validation，测试结束不删除。 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const core = await jiti.import(fileURLToPath(new URL("../quota/core.ts", import.meta.url)));
const stores = await jiti.import(fileURLToPath(new URL("../quota/state-store.ts", import.meta.url)));
const { createQuotaManager } = core;
const { createPrivateQuotaStateStore } = stores;
const SECRET = "FAKE_PERSISTED_QUOTA_KEY";
const ROOT = fileURLToPath(new URL("../../../.temp/quota-validation/", import.meta.url));
const salt = randomBytes(32).toString("base64");

function testDir(label) {
	// 干净检出时夹具根目录不存在，测试自己建立，不依赖手工验收产物。
	mkdirSync(ROOT, { recursive: true, mode: 0o700 });
	return join(ROOT, `quota-state-${label}-${Date.now()}-${randomBytes(6).toString("hex")}`);
}

function seededSalt(directory, value = { version: 1, salt }) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, "quota-salt.json"), JSON.stringify(value), { mode: 0o600 });
}

async function managerAt(directory, clock = () => 10_000) {
	const manager = createQuotaManager({ stateStore: createPrivateQuotaStateStore(directory), clock });
	await manager.initialize();
	return manager;
}

test("私有状态原子写入 0700/0600；内容只含盐、scope hash 与冷却元数据", async () => {
	const directory = testDir("atomic");
	const manager = await managerAt(directory);
	manager.recordFailure("firecrawl", "key", "quota_exhausted", { credential: SECRET, retryAfterMs: 60_000 });
	assert.deepEqual(await manager.flush(), { status: "persisted" });
	assert.equal(statSync(directory).mode & 0o777, 0o700);
	const names = readdirSync(directory);
	assert.ok(names.includes("quota-salt.json"));
	assert.ok(names.some((name) => name.startsWith("scope-") && name.endsWith(".json")));
	assert.ok(names.every((name) => !name.startsWith(".quota-tmp-")), "完成的原子更新不留临时文件");
	for (const name of names) assert.equal(statSync(join(directory, name)).mode & 0o777, 0o600);
	const content = names.map((name) => readFileSync(join(directory, name), "utf8")).join("\n");
	assert.ok(!content.includes(SECRET));
	assert.ok(!content.includes("query"));
	assert.ok(!content.includes("accountID"));
	assert.ok(!content.includes("rawerror"));
	assert.ok(!JSON.stringify(manager.snapshot()).match(/[a-f0-9]{64}/u));
});

test("首次运行逐级创建配置父目录，均为私有权限且不修改已有祖先", async () => {
	const root = testDir("fresh-config");
	mkdirSync(root, { mode: 0o755 });
	const originalMode = statSync(root).mode;
	const config = join(root, "agent", "config");
	const directory = join(config, "web-search");
	assert.equal(existsSync(join(root, "agent")), false);
	const manager = await managerAt(directory);
	manager.recordFailure("exa", "anonymous", "rate_limited");
	assert.equal((await manager.flush()).status, "persisted");
	for (const created of [join(root, "agent"), config, directory]) {
		assert.equal(statSync(created).mode & 0o777, 0o700);
	}
	assert.equal(statSync(root).mode, originalMode, "不修改已有祖先权限");
	const restored = await managerAt(directory);
	assert.equal(restored.getCooldown("exa", "anonymous").reason, "rate_limited");
});

test("拒绝符号链接祖先，不在链接目标下创建新的配置目录", async () => {
	const target = testDir("ancestor-target");
	mkdirSync(target, { mode: 0o700 });
	const link = testDir("ancestor-link");
	symlinkSync(target, link, "dir");
	const manager = await managerAt(join(link, "config", "web-search"));
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
	assert.equal(existsSync(join(target, "config")), false);
});

test("拒绝非目录祖先，保留已有文件原样", async () => {
	const path = testDir("ancestor-file");
	writeFileSync(path, "FAKE_EXISTING_CONFIGURATION", { mode: 0o600 });
	const manager = await managerAt(join(path, "config", "web-search"));
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
	assert.equal(readFileSync(path, "utf8"), "FAKE_EXISTING_CONFIGURATION");
});

test("并行仓库更新按 scope 原子合并，不覆盖不同 scope", async () => {
	const directory = testDir("merge");
	const first = await managerAt(directory);
	const second = await managerAt(directory);
	first.recordFailure("tavily", "key", "rate_limited", { credential: "FAKE_KEY_A" });
	second.recordFailure("firecrawl", "key", "quota_exhausted", { credential: "FAKE_KEY_B" });
	const results = await Promise.all([first.flush(), second.flush()]);
	assert.deepEqual(results.map((result) => result.status), ["persisted", "persisted"]);
	const restored = await managerAt(directory);
	assert.equal(restored.snapshot().cooldowns.length, 2);
	assert.ok(!JSON.stringify(restored.snapshot()).includes("FAKE_KEY_A"));
	assert.ok(!JSON.stringify(restored.snapshot()).includes("FAKE_KEY_B"));
});

test("同 scope 的落盘更新只采用保守 max merge，冷却不会被较短并发快照缩短", async () => {
	const directory = testDir("same-scope");
	const first = await managerAt(directory, () => 10_000);
	const second = await managerAt(directory, () => 20_000);
	first.recordFailure("tavily", "key", "rate_limited", { credential: "FAKE_SHARED", retryAfterMs: 120_000 });
	second.recordFailure("tavily", "key", "rate_limited", { credential: "FAKE_SHARED", retryAfterMs: 30_000 });
	const results = await Promise.all([first.flush(), second.flush()]);
	assert.deepEqual(results.map((result) => result.status), ["persisted", "persisted"]);
	const restored = await managerAt(directory, () => 20_000);
	assert.equal(restored.getCooldown("tavily", "key", "FAKE_SHARED").remainingMs, 110_000);
});

test("重启恢复 cooldown/阶梯历史，不恢复余额缓存", async () => {
	const directory = testDir("restore");
	const first = await managerAt(directory, () => 1_000);
	first.recordFailure("tavily", "key", "rate_limited", { credential: SECRET });
	await first.flush();
	const restored = await managerAt(directory, () => 1_000);
	assert.equal(restored.getCooldown("tavily", "key", SECRET).failureCount, 1);
	assert.equal(restored.reserve({ backend: "tavily", channel: "key", credential: SECRET, allowBillable: true, operation: "search", maxResults: 1 }).reason, "unknown_balance");
});

test("拒绝父目录符号链接并显式退化，不回显路径", async () => {
	const target = testDir("symlink-target");
	mkdirSync(target, { recursive: true, mode: 0o700 });
	const link = testDir("symlink-parent");
	symlinkSync(target, link, "dir");
	const manager = await managerAt(link);
	assert.equal(manager.snapshot().persistence, "degraded");
	const result = await manager.flush();
	assert.equal(result.status, "degraded");
	assert.ok(!JSON.stringify(manager.snapshot()).includes(link));
	assert.ok(!JSON.stringify(result).includes(target));
});

test("拒绝 state 文件符号链接并显式退化", async () => {
	const directory = testDir("symlink-file");
	seededSalt(directory);
	const scopeId = "a".repeat(64);
	const linkName = `scope-${scopeId}-rate_limited.json`;
	symlinkSync(join(directory, "missing-target.json"), join(directory, linkName));
	const manager = await managerAt(directory);
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
});

test("损坏状态可见退化且不覆盖未知旧内容、不泄漏原始错误", async () => {
	const directory = testDir("corrupt");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const statePath = join(directory, "quota-salt.json");
	const corrupt = `CORRUPT_RAW_${SECRET}`;
	writeFileSync(statePath, corrupt, { mode: 0o600 });
	const manager = await managerAt(directory);
	manager.recordFailure("exa", "anonymous", "rate_limited");
	assert.equal(manager.snapshot().persistence, "degraded");
	const flushed = await manager.flush();
	assert.equal(flushed.status, "degraded");
	assert.ok(!JSON.stringify(flushed).includes(corrupt));
	assert.ok(!JSON.stringify(manager.snapshot()).includes(directory));
	assert.equal(readFileSync(statePath, "utf8"), corrupt, "损坏文件不得被覆盖");
});

test("未知 state version 保留原样并退化，而非覆盖重要旧版本", async () => {
	const directory = testDir("unknown-version");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const statePath = join(directory, "quota-salt.json");
	const unknown = JSON.stringify({ version: 99, salt, marker: "IMPORTANT_UNKNOWN_STATE" });
	writeFileSync(statePath, unknown, { mode: 0o600 });
	const manager = await managerAt(directory);
	manager.recordFailure("exa", "anonymous", "rate_limited");
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
	assert.equal(readFileSync(statePath, "utf8"), unknown);
	assert.ok(!JSON.stringify(manager.snapshot()).includes("IMPORTANT_UNKNOWN_STATE"));
});

test("文件模式不安全时拒绝读取并使用 memory-only degraded 标记", async () => {
	const directory = testDir("unsafe-mode");
	seededSalt(directory);
	const saltPath = join(directory, "quota-salt.json");
	chmodSync(saltPath, 0o644);
	const manager = await managerAt(directory);
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
});

test("同步接口待初始化时拒绝使用临时盐，初始化后持久 scope 可恢复", async () => {
	const directory = testDir("initialized-salt");
	const manager = createQuotaManager({ stateStore: createPrivateQuotaStateStore(directory), clock: () => 10_000 });
	assert.throws(() => manager.recordFailure("tavily", "key", "rate_limited", { credential: SECRET }), { message: "QUOTA_MANAGER_NOT_INITIALIZED" });
	await manager.initialize();
	manager.recordFailure("tavily", "key", "rate_limited", { credential: SECRET });
	assert.equal((await manager.flush()).status, "persisted");
	const restored = await managerAt(directory);
	assert.equal(restored.getCooldown("tavily", "key", SECRET).failureCount, 1);
});

test("同一 scope 反复更新不累积文件，超过 100 次仍能恢复", async () => {
	const directory = testDir("bounded-updates");
	let now = 10_000;
	const manager = await managerAt(directory, () => now);
	for (let index = 0; index < 100; index++) {
		now += 1_000;
		manager.recordFailure("tavily", "key", "rate_limited", { credential: "FAKE_STABLE_SCOPE", cooldownMs: 60_000 });
		assert.equal((await manager.flush()).status, "persisted");
	}
	const names = readdirSync(directory);
	assert.equal(names.filter((name) => name.startsWith("scope-")).length, 1);
	assert.equal(names.length, 2, "单个 scope 始终只占一个文件，另有盐文件");
	const restored = await managerAt(directory, () => now);
	assert.equal(restored.getCooldown("tavily", "key", "FAKE_STABLE_SCOPE").failureCount, 100);
});

test("未发布的追加式旧格式被识别为未知内容并保持不覆盖", async () => {
	const directory = testDir("append-format");
	seededSalt(directory);
	const oldPath = join(directory, `scope-${"a".repeat(64)}-rate_limited-123-${"b".repeat(16)}.json`);
	const oldContent = JSON.stringify({ version: 1, entry: { marker: "PRESERVE_UNKNOWN_FILE" } });
	writeFileSync(oldPath, oldContent, { mode: 0o600 });
	const manager = await managerAt(directory);
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
	assert.equal(readFileSync(oldPath, "utf8"), oldContent);
});

test("未知或过期锁只产生固定超时诊断，不破坏锁文件", async () => {
	const directory = testDir("held-lock");
	const manager = await managerAt(directory);
	const lockPath = join(directory, ".quota-state.lock");
	const lockContent = JSON.stringify({ version: 1, pid: 99999999, nonce: "UNKNOWN_LOCK_OWNER" });
	writeFileSync(lockPath, lockContent, { mode: 0o600 });
	manager.recordFailure("exa", "anonymous", "rate_limited");
	const result = await manager.flush();
	assert.deepEqual(result, { status: "degraded", reason: "QUOTA_STATE_LOCK_TIMEOUT" });
	assert.equal(readFileSync(lockPath, "utf8"), lockContent);
});

test("已有非私有状态目录只退化，不自动修改未知目录权限", async () => {
	const directory = testDir("unsafe-directory");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o755);
	const manager = await managerAt(directory);
	assert.equal(manager.snapshot().persistence, "degraded");
	assert.equal((await manager.flush()).status, "degraded");
	assert.equal(statSync(directory).mode & 0o777, 0o755);
});

test("初始化并发写入时只恢复完整事务快照", async () => {
	const directory = testDir("load-transaction");
	seededSalt(directory);
	const writer = createPrivateQuotaStateStore(directory);
	const entries = Array.from({ length: 8 }, (_, index) => ({
		scopeId: (index + 1).toString(16).padStart(64, "0"),
		backend: "exa",
		channel: "anonymous",
		reason: "rate_limited",
		failureCount: 1,
		until: 70_000,
		lastFailureAt: 10_000,
		updatedAt: 10_000,
	}));
	const [saved, ...loaded] = await Promise.all([
		writer.save({ version: 1, salt, entries }),
		...Array.from({ length: 8 }, () => createPrivateQuotaStateStore(directory).load()),
	]);
	assert.equal(saved.status, "saved");
	for (const snapshot of loaded) {
		assert.equal(snapshot.status, "ok");
		assert.ok(snapshot.state.entries.length === 0 || snapshot.state.entries.length === 8);
	}
	assert.equal((await createPrivateQuotaStateStore(directory).load()).state.entries.length, 8);
});
