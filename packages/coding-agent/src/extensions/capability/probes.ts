/**
 * The single-request probes: speed, tool calls, instruction following, and retrieval.
 *
 * Each probe sends fixed requests and checks the replies in code, so the model never grades
 * itself. The multi-step probe, which needs an agent loop, is in multistep.ts.
 */

import { type Context, type Tool, Type, validateToolArguments } from "@earendil-works/pi-ai";
import { ask, type ProbeClient, replyError } from "./client.ts";

/** Measured speed; undefined values mean the model streamed nothing to measure. */
export interface SpeedResult {
	firstTokenMs: number | undefined;
	tokensPerSecond: number | undefined;
}

/** Cases passed out of cases run, with one note per failed case. */
export interface ScoreResult {
	passed: number;
	total: number;
	notes: string[];
}

const TIMEOUT_MS = 60_000;

/** Time to first token and output speed for a short, predictable answer. */
export async function probeSpeed(client: ProbeClient): Promise<SpeedResult & { error: string | undefined }> {
	const reply = await ask(
		client,
		userOnly("Count from 1 to 60. Write the numbers separated by single spaces and nothing else."),
		TIMEOUT_MS,
	);
	const error = replyError(reply);
	if (error || reply.firstTokenMs === undefined) {
		return { firstTokenMs: undefined, tokensPerSecond: undefined, error: error ?? "the model sent no answer" };
	}
	const streamingSeconds = (reply.totalMs - reply.firstTokenMs) / 1000;
	return {
		firstTokenMs: reply.firstTokenMs,
		// A reply that arrives in one chunk has no streaming time to divide by.
		tokensPerSecond: streamingSeconds > 0.05 ? reply.outputTokens / streamingSeconds : undefined,
		error: undefined,
	};
}

const TOOLS: Tool[] = [
	{
		name: "convert_units",
		description: "Convert a value from one unit to another.",
		parameters: Type.Object({ value: Type.Number(), from: Type.String(), to: Type.String() }),
	},
	{
		name: "read_file",
		description: "Read a file and return its contents.",
		parameters: Type.Object({ path: Type.String() }),
	},
	{
		name: "plot",
		description: "Plot one column of the loaded table against another.",
		parameters: Type.Object({ x_column: Type.String(), y_column: Type.String(), title: Type.String() }),
	},
];

interface ToolCase {
	prompt: string;
	tool: string;
	check(args: Record<string, unknown>): boolean;
}

const lower = (value: unknown) => String(value).toLowerCase();

const TOOL_CASES: ToolCase[] = [
	{
		prompt: "Convert 30 psi to kPa.",
		tool: "convert_units",
		check: (a) => a.value === 30 && lower(a.from).includes("psi") && lower(a.to).includes("kpa"),
	},
	{
		prompt: "Open the file data/run_07.csv.",
		tool: "read_file",
		check: (a) => String(a.path).replace(/^\.\//, "") === "data/run_07.csv",
	},
	{
		prompt: "Plot temperature against time, titled 'Run 7'.",
		tool: "plot",
		check: (a) =>
			lower(a.x_column).includes("time") && lower(a.y_column).includes("temp") && String(a.title).includes("Run 7"),
	},
];

/** Does the model call the right tool with valid, correct arguments for simple requests? */
export async function probeToolCalls(client: ProbeClient): Promise<ScoreResult> {
	const notes: string[] = [];
	for (const c of TOOL_CASES) {
		const reply = await ask(
			client,
			{
				systemPrompt: "You are a lab assistant. Use the tools to act on requests.",
				messages: [{ role: "user", content: c.prompt, timestamp: 0 }],
				tools: TOOLS,
			},
			TIMEOUT_MS,
		);
		const calls = reply.message.content.filter((p) => p.type === "toolCall");
		const call = calls[0];
		const failure =
			replyError(reply) ??
			(!call
				? "answered in text instead of calling a tool"
				: call.name !== c.tool
					? `called ${call.name} instead of ${c.tool}`
					: argumentsProblem(call, c));
		if (failure) notes.push(`"${c.prompt}": ${failure}`);
	}
	return { passed: TOOL_CASES.length - notes.length, total: TOOL_CASES.length, notes };
}

function argumentsProblem(call: Parameters<typeof validateToolArguments>[1], c: ToolCase): string | undefined {
	try {
		const args = validateToolArguments(TOOLS.find((t) => t.name === c.tool)!, call) as Record<string, unknown>;
		return c.check(args) ? undefined : `wrong arguments ${JSON.stringify(call.arguments)}`;
	} catch {
		return `malformed arguments ${JSON.stringify(call.arguments)}`;
	}
}

interface FormatCase {
	prompt: string;
	/** Undefined when the reply follows the format. */
	check(text: string): string | undefined;
}

const FORMAT_CASES: FormatCase[] = [
	{
		prompt:
			'Reply with only a JSON object with the keys "sample_rate" (a number in Hz) and "channels" (a number), and nothing else. The logger recorded 2 channels at 48 kHz.',
		check: (text) => {
			const body = text.replace(/^```(?:json)?\s*|\s*```$/g, "");
			try {
				const value = JSON.parse(body) as Record<string, unknown>;
				return value.sample_rate === 48000 && value.channels === 2 ? undefined : `wrong values: ${body}`;
			} catch {
				return "not only a JSON object";
			}
		},
	},
	{
		prompt:
			'List three checks to do before a pressure test. Write exactly three lines, each starting with "- ", and nothing else.',
		check: (text) => {
			const lines = text.split("\n").filter((l) => l.trim() !== "");
			return lines.length === 3 && lines.every((l) => l.startsWith("- ")) ? undefined : `got ${lines.length} lines`;
		},
	},
	{
		prompt: "Answer with one word in capital letters, YES or NO: is 1 kPa more than 1 psi?",
		check: (text) => (/^NO\.?$/.test(text) ? undefined : `answered "${text.slice(0, 40)}"`),
	},
];

/** Does the model obey a required output format? */
export async function probeInstructions(client: ProbeClient): Promise<ScoreResult> {
	const notes: string[] = [];
	for (const c of FORMAT_CASES) {
		const reply = await ask(client, userOnly(c.prompt), TIMEOUT_MS);
		const failure = replyError(reply) ?? c.check(reply.text);
		if (failure) notes.push(`format ${FORMAT_CASES.indexOf(c) + 1}: ${failure}`);
	}
	return { passed: FORMAT_CASES.length - notes.length, total: FORMAT_CASES.length, notes };
}

/** Retrieval result with the size of the text the facts were hidden in. */
export interface RetrievalResult extends ScoreResult {
	approxTokens: number;
}

// Large enough to need real long-context reading, small enough to stay near a minute on a laptop.
const MAX_HAYSTACK_TOKENS = 8000;

/** Can the model find two facts placed in a long lab log full of similar facts? */
export async function probeRetrieval(client: ProbeClient, contextWindow: number): Promise<RetrievalResult> {
	const approxTokens = Math.min(MAX_HAYSTACK_TOKENS, Math.floor(contextWindow / 2));
	const reply = await ask(
		client,
		userOnly(
			`${buildHaystack(approxTokens)}\n\nUsing only the log above, answer two questions, one per line:\n1. What is the calibration code for sensor B7?\n2. In which cabinet is the spare pressure gauge stored?`,
		),
		TIMEOUT_MS * 2,
	);
	const error = replyError(reply);
	const notes: string[] = [];
	if (error) notes.push(error);
	else {
		if (!reply.text.includes("4197")) notes.push("did not find the calibration code for B7");
		if (!/\b41\b/.test(reply.text)) notes.push("did not find the cabinet of the spare gauge");
	}
	return { passed: error ? 0 : 2 - notes.length, total: 2, notes, approxTokens };
}

/**
 * A deterministic lab log of about `approxTokens` tokens (4 characters each), with distractors
 * that look like the two facts, and the facts at 35% and 80% of the way through.
 */
export function buildHaystack(approxTokens: number): string {
	let seed = 7;
	const next = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648;
		return seed;
	};
	const sensors = ["A1", "A4", "B2", "B3", "B9", "C5", "D7"];
	const lines: string[] = [];
	let chars = 0;
	for (let i = 0; chars < approxTokens * 4; i++) {
		const sensor = sensors[next() % sensors.length];
		const line =
			i % 5 === 0
				? `Day ${i}: calibration code for sensor ${sensor} is ${distractorCode(next())}.`
				: i % 7 === 0
					? `Day ${i}: the backup thermometer was moved to cabinet ${10 + (next() % 30)}.`
					: `Day ${i}: run ${100 + i} at ${(20 + (next() % 150) / 10).toFixed(1)} C, pressure ${(next() % 900) / 10} kPa, sensor ${sensor} nominal.`;
		lines.push(line);
		chars += line.length + 1;
	}
	lines.splice(Math.floor(lines.length * 0.35), 0, "Note: the calibration code for sensor B7 is 4197.");
	lines.splice(Math.floor(lines.length * 0.8), 0, "Note: the spare pressure gauge is stored in cabinet 41.");
	return lines.join("\n");
}

// Distractor codes never equal the real one, so finding 4197 means finding the right line.
function distractorCode(random: number): number {
	const code = 1000 + (random % 8999);
	return code === 4197 ? 4198 : code;
}

function userOnly(text: string): Context {
	return { messages: [{ role: "user", content: text, timestamp: 0 }] };
}
