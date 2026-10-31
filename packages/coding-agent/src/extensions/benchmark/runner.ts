/**
 * Run one benchmark task as its own agent, in its own folder.
 *
 * The agent gets pi's tools rooted at the run's folder, limited by the task's careful level exactly
 * as in a normal session (the careful extension's levels and approval question), and pi's system
 * prompt built from the user's own prompt inputs. It never touches the user's conversation.
 * Time, tool calls, and tokens are recorded from the agent's events, not from what it says.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, ToolDefinition } from "../../core/extensions/types.ts";
import { convertToLlm } from "../../core/messages.ts";
import type { ModelRegistry } from "../../core/model-registry.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../../core/system-prompt.ts";
import { createAllToolDefinitions } from "../../core/tools/index.ts";
import { wrapToolDefinitions } from "../../core/tools/tool-definition-wrapper.ts";
import { askApproval } from "../careful/approval.ts";
import { findMentions, readMentions } from "../careful/attach.ts";
import { allowedTools, decideForLevel, promptSection } from "../careful/levels.ts";
import type { LadderTask } from "./ladder.ts";

export interface RunnerDeps {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	registry: ModelRegistry;
	/** The user's system prompt inputs (context files, skills, custom prompt); cwd and tools are replaced. */
	promptOptions: BuildSystemPromptOptions;
	/** Asks level 3 approvals. Undefined without a UI, which blocks every change at level 3. */
	ui: Pick<ExtensionUIContext, "select" | "input"> | undefined;
	/** Called after every tool call and reply, for a progress display. */
	onProgress?(progress: RunProgress): void;
	signal?: AbortSignal;
}

export interface RunProgress {
	toolCalls: number;
	/** The last tool the agent called, with its main argument. */
	lastStep: string | undefined;
}

export interface RunResult {
	/** The agent's final text answer. */
	answer: string;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	/** Why the run stopped early, if it did. */
	error: string | undefined;
}

/** Tools for every level that allows tools; levels 1 and 2 narrow this list. */
const RUN_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

// Enough for a real multi-step task with a few mistakes; a model that loops is stopped here.
const MAX_TURNS = 40;
const TIMEOUT_MS = 15 * 60_000;

/** Run `task` in `dir` and measure it. Never rejects: failures come back in `error`. */
export async function runTask(task: LadderTask, dir: string, deps: RunnerDeps): Promise<RunResult> {
	const started = performance.now();
	const allowed = allowedTools(task.level);
	const all = createAllToolDefinitions(dir);
	const definitions: ToolDefinition[] = RUN_TOOLS.filter((name) => !allowed || allowed.includes(name)).map(
		(name) => all[name],
	);
	const section = promptSection(task.level);
	const agent = new Agent({
		streamFn: (model, context, options) => deps.registry.streamSimple(model, context, options),
		convertToLlm,
		initialState: {
			model: deps.model,
			thinkingLevel: deps.thinkingLevel,
			tools: wrapToolDefinitions(definitions),
			systemPrompt: buildSystemPrompt({
				...deps.promptOptions,
				cwd: dir,
				selectedTools: definitions.map((d) => d.name),
				toolSnippets: Object.fromEntries(definitions.map((d) => [d.name, d.promptSnippet ?? ""])),
				toolGuidelines: Object.fromEntries(definitions.map((d) => [d.name, d.promptGuidelines ?? []])),
				sections: { ...deps.promptOptions.sections, ...(section ? { careful: section } : {}) },
			}),
		},
		beforeToolCall: createGate(task, dir, deps),
	});

	const result: RunResult = {
		answer: "",
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		durationMs: 0,
		error: undefined,
	};
	let turns = 0;
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			result.toolCalls++;
			deps.onProgress?.({ toolCalls: result.toolCalls, lastStep: describeStep(event.toolName, event.args) });
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			const message = event.message as AssistantMessage;
			result.inputTokens += message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
			result.outputTokens += message.usage.output;
			const text = message.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("")
				.trim();
			if (text) result.answer = text;
		} else if (event.type === "turn_end" && ++turns >= MAX_TURNS) {
			result.error = `stopped after ${MAX_TURNS} turns`;
			agent.abort();
		}
	});
	const timer = setTimeout(() => {
		result.error = `stopped after ${TIMEOUT_MS / 60_000} minutes`;
		agent.abort();
	}, TIMEOUT_MS);
	const onAbort = () => {
		result.error = "stopped by you";
		agent.abort();
	};
	deps.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const prompt = await buildPrompt(task, dir);
		await agent.prompt(prompt.text, prompt.images);
		await agent.waitForIdle();
		result.error ??= agent.state.errorMessage;
	} catch (error) {
		result.error ??= error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		deps.signal?.removeEventListener("abort", onAbort);
	}
	result.durationMs = performance.now() - started;
	return result;
}

/** The careful level's caps, as the agent's tool-call hook. Questions are asked one at a time. */
function createGate(
	task: LadderTask,
	dir: string,
	deps: RunnerDeps,
): NonNullable<ConstructorParameters<typeof Agent>[0]["beforeToolCall"]> {
	let queue: Promise<unknown> = Promise.resolve();
	return async ({ toolCall, args }) => {
		const decision = decideForLevel(task.level, toolCall.name);
		if (decision.action === "allow") return undefined;
		if (decision.action === "block") return { block: true, reason: decision.reason };
		const run = queue.then(() =>
			askApproval(toolCall.name, args as Record<string, unknown>, dir, deps.ui, deps.signal),
		);
		queue = run.catch(() => undefined);
		return run;
	};
}

/** The task's prompt; at level 1 the task's files are attached, since the agent has no tools to open them. */
async function buildPrompt(task: LadderTask, dir: string): Promise<{ text: string; images: ImageContent[] }> {
	if (task.level !== 1) return { text: task.prompt, images: [] };
	const paths = [...new Set([...findMentions(task.prompt), ...task.files])];
	const attached = await readMentions(paths, dir);
	return { text: attached.text ? `${task.prompt}\n\n${attached.text}` : task.prompt, images: attached.images };
}

function describeStep(toolName: string, args: unknown): string {
	const input = (args ?? {}) as { path?: unknown; command?: unknown; pattern?: unknown };
	const detail = [input.command, input.path, input.pattern].find((v) => typeof v === "string") as string | undefined;
	const shown = detail ? detail.replace(/\s+/g, " ").slice(0, 60) : "";
	return shown ? `${toolName} ${shown}` : toolName;
}
