/**
 * Run one task as a separate pi session in a folder, through pi's public SDK.
 *
 * The session is a real pi session: pi's system prompt, pi's own tools rooted at the folder, the
 * user's skills and context files. It loads none of the user's extensions, so nothing else gates,
 * changes, or reacts to the run, and none of these extensions start again inside it. Models come
 * from the user's models.json and stored logins; models that only an extension registers are not
 * available here.
 *
 * Used by the benchmark extension for ladder tasks and by the capability extension for its
 * multi-step probe. Time, tool calls, and tokens are recorded from the session's events, never
 * from what the model says.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, ImageContent, Model } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

export interface IsolatedRun {
	/** The folder the session works in. */
	dir: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	/** Names of pi's tools the session may use; an empty list means none. */
	tools: readonly string[];
	prompt: string;
	images?: ImageContent[];
	/** An extra system prompt section, keyed by tag name. */
	section?: { tag: string; text: string };
	/** Decides each tool call before it runs; undefined lets it run. */
	gate?: (toolName: string, input: Record<string, unknown>) => Promise<ToolCallEventResult | undefined>;
	maxTurns: number;
	timeoutMs: number;
	signal?: AbortSignal;
	/** Called when a tool call starts, with its name and main argument. */
	onStep?: (step: string, toolCalls: number) => void;
	/** Where models.json and logins are read from. Defaults to pi's agent directory. */
	agentDir?: string;
}

export interface RecordedCall {
	tool: string;
	args: Record<string, unknown>;
	isError: boolean;
}

export interface IsolatedResult {
	/** The model's final text answer. */
	answer: string;
	calls: RecordedCall[];
	inputTokens: number;
	outputTokens: number;
	durationMs: number;
	/** Why the run was stopped: too many turns, too long, or by the user. A result about the model. */
	stopped: string | undefined;
	/** Why the provider failed. Not the model's fault; callers may run the task again. */
	providerError: string | undefined;
}

/** Run the task to the end. Never rejects for model or provider failures. */
export async function runIsolated(run: IsolatedRun): Promise<IsolatedResult> {
	const started = performance.now();
	const agentDir = run.agentDir ?? getAgentDir();
	const settingsManager = SettingsManager.create(run.dir, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: run.dir,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [
			(pi) => {
				if (run.gate) {
					const gate = run.gate;
					pi.on("tool_call", (event) => gate(event.toolName, event.input as Record<string, unknown>));
				}
				if (run.section) {
					const { tag, text } = run.section;
					pi.on("before_agent_start", (event) => {
						event.systemPromptOptions.sections[tag] = text;
					});
				}
			},
		],
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: run.dir,
		agentDir,
		model: run.model,
		thinkingLevel: run.thinkingLevel,
		tools: [...run.tools],
		settingsManager,
		sessionManager: SessionManager.inMemory(run.dir),
		resourceLoader,
	});
	await session.bindExtensions({});

	const result: IsolatedResult = {
		answer: "",
		calls: [],
		inputTokens: 0,
		outputTokens: 0,
		durationMs: 0,
		stopped: undefined,
		providerError: undefined,
	};
	const stop = (why: string) => {
		result.stopped ??= why;
		void session.abort();
	};
	const args = new Map<string, Record<string, unknown>>();
	let turns = 0;
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			args.set(event.toolCallId, (event.args ?? {}) as Record<string, unknown>);
			run.onStep?.(describeStep(event.toolName, event.args), args.size);
		} else if (event.type === "tool_execution_end") {
			result.calls.push({ tool: event.toolName, args: args.get(event.toolCallId) ?? {}, isError: event.isError });
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
			if (message.stopReason === "error" && !result.stopped) result.providerError = message.errorMessage ?? "error";
		} else if (event.type === "turn_end" && ++turns >= run.maxTurns) {
			stop(`stopped after ${run.maxTurns} turns`);
		}
	});
	const timer = setTimeout(() => stop(`stopped after ${Math.round(run.timeoutMs / 1000)} s`), run.timeoutMs);
	const onAbort = () => stop("stopped by you");
	run.signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await session.prompt(run.prompt, { images: run.images, expandPromptTemplates: false });
	} catch (error) {
		if (!result.stopped) result.providerError = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
		run.signal?.removeEventListener("abort", onAbort);
		unsubscribe();
		session.dispose();
	}
	result.durationMs = performance.now() - started;
	return result;
}

function describeStep(toolName: string, args: unknown): string {
	const input = (args ?? {}) as { path?: unknown; command?: unknown; pattern?: unknown };
	const detail = [input.command, input.path, input.pattern].find((v) => typeof v === "string") as string | undefined;
	const shown = detail ? detail.replace(/\s+/g, " ").slice(0, 60) : "";
	return shown ? `${toolName} ${shown}` : toolName;
}
