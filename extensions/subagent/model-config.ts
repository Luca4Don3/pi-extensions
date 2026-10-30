import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** 与宿主命令行支持的思考等级保持一致。 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ParentModelConfig {
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
}

export interface ModelOverrides {
	model?: string;
	thinking?: ThinkingLevel;
}

export interface ResolvedModelConfig {
	model: string;
	thinkingLevel: ThinkingLevel;
}

/** 主代理按任务指定等级，角色仅提供保守默认；主会话等级是不可突破的上限。 */
export function resolveModelConfig(
	parent: ParentModelConfig,
	overrides: ModelOverrides = {},
	agentName?: string,
): ResolvedModelConfig {
	const overrideModel = overrides.model?.trim();
	if (overrides.model !== undefined && !overrideModel) {
		throw new Error("单次覆盖的模型不能为空。");
	}

	const model = overrideModel ?? (parent.model ? `${parent.model.provider}/${parent.model.id}` : undefined);
	if (!model) {
		throw new Error("主会话没有可继承的模型，请先选择模型或明确指定本次调用的模型。");
	}

	const ceiling = THINKING_LEVELS.indexOf(parent.thinkingLevel);
	if (ceiling < 0) throw new Error("无法确认主会话的思考等级，拒绝启动子代理。");

	// 显式参数优先于模型后缀；两种入口都必须通过上限检查。
	const suffixLevel = overrideModel
		? THINKING_LEVELS.find((level) => overrideModel.endsWith(`:${level}`))
		: undefined;
	const requestedLevel = overrides.thinking ?? suffixLevel;
	if (requestedLevel !== undefined) {
		const requestedRank = THINKING_LEVELS.indexOf(requestedLevel);
		if (requestedRank < 0) throw new Error("不支持所请求的思考等级。");
		if (requestedRank > ceiling) {
			throw new Error(`子代理思考等级 ${requestedLevel} 超过主代理上限 ${parent.thinkingLevel}。`);
		}
		return { model, thinkingLevel: requestedLevel };
	}

	// 未按任务显式指定时，侦查使用低等级，其他角色使用中等等级，并按主代理上限封顶。
	const defaultLevel = agentName === "scout" ? "low" : "medium";
	const thinkingLevel = THINKING_LEVELS[Math.min(THINKING_LEVELS.indexOf(defaultLevel), ceiling)];
	return { model, thinkingLevel };
}
