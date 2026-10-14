/** 临时正文仓库：防御其他用户，不防御同 UID 恶意进程或管理员。
 * Node 没有 openat；路径复查不能提供同 UID 并发替换下的原子保证。
 */
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";

export const SPILL_MAX_BYTES = 2 * 1024 * 1024;
const KEEP_FILES = 20;
const FILE_NAME = /^results-\d{13,}-[a-f0-9]{48}\.txt$/u;
export interface SpillResult { path: string; complete: boolean }

function refuse(): never { throw new Error("临时正文存储不安全或不可用"); }
function same(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function privateEntry(stat: Stats, uid: number): boolean {
	return stat.uid === uid && (stat.mode & 0o077) === 0;
}
function checkDirectory(stat: Stats, uid: number, leaf: boolean): void {
	if (stat.isSymbolicLink() || !stat.isDirectory()) refuse();
	if (leaf) {
		if (!privateEntry(stat, uid)) refuse();
	} else {
		if (stat.uid !== uid && stat.uid !== 0) refuse();
		// 可被其他用户写入的祖先必须有粘滞位，且由本用户或 root 管理。
		if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) refuse();
	}
}
function privateFile(stat: Stats, uid: number): boolean {
	return stat.isFile() && !stat.isSymbolicLink() && privateEntry(stat, uid) && stat.nlink === 1;
}

/** 清理本次创建但未完成的文件：先 lstat 复核仍是本进程创建的私有普通单链接文件、
 * 且与创建时状态一致，再 unlink；清理失败不覆盖原始错误，也不重试网络搜索。
 * 没有创建时状态（open 后首次 lstat 就失败）时无法确认归属，宁可留下也不误删他人内容。 */
async function discardCreatedFile(file: string, created: Stats | undefined, uid: number): Promise<void> {
	if (created === undefined) return;
	try {
		const latest = await lstat(file);
		if (!privateFile(latest, uid) || !same(created, latest)) return;
		await unlink(file);
	} catch { /* 清理失败不覆盖原始错误。 */ }
}

/** 每次操作重新锚定系统临时根，允许 macOS /var 等系统符号链接。 */
export async function spillFullText(text: string, temporaryRoot = tmpdir()): Promise<SpillResult> {
	if (process.getuid === undefined) refuse();
	const uid = process.getuid();
	const root = await realpath(temporaryRoot);
	const anchors: { path: string; stat: Stats }[] = [];
	let current = parse(root).root;
	for (const part of ["", ...root.slice(current.length).split(sep).filter(Boolean)]) {
		current = join(current, part);
		const stat = await lstat(current);
		checkDirectory(stat, uid, false);
		anchors.push({ path: current, stat });
	}
	const directory = join(root, `pi-web-search-${uid}`);
	const verify = async (): Promise<void> => {
		for (const anchor of anchors) {
			const latest = await lstat(anchor.path);
			checkDirectory(latest, uid, anchor.path === directory);
			if (!same(latest, anchor.stat)) refuse();
		}
	};
	await verify();
	try { await mkdir(directory, { mode: 0o700 }); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
	const leaf = await lstat(directory);
	checkDirectory(leaf, uid, true);
	anchors.push({ path: directory, stat: leaf });
	await verify();
	const file = join(directory, `results-${Date.now()}-${randomBytes(24).toString("hex")}.txt`);
	const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
	const bytes = Buffer.from(text, "utf8");
	// O_EXCL 创建成功即锚定归属：任何后续失败路径都据此安全清理本次创建的文件。
	let created: Stats | undefined;
	let persisted = false;
	try {
		created = await lstat(file);
		if (!privateFile(created, uid)) refuse();
		const stat = await handle.stat();
		if (!privateFile(stat, uid) || !same(created, stat)) refuse();
		await verify();
		await handle.writeFile(bytes.subarray(0, SPILL_MAX_BYTES));
		const latest = await lstat(file);
		if (!privateFile(latest, uid) || !same(created, latest)) refuse();
		await verify();
		// 写入与复查全部通过即视为已完整落盘：此后 close 失败不得删除，否则会把已经
		// 取得的完整正文丢掉，调用方只剩截断文本。残留文件交由尽力清理回收。
		persisted = true;
		await handle.close();
	} catch (error) {
		// close 幂等：try 内 close 抛错也会走到这里，二次关闭不会覆盖原始错误。
		try { await handle.close(); } catch { /* 关闭失败不覆盖原始错误。 */ }
		if (!persisted) await discardCreatedFile(file, created, uid);
		throw error;
	}
	// 仅尽力清理，不保证永久保存，也不防御同 UID 攻击；只删除校验过的私有普通单链接文件。
	// 排除本次结果，并给近期文件固定 60 秒宽限；并发写入时允许暂时超过保留数量。
	try {
		await verify();
		const cutoff = Date.now() - 60_000;
		const candidates: { name: string; stat: Stats }[] = [];
		for (const name of (await readdir(directory)).filter((name) => FILE_NAME.test(name))) {
			const stat = await lstat(join(directory, name));
			if (privateFile(stat, uid)) candidates.push({ name, stat });
		}
		let excess = Math.max(0, candidates.length - KEEP_FILES);
		for (const candidate of candidates.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)) {
			if (excess === 0) break;
			const path = join(directory, candidate.name);
			if (path === file || candidate.stat.mtimeMs > cutoff) continue;
			await verify();
			const latest = await lstat(path);
			// 复查修改时间：扫描后被更新的文件也保留，避免删除正在使用的结果。
			if (privateFile(latest, uid) && same(latest, candidate.stat)
				&& latest.mtimeMs === candidate.stat.mtimeMs && latest.mtimeMs <= cutoff) {
				await unlink(path);
				excess--;
			}
		}
	} catch { /* 清理失败不重试网络搜索。 */ }
	return { path: file, complete: bytes.byteLength <= SPILL_MAX_BYTES };
}
