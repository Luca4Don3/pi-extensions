/** 临时正文落盘失败路径的清理语义：创建后任何失败都必须安全清理本次文件。 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

// spill-store.ts 用命名导入拿 fs/promises：包装器必须在加载它之前装好。
const realOpen = fs.open;
const realLstat = fs.lstat;
const realUnlink = fs.unlink;
let onOpen;
let onLstat;
let onUnlink;
fs.open = (...args) => (onOpen ?? realOpen)(...args);
fs.lstat = (...args) => (onLstat ?? realLstat)(...args);
fs.unlink = (...args) => (onUnlink ?? realUnlink)(...args);
syncBuiltinESMExports();

const jiti = createJiti(import.meta.url);
const { spillFullText } = await jiti.import(fileURLToPath(new URL("../spill-store.ts", import.meta.url)));
const base = fileURLToPath(new URL("../.temp/", import.meta.url));
await fs.mkdir(base, { recursive: true });
const uid = process.getuid();
const leaf = (root) => join(root, `pi-web-search-${uid}`);
const fixture = () => fs.mkdtemp(join(base, "spill-cleanup-"));

test("创建后写入部分成功随即失败：清理未完成文件且保留原错误", async () => {
	const root = await fixture();
	const target = {};
	onOpen = async (...args) => {
		target.path = String(args[0]);
		const handle = await realOpen(...args);
		const write = handle.writeFile.bind(handle);
		handle.writeFile = async (...values) => {
			// 先真实落一部分字节，再失败：留下未完成的文件。
			await write(Buffer.from("半截正文"));
			throw new Error("注入写入故障");
		};
		return handle;
	};
	try {
		await assert.rejects(spillFullText("完整正文", root), /注入写入故障/);
	} finally {
		onOpen = undefined;
	}
	assert.deepEqual(await fs.readdir(leaf(root)), [], "失败后不得残留未完成文件");
});

test("创建后句柄 stat 失败：仍按创建时状态清理文件", async () => {
	const root = await fixture();
	onOpen = async (...args) => {
		const handle = await realOpen(...args);
		handle.stat = async () => { throw new Error("注入状态故障"); };
		return handle;
	};
	try {
		await assert.rejects(spillFullText("正文", root), /注入状态故障/);
	} finally {
		onOpen = undefined;
	}
	assert.deepEqual(await fs.readdir(leaf(root)), []);
});

test("创建后路径复查失败：清理本次文件且不覆盖复查错误", async () => {
	const root = await fixture();
	let fileStats = 0;
	onLstat = async (...args) => {
		const path = String(args[0]);
		if (/results-\d{13,}-[a-f0-9]{48}\.txt$/u.test(path) && ++fileStats === 2) {
			throw new Error("注入路径复查故障");
		}
		return realLstat(...args);
	};
	try {
		await assert.rejects(spillFullText("正文", root), /注入路径复查故障/);
	} finally {
		onLstat = undefined;
	}
	assert.deepEqual(await fs.readdir(leaf(root)), []);
});

test("创建后目录复查失败：清理本次文件且不覆盖复查错误", async () => {
	const root = await fixture();
	let created = false;
	onOpen = async (...args) => {
		created = true;
		return realOpen(...args);
	};
	onLstat = async (...args) => {
		// 只在文件创建之后对锚定根复查时注入故障。
		if (created && String(args[0]) === root) throw new Error("注入目录复查故障");
		return realLstat(...args);
	};
	try {
		await assert.rejects(spillFullText("正文", root), /注入目录复查故障/);
	} finally {
		onOpen = undefined;
		onLstat = undefined;
	}
	assert.deepEqual(await fs.readdir(leaf(root)), []);
});

test("完整落盘后 close 失败：保留已写入正文并照旧报告失败", async () => {
	const root = await fixture();
	onOpen = async (...args) => {
		const handle = await realOpen(...args);
		handle.close = async () => { throw new Error("注入关闭故障"); };
		return handle;
	};
	try {
		await assert.rejects(spillFullText("正文", root), /注入关闭故障/);
	} finally {
		onOpen = undefined;
	}
	// 写入与复查已通过，close 失败不得删除完整正文，否则调用方只剩下截断文本。
	const remaining = await fs.readdir(leaf(root));
	assert.equal(remaining.length, 1);
	assert.equal(await fs.readFile(join(leaf(root), remaining[0]), "utf8"), "正文");
});

test("清理 unlink 失败时不覆盖原始失败原因", async () => {
	const root = await fixture();
	onOpen = async (...args) => {
		const handle = await realOpen(...args);
		const write = handle.writeFile.bind(handle);
		handle.writeFile = async (...values) => {
			await write(Buffer.from("半截"));
			throw new Error("注入写入故障");
		};
		return handle;
	};
	onUnlink = async () => { throw new Error("注入删除故障"); };
	try {
		await assert.rejects(spillFullText("正文", root), /注入写入故障/);
	} finally {
		onOpen = undefined;
		onUnlink = undefined;
	}
});

test("复核发现文件已非私有单链接时拒绝删除，保留现场", async () => {
	const root = await fixture();
	onOpen = async (...args) => {
		const handle = await realOpen(...args);
		const stat = handle.stat.bind(handle);
		handle.stat = async () => {
			const result = await stat();
			// 制造第二个硬链接：本进程创建的文件在复查时已不是单链接。
			await fs.link(String(args[0]), `${String(args[0])}.link`);
			return result;
		};
		return handle;
	};
	try {
		await assert.rejects(spillFullText("正文", root), /临时正文存储不安全或不可用/);
	} finally {
		onOpen = undefined;
	}
	// 非常规文件一律保留，交由调用方或管理员处理，绝不误删。
	const names = await fs.readdir(leaf(root));
	assert.equal(names.length, 2, `应保留原文件与硬链接，实际 ${names}`);
	assert.ok(names.some((name) => name.endsWith(".link")), "应保留硬链接现场");
});
