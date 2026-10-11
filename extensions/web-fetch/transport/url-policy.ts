/**
 * URL 与目标地址安全策略。
 *
 * `web_fetch` 与 `web_search` 的本质区别是它会访问调用方给出的任意 URL，
 * 因此这里是把守服务端请求伪造（SSRF）的唯一入口：
 * - 只允许 http / https，且拒绝在 URL 中内嵌用户名与密码。
 * - 只允许解析到公网地址的目标；回环、内网、链路本地、云元数据与各类保留段一律拒绝。
 * - 解析与校验在同一次操作内完成，返回被校验过的具体地址，随后由传输层绑定该地址建连，
 *   避免「先校验域名、再由 HTTP 客户端重新解析到别的地址」这种 DNS 重绑定窗口。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { FetchError } from "../errors.js";

/** 允许的端口；省略时按协议默认（80 / 443）。 */
const ALLOWED_PORTS = new Set([80, 443]);

export interface ResolvedTarget {
	/** 规范化后的原始 URL（不含凭据）。 */
	readonly url: URL;
	/** 已通过校验的目标 IP 字面量。 */
	readonly address: string;
	/** 已通过校验的地址族。 */
	readonly family: 4 | 6;
}

/** 把 IPv4 点分地址解析为 32 位无符号整数；非法输入返回 undefined。 */
function parseIPv4(value: string): number | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) return undefined;
	let result = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/u.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		result = result * 256 + octet;
	}
	return result;
}

/** 判断 IPv4 是否属于必须拒绝的保留段。 */
function isBlockedIPv4(value: number): boolean {
	// 逐段判断比维护掩码表更难写错；所有区间都来自 IANA 特殊用途地址注册表。
	const octets = [
		Math.floor(value / 2 ** 24) & 0xff,
		Math.floor(value / 2 ** 16) & 0xff,
		Math.floor(value / 2 ** 8) & 0xff,
		value & 0xff,
	];
	const [a, b] = octets;
	if (a === 0) return true; // 0.0.0.0/8 当前网络
	if (a === 10) return true; // 10.0.0.0/8 私有
	if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 运营商级 NAT
	if (a === 127) return true; // 127.0.0.0/8 回环
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地（含 169.254.169.254 元数据）
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 私有
	if (a === 192 && b === 0 && (octets[2] === 0 || octets[2] === 2)) return true; // 192.0.0.0/24 与 192.0.2.0/24
	if (a === 192 && b === 168) return true; // 192.168.0.0/16 私有
	if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 基准测试
	if (a === 198 && b === 51 && octets[2] === 100) return true; // 198.51.100.0/24 测试网
	if (a === 203 && b === 0) return true; // 203.0.113.0/24 测试网
	if (a >= 224) return true; // 224.0.0.0/4 组播、240.0.0.0/4 保留与广播
	return false;
}

/** 把 IPv6 按 8 组 16 位展开，压缩表示法与 IPv4 尾部都先归一化。 */
function expandIPv6(value: string): number[] | undefined {
	let text = value.trim().toLowerCase();
	// 去掉可能存在的 IPv4 映射后缀，例如 ::ffff:192.0.2.1
	const dotted = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/u);
	if (dotted !== null) {
		const embedded = parseIPv4(dotted[2]!);
		if (embedded === undefined) return undefined;
		const high = Math.floor(embedded / 2 ** 16);
		const low = embedded % 2 ** 16;
		text = `${dotted[1]}${high.toString(16)}:${low.toString(16)}`;
	}
	if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
	const halves = text.split("::");
	if (halves.length > 2) return undefined;
	const parseGroups = (part: string): number[] | undefined => {
		if (part.length === 0) return [];
		const groups = part.split(":");
		if (groups.length > 8) return undefined;
		const result: number[] = [];
		for (const group of groups) {
			if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
			result.push(Number.parseInt(group, 16));
		}
		return result;
	};
	const head = parseGroups(halves[0] ?? "");
	if (head === undefined) return undefined;
	if (halves.length === 1) {
		if (halves[0]!.includes("::") || head.length !== 8) return undefined;
		return head;
	}
	const tail = parseGroups(halves[1] ?? "");
	if (tail === undefined) return undefined;
	const missing = 8 - head.length - tail.length;
	if (missing < 0) return undefined;
	return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** 判断 IPv6 是否属于必须拒绝的地址；IPv4 映射与 NAT64 递归判断内层 IPv4。 */
function isBlockedIPv6(groups: number[]): boolean {
	const first = groups[0]!;
	if (groups.every((group) => group === 0)) return true; // ::/128 未指定
	if (first === 0 && groups[1] === 0 && groups.every((group, index) => (index < 2 ? true : group === 0))) {
		return true; // ::/128 的各种压缩写法
	}
	// ::/96（IPv4 兼容，已废弃）与 ::ffff:0:0/96（IPv4 映射）都递归判断内层 IPv4，
	// 否则会把 ::ffff:93.184.216.34 这类公网映射地址整段误拒。
	if (first === 0 && groups[1]! === 0 && groups[2]! === 0 && groups[3]! === 0 && groups[4]! === 0 && (groups[5]! === 0 || groups[5]! === 0xffff)) {
		const mapped = (groups[6]! << 16) | groups[7]!;
		return isBlockedIPv4(mapped);
	}
	if (first === 0x64 && groups[1]! === 0xff9b) {
		// 64:ff9b::/96 NAT64：内层 IPv4 必须同样通过校验
		const embedded = (groups[6]! << 16) | groups[7]!;
		return isBlockedIPv4(embedded);
	}
	if (first === 0x100) return true; // 100::/64 丢弃段
	if (first === 0x2001 && groups[1]! === 0x0000) return true; // 2001::/32 Teredo
	if (first === 0x2001 && groups[1]! === 0x0db8) return true; // 2001:db8::/32 文档
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
	if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 站点本地单播
	if ((first & 0xff00) === 0xff00) return true; // ff00::/8 组播
	if (first === 0x2002) return true; // 2002::/16 6to4（内层地址可在转换后指向私网）
	return false;
}

/** 文本形式的 IP 是否允许作为抓取目标。 */
export function isPublicIPAddress(value: string): boolean {
	const version = isIP(value);
	if (version === 4) return !isBlockedIPv4(parseIPv4(value)!);
	if (version === 6) {
		const groups = expandIPv6(value);
		return groups !== undefined && !isBlockedIPv6(groups);
	}
	return false;
}

function checkSignal(signal?: AbortSignal): void {
	if (signal?.aborted === true) throw signalError(signal);
}

function signalError(signal: AbortSignal): FetchError {
	const reason = signal.reason;
	if (reason instanceof FetchError && (reason.kind === "timeout" || reason.kind === "aborted")) return reason;
	return new FetchError("操作已取消", "aborted");
}

/** DNS 操作系统查询本身不可取消；取消时停止等待并消费迟到拒绝。 */
function raceWithSignal<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return operation();
	if (signal.aborted) return Promise.reject(signalError(signal));
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = (): void => signal.removeEventListener("abort", onAbort);
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = (): void => finish(() => reject(signalError(signal)));
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) {
			onAbort();
			return;
		}
		let pending: Promise<T>;
		try {
			pending = operation();
		} catch (error) {
			finish(() => reject(error));
			return;
		}
		Promise.resolve(pending).then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(error)),
		);
	});
}

/** 把主机名或 IP 字面量解析为已校验的公网地址。 */
async function resolveAddress(
	hostname: string,
	signal?: AbortSignal,
	lookupFn: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>> = lookup,
): Promise<{ address: string; family: 4 | 6 } | undefined> {
	// URL 的 IPv6 主机名带方括号，`isIP` 不能直接识别，先剥掉再判断。
	const literal = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	const version = isIP(literal);
	if (version !== 0) {
		return isPublicIPAddress(literal) ? { address: literal, family: version === 6 ? 6 : 4 } : undefined;
	}
	const records = await raceWithSignal(() => lookupFn(hostname, { all: true, verbatim: true }), signal);
	const usable = records.filter((record: { address: string }) => isPublicIPAddress(record.address));
	if (usable.length === 0) return undefined;
	// 只返回已校验的地址；传输层用同一结果建连，不留出重新解析的窗口。
	const chosen = usable[0]!;
	return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * 校验并解析抓取目标。
 * 非法协议、内嵌凭据、非公网地址与不受支持的端口都会返回固定分类的 FetchError，
 * 错误文本不回显调用方给出的原 URL。
 */
export async function resolveFetchTarget(
	rawUrl: string,
	signal?: AbortSignal,
	lookupFn?: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>,
): Promise<ResolvedTarget> {
	checkSignal(signal);
	const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
	if (trimmed.length === 0) throw new FetchError("url 不能为空", "invalid_url");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new FetchError("url 不是合法的绝对地址", "invalid_url");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new FetchError("只支持 http 与 https 协议", "blocked_url");
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		throw new FetchError("url 不得内嵌用户名或密码", "blocked_url");
	}
	if (parsed.port.length > 0 && !ALLOWED_PORTS.has(Number(parsed.port))) {
		throw new FetchError("只允许 80 或 443 端口", "blocked_url");
	}
	if (parsed.hostname.length === 0) throw new FetchError("url 缺少主机名", "invalid_url");
	try {
		const resolved = await resolveAddress(parsed.hostname, signal, lookupFn);
		checkSignal(signal);
		if (resolved === undefined) throw new FetchError("目标不是公网地址", "blocked_url");
		return { url: parsed, address: resolved.address, family: resolved.family };
	} catch (error) {
		checkSignal(signal);
		if (error instanceof FetchError) throw error;
		throw new FetchError("目标地址解析失败", "blocked_url");
	}
}
