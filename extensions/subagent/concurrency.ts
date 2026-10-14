export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number, signal: AbortSignal) => Promise<TOut>,
	signal?: AbortSignal,
): Promise<TOut[]> {
	const controller = new AbortController();
	let failed = false;
	let firstError: unknown;
	const fail = (error: unknown) => {
		if (failed) return;
		failed = true;
		firstError = error;
		controller.abort();
	};
	const abort = () => fail(new Error("Subagent was aborted"));
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	try {
		const limit = Math.max(1, Math.min(concurrency, items.length));
		const workers = Array.from({ length: items.length ? limit : 0 }, async () => {
			while (!failed) {
				const index = nextIndex++;
				if (index >= items.length) return;
				try {
					results[index] = await fn(items[index], index, controller.signal);
				} catch (error) {
					fail(error);
				}
			}
		});
		// 每个工作者自行接住异常，必须等待取消和资源清理完成再交付首错。
		await Promise.all(workers);
		if (failed) throw firstError;
		return results;
	} finally {
		signal?.removeEventListener("abort", abort);
	}
}
