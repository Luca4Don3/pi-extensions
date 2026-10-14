/**
 * 子进程启动失败的诊断。
 *
 * `getPiInvocation` 在运行时是通用的 node / bun 时会回退到 PATH 里的 `pi`；
 * 一旦找不到或不可执行，spawn 只会给一个裸 error 事件。这里把它转成可行动
 * 的诊断文本，只包含命令名与系统错误码，不打印堆栈或任意系统路径。
 */

/** 把 spawn 失败转成可行动的诊断；command 是实际尝试启动的命令。 */
export function describeSpawnFailure(error: unknown, command: string): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") {
		return `找不到可执行文件 ${command}：请确认 pi 已在 PATH 中，或用绝对路径的 process.execPath 启动 Pi。`;
	}
	if (code === "EACCES") {
		return `可执行文件 ${command} 没有执行权限。`;
	}
	const message = (error as Error | undefined)?.message;
	return `无法启动 ${command}：${typeof message === "string" && message.length > 0 ? message : "未知错误"}`;
}
