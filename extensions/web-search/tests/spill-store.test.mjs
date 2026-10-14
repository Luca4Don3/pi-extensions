import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const realOpen = fs.open;
const realLstat = fs.lstat;
const realUnlink = fs.unlink;
let onOpen;
let onStat;
let onUnlink;
fs.open = (...args) => (onOpen ?? realOpen)(...args);
fs.lstat = (...args) => (onStat ?? realLstat)(...args);
fs.unlink = (...args) => (onUnlink ?? realUnlink)(...args);
syncBuiltinESMExports();
const { spillFullText, SPILL_MAX_BYTES } = await createJiti(import.meta.url).import(fileURLToPath(new URL("../spill-store.ts", import.meta.url)));
const base = fileURLToPath(new URL("../.temp/", import.meta.url));
await fs.mkdir(base, { recursive: true });
const uid = process.getuid();
const leaf = (root) => join(root, `pi-web-search-${uid}`);
const fixture = () => fs.mkdtemp(join(base, "spill-security-"));
// 只在新建时控制权限，恢复 umask，不修复或删除任何已有现场。
async function createMode(path, mode, directory = true) {
	const previous = process.umask(0);
	try {
		if (directory) await fs.mkdir(path, { mode });
		else await fs.writeFile(path, "原始内容", { mode, flag: "wx" });
	} finally { process.umask(previous); }
}

test("已有 0777 叶目录拒绝且权限不变", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o777);
	await assert.rejects(spillFullText("正文", root));
	assert.equal((await fs.lstat(leaf(root))).mode & 0o777, 0o777);
	assert.deepEqual(await fs.readdir(leaf(root)), []);
});

test("叶目录符号链接拒绝且目标不变", async () => {
	const root = await fixture();
	const target = join(root, "target");
	await createMode(target, 0o700);
	await fs.writeFile(join(target, "sentinel"), "保留");
	await fs.symlink(target, leaf(root));
	await assert.rejects(spillFullText("正文", root));
	assert.deepEqual(await fs.readdir(target), ["sentinel"]);
	assert.equal(await fs.readFile(join(target, "sentinel"), "utf8"), "保留");
});

test("非目录叶节点拒绝且不覆盖", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o600, false);
	await assert.rejects(spillFullText("正文", root));
	assert.equal(await fs.readFile(leaf(root), "utf8"), "原始内容");
});

test("伪造叶目录所有者拒绝", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o700);
	onStat = async (...args) => {
		const stat = await realLstat(...args);
		if (String(args[0]) === leaf(root)) stat.uid = uid + 1;
		return stat;
	};
	try { await assert.rejects(spillFullText("正文", root)); }
	finally { onStat = undefined; }
});

for (const kind of ["公开文件", "恶意链接"]) test(`排他创建遇${kind}冲突不覆盖`, async () => {
	const root = await fixture();
	const target = join(root, "target");
	await createMode(target, 0o644, false);
	let conflict;
	onOpen = async (...args) => {
		conflict = args[0];
		if (kind === "公开文件") await createMode(conflict, 0o644, false);
		else await fs.symlink(target, conflict);
		return realOpen(...args);
	};
	try { await assert.rejects(spillFullText("不能覆盖", root)); }
	finally { onOpen = undefined; }
	assert.equal(await fs.readFile(target, "utf8"), "原始内容");
	if (kind === "公开文件") {
		assert.equal(await fs.readFile(conflict, "utf8"), "原始内容");
		assert.equal((await fs.lstat(conflict)).mode & 0o777, 0o644);
	} else assert.equal((await fs.lstat(conflict)).isSymbolicLink(), true);
});

test("正常目录 0700、文件 0600 与两 MiB 字节上限", async () => {
	const root = await fixture();
	const result = await spillFullText("汉".repeat(SPILL_MAX_BYTES), root);
	assert.equal(result.complete, false);
	assert.equal((await fs.stat(result.path)).size, SPILL_MAX_BYTES);
	assert.equal((await fs.stat(result.path)).mode & 0o777, 0o600);
	assert.equal((await fs.stat(dirname(result.path))).mode & 0o777, 0o700);
	assert.equal((await spillFullText("完整", root)).complete, true);
});

test("超过保留数量的同毫秒并发落盘全部路径可读", async () => {
	const root = await fixture();
	const realNow = Date.now;
	const now = realNow();
	Date.now = () => now;
	let results;
	try {
		results = await Promise.all(Array.from({ length: 24 }, (_, i) => spillFullText(`正文${i}`, root)));
	} finally { Date.now = realNow; }
	assert.equal(new Set(results.map((r) => r.path)).size, 24);
	for (let i = 0; i < results.length; i++) assert.equal(await fs.readFile(results[i].path, "utf8"), `正文${i}`);
});

test("时钟回拨且存在二十个未来文件名的旧文件时返回路径可读", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o700);
	const realNow = Date.now;
	const now = realNow();
	const rolledBack = now - 3_600_000;
	const old = new Date(rolledBack - 120_000);
	for (let i = 0; i < 20; i++) {
		const path = join(leaf(root), `results-${now + 60_000}-${String(i).padStart(48, "0")}.txt`);
		await createMode(path, 0o600, false);
		await fs.utimes(path, old, old);
	}
	Date.now = () => rolledBack;
	let result;
	try { result = await spillFullText("回拨正文", root); }
	finally { Date.now = realNow; }
	assert.equal(await fs.readFile(result.path, "utf8"), "回拨正文");
	assert.equal((await fs.readdir(leaf(root))).length, 20);
});

test("近期文件超过二十仍保留，旧文件继续尽力清理", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o700);
	const old = new Date(Date.now() - 120_000);
	const recent = [];
	for (let i = 0; i < 26; i++) {
		const path = join(leaf(root), `results-0000000000000-${String(i).padStart(48, "0")}.txt`);
		await createMode(path, 0o600, false);
		if (i < 5) await fs.utimes(path, old, old);
		else recent.push(path);
	}
	const result = await spillFullText("近期正文", root);
	for (const path of recent) assert.equal(await fs.readFile(path, "utf8"), "原始内容");
	assert.equal(await fs.readFile(result.path, "utf8"), "近期正文");
	assert.equal((await fs.readdir(leaf(root))).length, 22);
});

test("清理前复查发现修改时间更新时保留文件", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o700);
	const old = new Date(Date.now() - 120_000);
	let refreshed;
	for (let i = 0; i < 25; i++) {
		const path = join(leaf(root), `results-0000000000000-${String(i).padStart(48, "0")}.txt`);
		await createMode(path, 0o600, false);
		await fs.utimes(path, old, old);
		if (i === 0) refreshed = path;
	}
	let visits = 0;
	onStat = async (...args) => {
		if (String(args[0]) === refreshed && ++visits === 2) {
			const now = new Date();
			await fs.utimes(refreshed, now, now);
		}
		return realLstat(...args);
	};
	try { await spillFullText("正文", root); }
	finally { onStat = undefined; }
	assert.equal(visits, 2);
	assert.equal(await fs.readFile(refreshed, "utf8"), "原始内容");
	assert.equal((await fs.readdir(leaf(root))).length, 20);
});

test("临时根符号链接解析到真实目录", async () => {
	const root = await fixture();
	const alias = join(root, "alias");
	const actual = join(root, "actual");
	await createMode(actual, 0o700);
	await fs.symlink(actual, alias);
	const result = await spillFullText("正文", alias);
	assert.equal(dirname(result.path), join(await fs.realpath(actual), `pi-web-search-${uid}`));
});

test("无粘滞位的共享父目录拒绝且权限不变", async () => {
	const root = await fixture();
	const unsafe = join(root, "unsafe");
	await createMode(unsafe, 0o777);
	await assert.rejects(spillFullText("正文", unsafe));
	assert.deepEqual(await fs.readdir(unsafe), []);
	assert.equal((await fs.lstat(unsafe)).mode & 0o777, 0o777);
});

test("清理仅限严格命名的私有普通单链接文件，失败不阻断成功", async () => {
	const root = await fixture();
	await createMode(leaf(root), 0o700);
	const name = (i) => `results-0000000000000-${String(i).padStart(48, "0")}.txt`;
	const old = new Date(Date.now() - 120_000);
	for (let i = 0; i < 25; i++) {
		const path = join(leaf(root), name(i));
		await createMode(path, 0o600, false);
		await fs.utimes(path, old, old);
	}
	const publicFile = join(leaf(root), name(100));
	await createMode(publicFile, 0o644, false);
	const link = join(leaf(root), name(101));
	await fs.symlink(publicFile, link);
	const directory = join(leaf(root), name(102));
	await createMode(directory, 0o700);
	const hardlink = join(leaf(root), name(103));
	await fs.link(join(leaf(root), name(24)), hardlink);
	await fs.writeFile(join(leaf(root), "results-legacy.txt"), "保留");
	await spillFullText("正文", root);
	const names = await fs.readdir(leaf(root));
	for (const path of [publicFile, link, directory, hardlink]) await fs.lstat(path);
	assert.ok(names.includes("results-legacy.txt"));
	assert.equal(names.length, 26);
	onUnlink = async () => { throw new Error("注入清理故障"); };
	try {
		for (let i = 0; i < 3; i++) assert.equal((await spillFullText("正文", root)).complete, true);
	} finally { onUnlink = undefined; }
});
