import type { ChildProcess } from "node:child_process";

export function waitForProcess(
	proc: ChildProcess,
	signal?: AbortSignal,
	onClose?: () => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let exited = proc.exitCode !== null || proc.signalCode !== null;
		let settled = false;
		let aborted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (killTimer !== undefined) clearTimeout(killTimer);
			killTimer = undefined;
			signal?.removeEventListener("abort", abort);
		};
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			exited = true;
			cleanup();
			proc.removeListener("exit", onExit);
			proc.removeListener("close", onClosed);
			proc.removeListener("error", onError);
			if (aborted) reject(new Error("Subagent was aborted"));
			else resolve(code);
		};
		const onExit = () => {
			exited = true;
			cleanup();
		};
		const onClosed = (code: number | null) => {
			if (settled) return;
			onClose?.();
			finish(code ?? 0);
		};
		const onError = () => finish(1);
		const abort = () => {
			if (exited || settled || aborted) return;
			aborted = true;
			// killed 只表示发送过信号，必须根据真实退出状态决定是否升级。
			killTimer = setTimeout(() => {
				killTimer = undefined;
				if (!exited && !settled && proc.exitCode === null && proc.signalCode === null)
					proc.kill("SIGKILL");
			}, 5000);
			proc.kill("SIGTERM");
		};

		proc.once("exit", onExit);
		proc.once("close", onClosed);
		proc.once("error", onError);
		// 传入时进程可能已经退出，此时 exit / close 事件不会再发生：
		// 必须直接结算，否则 Promise 会永久挂起。
		if (exited) {
			finish(proc.exitCode ?? 0);
			return;
		}
		if (signal) {
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		}
	});
}
