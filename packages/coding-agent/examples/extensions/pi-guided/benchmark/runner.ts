/**
 * Run one benchmark task as its own pi session, in its own folder.
 *
 * The session (shared/isolated-session.ts) has pi's system prompt and pi's tools rooted at the run's
 * folder, limited by the task's careful level exactly as in a normal session: the careful levels'
 * tool list, prompt section, and approval question. It never touches the user's conversation.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { askApproval } from "../careful/approval.ts";
import { findMentions, readMentions } from "../careful/attach.ts";
import { allowedTools, decideForLevel, promptSection } from "../careful/levels.ts";
import { runIsolated } from "../shared/isolated-session.ts";
import type { LadderTask } from "./ladder.ts";

export interface RunnerDeps {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Asks level 3 approvals. Undefined without a UI, which blocks every change at level 3. */
	ui: Pick<ExtensionUIContext, "select" | "input"> | undefined;
	/** Called after every tool call starts, for a progress display. */
	onProgress?(progress: RunProgress): void;
	signal?: AbortSignal;
	/** Where models.json and logins are read from. Defaults to pi's agent directory. */
	agentDir?: string;
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
	const allowed = allowedTools(task.level);
	const section = promptSection(task.level);
	const prompt = await buildPrompt(task, dir);
	// Parallel tool calls ask one question at a time.
	let queue: Promise<unknown> = Promise.resolve();
	const result = await runIsolated({
		dir,
		model: deps.model,
		thinkingLevel: deps.thinkingLevel,
		tools: RUN_TOOLS.filter((name) => !allowed || allowed.includes(name)),
		prompt: prompt.text,
		images: prompt.images,
		section: section ? { tag: "careful", text: section } : undefined,
		gate: async (toolName, input) => {
			const decision = decideForLevel(task.level, toolName);
			if (decision.action === "allow") return undefined;
			if (decision.action === "block") return { block: true, reason: decision.reason };
			const asked = queue.then(() => askApproval(toolName, input, dir, deps.ui, deps.signal));
			queue = asked.catch(() => undefined);
			return asked;
		},
		maxTurns: MAX_TURNS,
		timeoutMs: TIMEOUT_MS,
		signal: deps.signal,
		onStep: (lastStep, toolCalls) => deps.onProgress?.({ toolCalls, lastStep }),
		agentDir: deps.agentDir,
	});
	return {
		answer: result.answer,
		toolCalls: result.calls.length,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		durationMs: result.durationMs,
		error: result.stopped ?? result.providerError,
	};
}

/** The task's prompt; at level 1 the task's files are attached, since the agent has no tools to open them. */
async function buildPrompt(task: LadderTask, dir: string): Promise<{ text: string; images: ImageContent[] }> {
	if (task.level !== 1) return { text: task.prompt, images: [] };
	const paths = [...new Set([...findMentions(task.prompt), ...task.files])];
	const attached = await readMentions(paths, dir);
	return { text: attached.text ? `${task.prompt}\n\n${attached.text}` : task.prompt, images: attached.images };
}
