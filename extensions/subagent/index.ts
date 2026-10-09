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
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.js";

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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
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

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	maxOutputChars?: number;
}

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
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

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
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
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session", "--no-skills", "--no-prompt-templates"];
	if (agent.model) args.push("--model", agent.model);
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
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model,
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
		const boundedSystemPrompt = `${agent.systemPrompt.trim()}${buildSubagentOutputPolicy(DEFAULT_MAX_OUTPUT_CHARS)}`;
		if (boundedSystemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, boundedSystemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			const seenToolCallIds = new Set<string>();

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "toolResult" && msg.toolCallId) {
						seenToolCallIds.add(msg.toolCallId);
					}

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
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
						currentResult.messages.push(toolResult as Message);
						if (toolResult.toolCallId) seenToolCallIds.add(toolResult.toolCallId);
						added = true;
					}
					if (added) emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
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

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	maxOutputChars: Type.Optional(
		Type.Number({ description: "Max characters returned to the main agent. Default: 800.", default: 800 }),
	),
	maxPreviousChars: Type.Optional(
		Type.Number({ description: "Max characters passed between chain steps. Default: 1200.", default: 1200 }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
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

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentNames = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
				if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
				if (params.agent) requestedAgentNames.add(params.agent);

				const projectAgentsRequested = Array.from(requestedAgentNames)
					.map((name) => agents.find((a) => a.name === name))
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.name).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
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
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
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

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						t.agent,
						t.task,
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						getAgentOutputLimit(t.agent),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => r.exitCode === 0).length;
				const summaries = results.map((r) => {
					const output = getFinalOutput(r.messages);
					const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
					return `[${r.agent}] ${r.exitCode === 0 ? "completed" : "failed"}: ${preview || "(no output)"}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
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

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

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
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const failCount = details.results.filter((r) => r.exitCode > 0).length;
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
