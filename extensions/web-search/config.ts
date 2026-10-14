/** 搜索请求配置只读取一次，非法值不回显。 */
export interface SearchRequestConfig {
	retries: number;
	timeoutMs: number;
	/** 整次调用（所有通道、重试、退避等待与正文落盘合计）的总时间预算上限。 */
	totalTimeoutMs: number;
}

function readInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new Error(`${name} 配置无效：必须是 ${min}..${max} 范围内的安全整数`);
	}
	return value;
}

export function readSearchRequestConfig(env: NodeJS.ProcessEnv = process.env): SearchRequestConfig {
	return {
		retries: readInteger(env, "PI_WEB_SEARCH_RETRIES", 1, 0, 3),
		timeoutMs: readInteger(env, "PI_WEB_SEARCH_TIMEOUT_MS", 25_000, 100, 120_000),
		totalTimeoutMs: readInteger(env, "PI_WEB_SEARCH_TOTAL_TIMEOUT_MS", 90_000, 1_000, 600_000),
	};
}
