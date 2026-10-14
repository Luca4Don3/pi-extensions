import type { ChildProcess } from "node:child_process";

export const DRAIN_TIMEOUT_MS = 1000;

export function waitForProcess(
	proc: ChildProcess,
	signal?: AbortSignal,
	onClose?: () => void,
	onDiagnostic?: (message: string) => void,
): Promise<number> {
	return new Promise((resolve, reject) => {
		let exited = proc.exitCode !== null || proc.signalCode !== null;
		let settled = false;
		let aborted = false;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;
		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			if (killTimer !== undefined) clearTimeout(killTimer);
			if (drainTimer !== undefined) clearTimeout(drainTimer);
			signal?.removeEventListener("abort", abort);
			proc.removeListener("exit", onExit);
			proc.removeListener("close", onClosed);
			proc.removeListener("error", onError);
			try {
				onClose?.();
				if (aborted) reject(new Error("Subagent was aborted"));
				else resolve(code);
			} catch (error) { reject(error); }
		};
		const exitStatus = (code: number | null, exitSignal: NodeJS.Signals | null) => {
			if (exitSignal) {
				onDiagnostic?.(`子进程因信号 ${exitSignal} 退出`);
				return code || 1;
			}
			return code ?? 1;
		};
		const onExit = () => {
			exited = true;
			if (killTimer !== undefined) clearTimeout(killTimer);
			// exit 不代表管道已关闭；后代可能仍持有写端，只允许有界排空。
			drainTimer = setTimeout(() => {
				onDiagnostic?.("输出排空超过 1000 毫秒，已关闭本地管道；输出不完整");
				proc.stdout?.destroy();
				proc.stderr?.destroy();
				finish(exitStatus(proc.exitCode, proc.signalCode) || 1);
			}, DRAIN_TIMEOUT_MS);
		};
		const onClosed = (code: number | null, exitSignal: NodeJS.Signals | null) => {
			if (!settled) finish(exitStatus(code, exitSignal));
		};
		const onError = () => finish(1);
		const abort = () => {
			if (settled || aborted) return;
			aborted = true;
			// 排空期间的取消仍有效，但不能向已退出的进程发送信号。
			if (exited) return;
			killTimer = setTimeout(() => {
				if (!exited && !settled && proc.exitCode === null && proc.signalCode === null)
					proc.kill("SIGKILL");
			}, 5000);
			proc.kill("SIGTERM");
		};
		proc.once("exit", onExit);
		proc.once("close", onClosed);
		proc.once("error", onError);
		if (exited && (!proc.stdout || proc.stdout.destroyed) && (!proc.stderr || proc.stderr.destroyed)) {
			finish(exitStatus(proc.exitCode, proc.signalCode));
			return;
		}
		if (signal) {
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
		}
		if (exited) onExit();
	});
}
