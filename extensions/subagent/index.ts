/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";
import { type ResolvedModelConfig, resolveModelConfig, THINKING_LEVELS } from "./model-config.js";
import { waitForProcess } from "./process-lifecycle.js";
import { getFinalOutput } from "./message-output.js";
import { mapWithConcurrencyLimit } from "./concurrency.js";
import { LineBuffer, TailBuffer, MessageBuffer, ToolIdBuffer } from "./output-buffer.js";
import { describeSpawnFailure } from "./spawn-failure.js";
import {
	accumulateUsage,
	aggregateUsage,
	createUsageStats,
	formatUsageStats,
	type UsageStats,
} from "./usage.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const DEFAULT_MAX_OUTPUT_CHARS = 3000;
const DEFAULT_MAX_PREVIOUS_CHARS = 2400;

function compactText(text: string, maxChars = DEFAULT_MAX_OUTPUT_CHARS, label = "output"): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	if (maxChars <= 200) return normalized.slice(0, maxChars);
	const marker = `\n\n[${label} truncated: ${normalized.length - maxChars} chars omitted. Ask for full output only if necessary.]\n\n`;
	const head = Math.max(80, Math.floor((maxChars - marker.length) * 0.7));
	const tail = Math.max(40, maxChars - marker.length - head);
	return normalized.slice(0, head).trimEnd() + marker + normalized.slice(-tail).trimStart();
}

function buildSubagentOutputPolicy(maxOutputChars: number): string {
	return [
		"",
		"## Subagent output policy",
		`- Return a compact handoff summary. Target: ${maxOutputChars} characters for the main output. If more detail is needed, structure it clearly.`,
		"- Use bullets or compact JSON for clarity. Focus on: result, changed/relevant files, blockers, verification, and next action.",
		"- Cite file paths, symbols, and line ranges to describe code — keeps output compact and actionable.",
		"- When details are large, provide a short index and offer to supply full details on request.",
		"",
		"## 语言规则（最高优先级）",
		"- 所有思考和输出全部使用简体中文。代码、CLI 命令、文件路径、技术术语保持原样。",
		"- JSON 字段名（如 status/summary/changed）可用英文，字段值中的描述性文本使用中文。",
		"- 保持纯中文正文风格，中英混杂时立即回到中文。",
	].join("\n");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	outputTruncated?: boolean;
	messagesTruncated?: boolean;
	stderrTruncated?: boolean;
	toolIdsTruncated?: boolean;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	/** spawn 失败时的可行动诊断；正常退出时为空。 */
	spawnError?: string;
	step?: number;
	maxOutputChars?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function compactResultForDetails(result: SingleResult, maxChars: number): SingleResult {
	const output = compactText(getFinalOutput(result.messages), maxChars, "subagent output");
	return {
		...result,
		task: compactText(result.task, 800, "task"),
		stderr: compactText(result.stderr, 800, "stderr"),
		messages: output
			? [
					{
						role: "assistant",
						content: [{ type: "text", text: output }],
						model: result.model,
						stopReason: result.stopReason,
						errorMessage: result.errorMessage,
					} as Message,
				]
			: [],
	};
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	/** 本地定制：本任务的模型与思考等级，由调用前统一解析并校验。 */
	modelConfig: ResolvedModelConfig,
	maxOutputChars = DEFAULT_MAX_OUTPUT_CHARS,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: createUsageStats(),
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-skills", "--no-prompt-templates"];
	// 本地定制：模型与思考等级由调用前解析（含角色默认与主会话上限封顶）。
	args.push("--model", modelConfig.model, "--thinking", modelConfig.thinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: createUsageStats(),
		model: modelConfig.model,
		thinkingLevel: modelConfig.thinkingLevel,
		step,
		maxOutputChars,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			const output = compactText(getFinalOutput(currentResult.messages), maxOutputChars, "subagent output");
			onUpdate({
				content: [{ type: "text", text: output || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (signal?.aborted) throw new Error("Subagent was aborted");
		const boundedSystemPrompt = `${agent.systemPrompt.trim()}${buildSubagentOutputPolicy(DEFAULT_MAX_OUTPUT_CHARS)}`;
		if (boundedSystemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, boundedSystemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		if (signal?.aborted) throw new Error("Subagent was aborted");
		args.push(`Task: ${task}`);
		const exitCode = await new Promise<number>((resolve, reject) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const outputAbort = new AbortController();
			let outputFailed = false;
			let callbackFailed = false;
			let firstCallbackError: unknown;
			const guardOutput = (fn: () => void, cancel = true) => {
				if (callbackFailed) return;
				try {
					fn();
				} catch (error) {
					callbackFailed = true;
					firstCallbackError = error;
					if (cancel) outputAbort.abort();
				}
			};
			const seenToolCallIds = new ToolIdBuffer();
			const messages = new MessageBuffer(currentResult.messages);
			const stderr = new TailBuffer();
			const syncLimits = () => {
				currentResult.messagesTruncated = messages.truncated;
				currentResult.stderrTruncated = stderr.truncated;
				currentResult.toolIdsTruncated = seenToolCallIds.truncated;
				currentResult.stderr = stderr.text;
			};

			const failOutput = (diagnostic: string) => {
				if (outputFailed) return;
				outputFailed = true;
				currentResult.outputTruncated = true;
				currentResult.errorMessage = `${diagnostic}，已停止进程；输出及用量可能不完整`;
				syncLimits();
				outputAbort.abort();
			};
			const rememberToolId = (id: string) => {
				if (seenToolCallIds.add(id)) return true;
				failOutput("工具结果去重超过容量（1024 个标识或单标识 4096 字节）");
				return false;
			};

			const processLine = (line: string) => {
				if (callbackFailed || outputFailed || !line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					if (msg.role === "toolResult" && msg.toolCallId) {
						if (seenToolCallIds.has(msg.toolCallId)) return;
						if (!rememberToolId(msg.toolCallId)) return;
					}
					messages.push(msg);

					if (msg.role === "assistant") {
						accumulateUsage(currentResult.usage, msg.usage);
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					syncLimits();
					emitUpdate();
				}

				// 0.84.0+：工具结果已随 message_end（role=toolResult）逐条下发，
				// turn_end.toolResults 是权威汇总；此处仅补充遗漏项，用 toolCallId 去重，
				// 避免与 message_end 重复入列。
				if (event.type === "turn_end" && Array.isArray(event.toolResults) && event.toolResults.length > 0) {
					let added = false;
					for (const toolResult of event.toolResults) {
						if (
							toolResult.role === "toolResult" &&
							toolResult.toolCallId &&
							seenToolCallIds.has(toolResult.toolCallId)
						) {
							continue;
						}
						if (toolResult.toolCallId && !rememberToolId(toolResult.toolCallId)) return;
						messages.push(toolResult as Message);
						added = true;
					}
					syncLimits();
					if (added) emitUpdate();
				}
			};

			const lines = new LineBuffer(processLine, () => {
				failOutput("stdout 单行超过 1048576 字节");
			});
			proc.stdout.on("data", (data) => guardOutput(() => lines.write(data)));
			proc.stderr.on("data", (data) => guardOutput(() => {
				stderr.write(data);
				syncLimits();
			}));

			waitForProcess(proc, signal ? AbortSignal.any([signal, outputAbort.signal]) : outputAbort.signal, () => {
				// 关闭后的尾行回调同样保留首错，但无需再取消已关闭的进程。
				guardOutput(() => lines.end(), false);
				stderr.end();
				syncLimits();
			}, (diagnostic) => {
				if (diagnostic.includes("输出不完整")) currentResult.outputTruncated = true;
				currentResult.errorMessage = currentResult.errorMessage
					? `${currentResult.errorMessage}\n${diagnostic}` : diagnostic;
			}).then((code) => {
				if (callbackFailed) reject(firstCallbackError);
				else resolve(outputFailed ? 1 : code);
			}, (error) => {
				if (callbackFailed) reject(firstCallbackError);
				else if (outputFailed && !signal?.aborted) resolve(1);
				else reject(error);
			});

			// waitForProcess 已把 error 折算为退出码；这里只留下可行动的诊断，
					// 让「找不到 pi」不再退化成一句莫名的 exitCode 1。
			proc.on("error", (error: NodeJS.ErrnoException) => {
				if (currentResult.spawnError === undefined) {
					currentResult.spawnError = describeSpawnFailure(error, invocation.command);
				}
			});
		});

		currentResult.exitCode = exitCode;
		// 启动失败与被启动进程自身失败是两回事：前者必须给出可行动的诊断。
		if (currentResult.spawnError !== undefined) {
			throw new Error(`子 agent 进程启动失败：${currentResult.spawnError}`);
		}
		return currentResult;
	} catch (error) {
		currentResult.exitCode = 1;
		currentResult.stopReason = signal?.aborted ? "aborted" : "error";
		currentResult.errorMessage = signal?.aborted ? "子任务已取消" : "子任务执行异常，请检查启动配置与工作目录";
		currentResult.spawnError = undefined;
		try {
			emitUpdate();
		} catch {
			// 错误状态通知失败不能覆盖原始异常，包括 falsy 抛出值。
		}
		throw error;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskThinkingSchema = StringEnum(THINKING_LEVELS, {
	description: "按本任务难度选择思考等级，不得高于主会话；优先于调用级 thinking。省略时侦查默认为 low，其他角色为 medium，并按主会话上限封顶。",
});

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	thinking: Type.Optional(TaskThinkingSchema),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
	thinking: Type.Optional(TaskThinkingSchema),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

/**
 * 宿主授权用的环境变量名：只有宿主显式把它设为 true 时，
 * 才允许跳过项目级 agent 的确认。
 *
 * 该授权刻意不由工具参数提供：confirmProjectAgents 是模型可控输入，
 * 模型传 false 只表示“本次调用请求跳过确认”，本身不是可信授权。
 */
export const TRUST_PROJECT_AGENTS_ENV = "PI_SUBAGENT_TRUST_PROJECT_AGENTS";

/** 读取宿主授权；未设置视为未授权；非法值显式报错且不回显原值。 */
export function readTrustProjectAgents(env: Record<string, string | undefined> = process.env): boolean {
	const raw = env[TRUST_PROJECT_AGENTS_ENV];
	if (raw === undefined) return false;
	const value = raw.trim();
	if (value !== "true" && value !== "false") {
		throw new Error(`${TRUST_PROJECT_AGENTS_ENV} 必须为 true 或 false`);
	}
	return value === "true";
}

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({
			description:
				"Request to skip the project-agent confirmation for this call. Default: true. " +
				"This is model-controlled input, not a trusted authorization: the skip only takes effect when the host sets PI_SUBAGENT_TRUST_PROJECT_AGENTS=true.",
			default: true,
		}),
	),
	maxOutputChars: Type.Optional(
		Type.Number({ description: "Max characters returned to the main agent. Default: 800.", default: 800 }),
	),
	maxPreviousChars: Type.Optional(
		Type.Number({ description: "Max characters passed between chain steps. Default: 1200.", default: 1200 }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
	model: Type.Optional(
		Type.String({
			minLength: 1,
			description:
				"覆盖本次调用的模型（适用于所有执行模式）；省略时继承主会话当前模型。接受 provider/id，可带 :thinking 后缀，后缀等级受主会话上限封顶。",
		}),
	),
	thinking: Type.Optional(TaskThinkingSchema),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate one self-contained task to a specialized subagent that runs with its own context window.",
			"",
			"Use it when the raw output would flood your context and you will not need the details later (repo-wide recon, long command output, multi-file search), when several genuinely independent investigations can run at once, or when you want a focused review/plan pass.",
			"Do it yourself when the change is local to a file you already know, the answer is already in your context, the step needs the user's confirmation, or delegation would just add a round trip.",
			"",
			"Cost: each call spawns a separate pi process that cannot see your conversation, so the task must be self-contained; the reply is a compressed summary and startup adds latency.",
			"",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (~/.pi/agent/agents). Set agentScope: "both" or "project" to include project-local agents.',
			"Project-local agents require confirmation unless the host authorizes skipping it with PI_SUBAGENT_TRUST_PROJECT_AGENTS=true; the confirmProjectAgents parameter is model-controlled and never grants that trust.",
		].join("\n"),
		promptSnippet:
			"Delegate a self-contained task to an isolated subagent (scout / planner / coder / reviewer) when raw output would flood your context",
		promptGuidelines: [
			"Decide per task rather than defaulting to delegation: delegate self-contained work whose raw output you would not reuse; do the work directly when it is a small edit at a known location, a single command, or something already answered in your context.",
			"Never delegate before understanding the problem — survey just enough yourself to write a self-contained task, then hand off the expensive part.",
			"Each subagent cannot see your conversation: the task must carry all needed context, and its reply is a compressed summary, so ask for the details you will actually need.",
			"Do not delegate trivial edits, steps that need the user's confirmation, or work whose answer is already in your context — that only adds a round trip.",
			"Use parallel mode only for genuinely independent tasks that share neither files nor ordering; otherwise run them one at a time.",
			"Use chain mode only when each step consumes the previous step's output on the same target (e.g. scout → planner → coder). Do not run a chain as a ritual for routine changes.",
			"If a subagent returns an unclear or insufficient summary, re-run it with a narrower task instead of guessing from the summary.",
			"Subagents run locally without SSH access; remote deployment and server operations belong in the main session.",
		],

		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;
			const requestedMaxOutputChars = params.maxOutputChars;
			const requestedMaxPreviousChars = params.maxPreviousChars;
			const maxOutputChars = Math.max(
				200,
				Math.min(12000, Math.floor(requestedMaxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS)),
			);
			const maxPreviousChars = Math.max(
				400,
				Math.min(16000, Math.floor(requestedMaxPreviousChars ?? DEFAULT_MAX_PREVIOUS_CHARS)),
			);
			const getAgentOutputLimit = (agentName: string) => {
				const configured = agents.find((a) => a.name === agentName)?.maxOutputChars;
				return Math.max(200, Math.min(12000, Math.floor(requestedMaxOutputChars ?? configured ?? maxOutputChars)));
			};
			const getResultOutputLimit = (result: SingleResult) =>
				Math.max(200, Math.min(12000, Math.floor(requestedMaxOutputChars ?? result.maxOutputChars ?? maxOutputChars)));
			const getAgentPreviousLimit = (agentName: string) => {
				const configured = agents.find((a) => a.name === agentName)?.maxPreviousChars;
				return Math.max(400, Math.min(16000, Math.floor(requestedMaxPreviousChars ?? configured ?? maxPreviousChars)));
			};

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					// Keep only compact summaries in tool details too. The main agent should not receive
					// or persist full subagent transcripts unless a separate explicit workflow is added.
					results: results.map((r) => compactResultForDetails(r, getResultOutputLimit(r))),
				});

			// 信任边界：环境配置非法在使用前显式失败，不回显原值。
			let hostTrustsProjectAgents = false;
			try {
				hostTrustsProjectAgents = readTrustProjectAgents(process.env);
			} catch (error) {
				return {
					content: [{ type: "text", text: `配置错误：${(error as Error).message}` }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			// 本地定制：启动前统一解析每个任务的模型与思考等级（含角色默认、
			// 主会话上限封顶与 :thinking 后缀），任一端越界都在启动子进程前失败，
			// 避免链式执行到一半才发现等级不可用。
			let modelConfigs: ResolvedModelConfig[];
			try {
				const parentModelConfig = {
					model: ctx.model,
					thinkingLevel: ctx.thinkingLevel ?? pi.getThinkingLevel(),
				};
				const resolveTaskConfig = (agent: string, thinking?: ThinkingLevel) =>
					resolveModelConfig(parentModelConfig, { model: params.model, thinking: thinking ?? params.thinking }, agent);
				modelConfigs = hasChain
					? params.chain!.map((step) => resolveTaskConfig(step.agent, step.thinking))
					: hasTasks
						? params.tasks!.map((task) => resolveTaskConfig(task.agent, task.thinking))
						: [resolveTaskConfig(params.agent ?? "")];
			} catch (error) {
				return {
					content: [{ type: "text", text: (error as Error).message }],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// confirmProjectAgents:false 只是模型请求跳过确认；只有宿主显式授权才真正跳过。
			// 未设置或 false 一律按需确认：有 UI 询问，无 UI 拒绝，不静默放行。
			const maySkipProjectConfirm = confirmProjectAgents === false && hostTrustsProjectAgents;
			if ((agentScope === "project" || agentScope === "both") && !maySkipProjectConfirm) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					if (!ctx.hasUI) return {
						content: [{ type: "text", text: "拒绝执行：项目 agent 需要确认，但当前没有可用 UI。" }],
						details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						isError: true,
					};
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							isError: true,
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const stepOutputLimit = getAgentOutputLimit(step.agent);
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						step.agent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						modelConfigs[i],
						stepOutputLimit,
					);
					results.push(result);

					const isError =
						result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(无输出)";
						const compactErrorMsg = compactText(errorMsg, getResultOutputLimit(result), "error output");
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${compactErrorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = compactText(getFinalOutput(result.messages), getAgentPreviousLimit(step.agent), "previous step output");
				}
				const lastResult = results[results.length - 1];
				const finalOutput = compactText(getFinalOutput(lastResult.messages), getResultOutputLimit(lastResult), "subagent output");
				return {
					content: [{ type: "text", text: finalOutput || "(无输出)" }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: params.tasks[i].agent,
						agentSource: "unknown",
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: createUsageStats(),
						maxOutputChars: getAgentOutputLimit(params.tasks[i].agent),
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				let results: SingleResult[];
				try {
					results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index, combinedSignal) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							combinedSignal,
							// 保留各子任务最新输出与用量，取消后也要更新最终状态。
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
							modelConfigs[index],
							getAgentOutputLimit(t.agent),
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					}, signal);
				} catch {
					for (const result of allResults) {
						if (result.exitCode !== -1) continue;
						result.exitCode = 1;
						result.stopReason = "aborted";
						result.errorMessage = "子任务未启动，调度已停止";
					}
					const details = makeDetails("parallel")(allResults);
					if (signal?.aborted) throw Object.assign(new Error("Subagent was aborted"), { details, usage: aggregateUsage(allResults) });
					return {
						content: [{ type: "text", text: "并行任务执行异常，已停止调度并等待运行中子任务取消；请检查启动配置与工作目录。" }],
						details,
						isError: true,
					};
				}

				// 普通非零结果不触发共享取消，但总体仍必须标记失败。
				const succeeded = (r: SingleResult) => r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted";
				const successCount = results.filter(succeeded).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${succeeded(r) ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.agent && params.task) {
				const result = await runSingleAgent(
					ctx.cwd,
					agents,
					params.agent,
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					modelConfigs[0],
					getAgentOutputLimit(params.agent),
				);
				const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
					const compactErrorMsg = compactText(errorMsg, getResultOutputLimit(result), "error output");
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${compactErrorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				const finalOutput = compactText(getFinalOutput(result.messages), getResultOutputLimit(result), "subagent output");
				return {
					content: [{ type: "text", text: finalOutput || "(no output)" }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `链式 (${args.chain.length} 步)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... 还有 ${args.chain.length - 3} 个`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `并行 (${args.tasks.length} 个任务)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... 还有 ${args.tasks.length - 3} 个`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(无输出)", 0, 0);
			}

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `前 ${skipped} 项已省略\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
					if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
					text += `\n${theme.fg("muted", "─── 任务 ───")}`;
					text += `\n${theme.fg("dim", r.task)}`;
					text += `\n${theme.fg("muted", "─── 工具调用 ───")}`;
					const toolCalls = displayItems.filter((i) => i.type === "toolCall");
					if (toolCalls.length === 0) {
						text += `\n${theme.fg("dim", "(none)")}`;
					} else {
						const maxShow = Math.min(toolCalls.length, 30);
						for (let i = 0; i < maxShow; i++) {
							const item = toolCalls[i];
							text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
						}
						if (toolCalls.length > maxShow) {
							text += `\n${theme.fg("muted", `... 还有 ${toolCalls.length - maxShow} 次调用`)}`;
						}
					}
					if (finalOutput) {
						text += `\n${theme.fg("muted", "─── 输出 ───")}`;
						const lines = finalOutput.trim().split("\n");
						const maxLines = 60;
						const showLines = lines.slice(0, maxLines);
						text += `\n${theme.fg("toolOutput", showLines.join("\n"))}`;
						if (lines.length > maxLines) {
							text += `\n${theme.fg("muted", `... 前 ${lines.length - maxLines} 行已省略`)}`;
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) text += `\n\n${theme.fg("dim", usageStr)}`;
					text += `\n${theme.fg("muted", "(Ctrl+O 折叠)")}`;
					return new Text(text, 0, 0);
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(无输出)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O 展开)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} 步`)}`;

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						text += `\n${theme.fg("muted", `\n─── Step ${r.step}: `) + theme.fg("accent", r.agent)} ${rIcon}`;
						text += `\n${theme.fg("muted", "任务: ")}${theme.fg("dim", r.task)}`;

						const toolCalls = displayItems.filter((i) => i.type === "toolCall");
						if (toolCalls.length > 0) {
							const maxShow = Math.min(toolCalls.length, 15);
							for (let i = 0; i < maxShow; i++) {
								const item = toolCalls[i];
								text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
							}
							if (toolCalls.length > maxShow) {
								text += `\n${theme.fg("muted", `... +${toolCalls.length - maxShow} 次`)}`;
							}
						}

						if (finalOutput) {
							const lines = finalOutput.trim().split("\n");
							const maxLines = 30;
							if (lines.length > maxLines) {
								text += `\n${theme.fg("muted", `... ${lines.length - maxLines} 行已省略`)}`;
							}
							const showLines = lines.slice(-maxLines);
							text += `\n${theme.fg("toolOutput", showLines.join("\n"))}`;
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) text += `\n${theme.fg("dim", stepUsage)}`;
					}

					const totalUsage = formatUsageStats(aggregateUsage(details.results));
					if (totalUsage) text += `\n\n${theme.fg("dim", `总计: ${totalUsage}`)}`;
					text += `\n${theme.fg("muted", "(Ctrl+O 折叠)")}`;
					return new Text(text, 0, 0);
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} 步`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0) text += `\n${theme.fg("muted", "(无输出)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `总计: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O 展开)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted").length;
				const failCount = details.results.length - running - successCount;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} 完成, ${running} 运行中`
					: `${successCount}/${details.results.length} 个任务`;

				if (expanded && !isRunning) {
					let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						text += `\n${theme.fg("muted", `\n─── `) + theme.fg("accent", r.agent)} ${rIcon}`;
						text += `\n${theme.fg("muted", "任务: ")}${theme.fg("dim", r.task)}`;

						const toolCalls = displayItems.filter((i) => i.type === "toolCall");
						if (toolCalls.length > 0) {
							const maxShow = Math.min(toolCalls.length, 15);
							for (let i = 0; i < maxShow; i++) {
								const item = toolCalls[i];
								text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
							}
							if (toolCalls.length > maxShow) {
								text += `\n${theme.fg("muted", `... +${toolCalls.length - maxShow} 次`)}`;
							}
						}

						if (finalOutput) {
							const lines = finalOutput.trim().split("\n");
							const maxLines = 30;
							if (lines.length > maxLines) {
								text += `\n${theme.fg("muted", `... ${lines.length - maxLines} 行已省略`)}`;
							}
							const showLines = lines.slice(-maxLines);
							text += `\n${theme.fg("toolOutput", showLines.join("\n"))}`;
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) text += `\n${theme.fg("dim", taskUsage)}`;
					}

					const totalUsage = formatUsageStats(aggregateUsage(details.results));
					if (totalUsage) text += `\n\n${theme.fg("dim", `总计: ${totalUsage}`)}`;
					text += `\n${theme.fg("muted", "(Ctrl+O 折叠)")}`;
					return new Text(text, 0, 0);
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: r.exitCode === 0
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(运行中...)" : "(无输出)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `总计: ${usageStr}`)}`;
				}
				text += `\n${theme.fg("muted", "(Ctrl+O 展开)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(无输出)", 0, 0);
		},
	});
}
