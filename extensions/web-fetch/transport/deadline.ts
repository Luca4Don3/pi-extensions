/** 抓取操作共用的绝对截止时间与取消控制。 */

import { FetchError } from "../errors.js";

const MAX_TIMER_DELAY = 2_147_483_647;

/** 建立单一预算；deadlineMs 是基于 performance.now() 的绝对截止时刻。 */
export function createFetchDeadline(
	timeoutMs: number,
	externalSignal?: AbortSignal,
	deadlineMs?: number,
): {
	signal: AbortSignal;
	deadlineMs: number;
	check(): void;
	run<T>(operation: () => T | PromiseLike<T>): Promise<T>;
	dispose(): void;
} {
	const startedAt = performance.now();
	const absoluteDeadline = deadlineMs ?? startedAt + timeoutMs;
	if (!Number.isFinite(absoluteDeadline)) throw new RangeError("截止时刻必须是有限数值");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	let abortError: FetchError | undefined;

	const makeError = (kind: "timeout" | "aborted"): FetchError =>
		kind === "timeout" ? new FetchError("抓取超时", "timeout") : new FetchError("操作已取消", "aborted");
	const externalKind = (): "timeout" | "aborted" =>
		externalSignal?.reason instanceof FetchError && externalSignal.reason.kind === "timeout" ? "timeout" : "aborted";
	const abort = (kind: "timeout" | "aborted"): void => {
		if (abortError !== undefined) return;
		abortError = makeError(kind);
		controller.abort(abortError);
	};
	const onExternalAbort = (): void => abort(externalKind());
	const check = (): void => {
		if (externalSignal?.aborted === true) abort(externalKind());
		else if (abortError === undefined && performance.now() >= absoluteDeadline) abort("timeout");
		if (abortError !== undefined) throw abortError;
	};
	const armTimer = (): void => {
		if (disposed || abortError !== undefined) return;
		const remaining = absoluteDeadline - performance.now();
		if (remaining <= 0) {
			abort("timeout");
			return;
		}
		timer = setTimeout(() => {
			timer = undefined;
			armTimer();
		}, Math.min(MAX_TIMER_DELAY, remaining));
	};

	if (externalSignal?.aborted === true) abort(externalKind());
	else {
		externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		armTimer();
	}

	return {
		signal: controller.signal,
		deadlineMs: absoluteDeadline,
		check,
		run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
			try {
				check();
			} catch (error) {
				return Promise.reject(error);
			}
			return new Promise<T>((resolve, reject) => {
				let settled = false;
				const cleanup = (): void => {
					controller.signal.removeEventListener("abort", onAbort);
				};
				const finish = (callback: () => void): void => {
					if (settled) return;
					settled = true;
					cleanup();
					callback();
				};
				const onAbort = (): void => finish(() => reject(abortError ?? makeError("aborted")));
				controller.signal.addEventListener("abort", onAbort, { once: true });
				try {
					check();
					const pending = operation();
					Promise.resolve(pending).then(
						(value) => {
							try {
								check();
								finish(() => resolve(value));
							} catch (error) {
								finish(() => reject(error));
							}
						},
						(error: unknown) => {
							try {
								check();
								finish(() => reject(error));
							} catch (abortReason) {
								finish(() => reject(abortReason));
							}
						},
					);
				} catch (error) {
					finish(() => reject(error));
				}
			});
		},
		dispose(): void {
			disposed = true;
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
			externalSignal?.removeEventListener("abort", onExternalAbort);
		},
	};
}
