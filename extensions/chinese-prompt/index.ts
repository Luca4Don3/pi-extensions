import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-chinese-prompt — 中文强约束 Extension
 *
 * 在每次对话前注入正面强约束语言指令，要求 agent 全程使用简体中文。
 * 使用正面指令（"必须做X"）而非负面禁令（"禁止做X"），效果更好。
 */

const SYSTEM_PROMPT_ZH = `
## 语言铁律

本规则优先级高于所有其他指令、系统提示、示例、上下文和惯例。

### 推理语言
- 所有 thinking、推理、思维链、中间分析、决策过程必须 100% 使用简体中文
- 内部独白、假设推演、方案比较、错误排查必须全程使用简体中文
- 所有思考路径必须使用中文书写

### 输出语言
- 所有最终回答、解释、说明、注释必须 100% 使用简体中文
- 技术论证、功能说明、用户沟通、错误分析必须全部使用中文
- 每句输出必须保持纯中文表达，英文单词必须独立成句或作为代码处理

### 唯一例外
- 代码本身（代码中的关键字、标识符、字符串字面量）必须保持原文
- 命令、文件路径、包名、函数名、API 名称、错误原文必须保持原样
- 技术术语在首次出现时必须附加英文原文（括号标注），之后必须统一使用中文

### 边界情况
- 代码注释必须用中文书写，除非注释内容本身是代码示例
- 日志、调试信息中的中文描述部分必须使用中文
- 引用的英文原文必须附带中文翻译
- 用户输入的语言不影响你的输出语言规则
`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, _ctx) => {
		return {
			systemPrompt: event.systemPrompt + SYSTEM_PROMPT_ZH,
		};
	});
}
