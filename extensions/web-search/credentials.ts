/**
 * Web Search 系统密钥库访问层
 *
 * 只负责「读 / 删」系统密钥库中的 API key，不做任何写入（写入由用户在终端
 * 通过平台自带命令安全完成，见 auth.ts 的配置说明）。支持的平台：
 * - macOS：`/usr/bin/security`（Keychain）
 * - Linux：`secret-tool`（Secret Service）
 * - 其他平台：不支持，只能使用环境变量
 *
 * 安全约束（务必保持）：
 * - 只通过子进程参数与 stdin 传递 key；key 绝不进入 argv、日志、会话或错误信息。
 * - 错误信息只含退出码，不含 stdout / stderr 内容。
 * - 读取失败（命令缺失、密钥库锁定、权限不足）与「没有条目」必须区分：
 *   前者返回 unavailable，后者返回 missing。
 *
 * 该模块可注入 runner 与平台，测试用 fake 覆盖，不触碰真实 Keychain / Secret Service。
 *
 * @module pi-web-search-credentials
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";

/** 支持凭据配置的后端标识。 */
export type SecretBackend = "exa" | "parallel";

/** 系统密钥库的 service 前缀；条目名为 `${SECRET_SERVICE_PREFIX}-${backend}`。 */
export const SECRET_SERVICE_PREFIX = "pi-web-search";
/** Linux Secret Service 用来归组条目的 service 属性值。 */
export const SECRET_TOOL_SERVICE = "pi-web-search";

/** 一次子进程调用的结果；仅保留退出码与输出供内部判断。 */
export interface ExecResult {
	/** 进程退出码，spawn 失败时为 1。 */
	code: number;
	/** stdout（读取密码时即密码本身，绝不可外传）。 */
	stdout: string;
	/** stderr（可能包含系统提示，绝不可外传）。 */
	stderr: string;
}

/** 可注入的子进程执行器，便于测试。 */
export type ExecRunner = (bin: string, args: string[], stdin?: string) => Promise<ExecResult>;

/** 读取结果三态：找到 / 无条目 / 不可用（含诊断原因）。 */
export type SecretReadResult =
	| { status: "found"; value: string }
	| { status: "missing" }
	| { status: "unavailable"; reason: string };

/** 删除结果三态：已删除 / 无条目 / 不可用（含诊断原因）。 */
export type SecretClearResult =
	| { status: "deleted" }
	| { status: "missing" }
	| { status: "unavailable"; reason: string };

/** 凭据存储抽象；测试注入 fake，生产按平台选择实现。 */
export interface SecretStore {
	/** 实际使用的密钥库类型；none 表示该平台没有系统密钥库。 */
	readonly kind: "keychain" | "secret-tool" | "none";
	/** 读取某个后端的 key；不可用或失败时返回 unavailable，绝不抛错。 */
	read(backend: SecretBackend): Promise<SecretReadResult>;
	/** 删除某个后端的 key；失败时返回 unavailable，绝不抛错。 */
	clear(backend: SecretBackend): Promise<SecretClearResult>;
}

/** macOS 系统自带的 security 命令行路径。 */
const SECURITY_BIN = "/usr/bin/security";
/** macOS security 的读取子命令。 */
const SECURITY_LOOKUP = "find-generic-password";
const SECURITY_DELETE = "delete-generic-password";
/** Linux Secret Service 的命令行工具。 */
const SECRET_TOOL_BIN = "secret-tool";
/** macOS security 找不到条目时的退出码（errSecItemNotFound）。 */
const MAC_NOT_FOUND_EXIT = 44;
/** secret-tool lookup 无匹配时的退出码。 */
const SECRET_TOOL_NOT_FOUND_EXIT = 1;
/** 单次密钥库命令的最长执行时间，超时即杀掉子进程并按不可用处理。 */
export const EXEC_TIMEOUT_MS = 5_000;

/**
 * 真实执行一个子进程。
 * stdin 只在需要时写入并立即关闭；stdout / stderr 只缓存在内存，
 * 由调用方决定是否使用，不会进入日志。
 * 超过 timeoutMs 仍未结束时杀掉子进程并 reject（由调用方归为 unavailable），
 * 避免密钥库挂起把整个搜索或菜单永久卡住。
 */
export function spawnExec(
	bin: string,
	args: string[],
	stdin?: string,
	timeoutMs: number = EXEC_TIMEOUT_MS,
): Promise<ExecResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		/** 只允许第一个结果生效：正常结束、spawn 失败与超时三选一。 */
		const finish = (settle: () => void): void => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			settle();
		};
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(() => reject(new Error(`凭据库命令超时（超过 ${timeoutMs}ms）`)));
		}, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
		// 写入失败（如进程提前退出）不额外抛出：退出码已足够说明问题。
		child.stdin?.on("error", () => undefined);
		if (stdin !== undefined) child.stdin?.write(stdin);
		child.stdin?.end();
	});
}

/** 去掉子进程输出末尾的换行，不改动 key 内容；空白结果视为无。 */
function readSecretValue(stdout: string): string | undefined {
	const value = stdout.replace(/\r?\n$/u, "");
	return value.length > 0 ? value : undefined;
}

/** 取配置账号名：优先 $USER，回退系统用户名。与配置命令里的 `-a "$USER"` 对齐。 */
export function currentAccount(): string {
	const user = process.env.USER;
	if (typeof user === "string" && user.trim().length > 0) return user.trim();
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

/** macOS Keychain 实现。 */
export class MacKeychainStore implements SecretStore {
	readonly kind = "keychain" as const;

	constructor(
		private readonly run: ExecRunner = spawnExec,
		private readonly account: string = currentAccount(),
	) {}

	async read(backend: SecretBackend): Promise<SecretReadResult> {
		// 读：find-generic-password -a <account> -s <service> -w，密码在 stdout。
		const result = await this.call([
			SECURITY_LOOKUP,
			"-a",
			this.account,
			"-s",
			this.service(backend),
			"-w",
		]);
		if (typeof result === "string") return { status: "unavailable", reason: result };
		if (result.code === MAC_NOT_FOUND_EXIT) return { status: "missing" };
		if (result.code !== 0) {
			return { status: "unavailable", reason: `security 读取失败（退出码 ${result.code}）` };
		}
		const value = readSecretValue(result.stdout);
		return value === undefined ? { status: "missing" } : { status: "found", value };
	}

	async clear(backend: SecretBackend): Promise<SecretClearResult> {
		const result = await this.call([
			SECURITY_DELETE,
			"-a",
			this.account,
			"-s",
			this.service(backend),
		]);
		if (typeof result === "string") return { status: "unavailable", reason: result };
		if (result.code === 0) return { status: "deleted" };
		if (result.code === MAC_NOT_FOUND_EXIT) return { status: "missing" };
		return { status: "unavailable", reason: `security 删除失败（退出码 ${result.code}）` };
	}

	/** 返回执行结果，或命令缺失时的诊断文本。 */
	private async call(args: string[]): Promise<ExecResult | string> {
		try {
			return await this.run(SECURITY_BIN, args);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("凭据库命令超时")) {
				return "security 命令执行超时（系统密钥库无响应）";
			}
			return "security 命令不可用（系统密钥库无法访问）";
		}
	}

	private service(backend: SecretBackend): string {
		return `${SECRET_SERVICE_PREFIX}-${backend}`;
	}
}

/** Linux Secret Service（secret-tool）实现。 */
export class SecretToolStore implements SecretStore {
	readonly kind = "secret-tool" as const;

	constructor(private readonly run: ExecRunner = spawnExec) {}

	async read(backend: SecretBackend): Promise<SecretReadResult> {
		const result = await this.call(["lookup", "service", SECRET_TOOL_SERVICE, "provider", backend]);
		if (typeof result === "string") return { status: "unavailable", reason: result };
		if (result.code === SECRET_TOOL_NOT_FOUND_EXIT) {
			// 无匹配项通常是空 stderr；少数实现会写明「未找到」，也按 missing 处理。
			// 其余 stderr 视为 D-Bus / 锁定 / 会话故障，不能误报为未配置。
			const stderr = result.stderr.trim();
			if (stderr.length === 0 || /no such secret|secret.*not found|no matching secret/iu.test(stderr)) {
				return { status: "missing" };
			}
			return { status: "unavailable", reason: "secret-tool 读取失败（退出码 1，密钥库不可用）" };
		}
		if (result.code !== 0) {
			return { status: "unavailable", reason: `secret-tool 读取失败（退出码 ${result.code}）` };
		}
		const value = readSecretValue(result.stdout);
		return value === undefined ? { status: "missing" } : { status: "found", value };
	}

	async clear(backend: SecretBackend): Promise<SecretClearResult> {
		// secret-tool clear 对不存在的条目也返回 0，先 lookup 才能区分删除与未配置。
		const existing = await this.read(backend);
		if (existing.status === "unavailable") return existing;
		if (existing.status === "missing") return { status: "missing" };
		const result = await this.call(["clear", "service", SECRET_TOOL_SERVICE, "provider", backend]);
		if (typeof result === "string") return { status: "unavailable", reason: result };
		if (result.code === 0) return { status: "deleted" };
		return { status: "unavailable", reason: `secret-tool 删除失败（退出码 ${result.code}）` };
	}

	private async call(args: string[]): Promise<ExecResult | string> {
		try {
			return await this.run(SECRET_TOOL_BIN, args);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("凭据库命令超时")) {
				return "secret-tool 命令执行超时（系统密钥库无响应）";
			}
			return "secret-tool 命令不可用（系统密钥库无法访问）";
		}
	}
}

/** 无系统密钥库的平台：一切读取 / 删除都返回 unavailable。 */
export class NoopSecretStore implements SecretStore {
	readonly kind = "none" as const;

	constructor(private readonly platform: string = process.platform) {}

	private get reason(): string {
		return `平台 ${this.platform} 没有支持的系统密钥库`;
	}

	async read(_backend: SecretBackend): Promise<SecretReadResult> {
		return { status: "unavailable", reason: this.reason };
	}

	async clear(_backend: SecretBackend): Promise<SecretClearResult> {
		return { status: "unavailable", reason: this.reason };
	}
}

/** 按平台选择系统密钥库实现。 */
export function createSecretStore(platform: string = process.platform, run: ExecRunner = spawnExec): SecretStore {
	if (platform === "darwin") return new MacKeychainStore(run);
	if (platform === "linux") return new SecretToolStore(run);
	return new NoopSecretStore(platform);
}
