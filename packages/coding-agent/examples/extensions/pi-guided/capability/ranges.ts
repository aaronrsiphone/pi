/**
 * Capability ranges: place measured probe results in plain-language tiers, an overall class, and
 * recommended settings. Pure, so a verdict depends only on the measurements.
 *
 * Boundaries and their sources are documented in docs/model-capability.md. In short: single tool
 * calls and format following are nearly solved for capable models, so they mainly flag weak
 * models; autonomous multi-step work separates the classes most. The internal mapping is roughly
 * chat-only and basic for small local models, capable for weaker Haiku-class models, strong for
 * Haiku-class and above: calibration on current small hosted models placed almost all of them in
 * strong. The suite cannot rank good models against each other; the user's own benchmark does that.
 */

import type { CarefulLevel } from "../careful/levels.ts";
import type { HardMeasurements } from "./hard-probes.ts";
import type { MultiStepResult } from "./multistep.ts";
import type { RetrievalResult, ScoreResult, SpeedResult } from "./probes.ts";

/** Bump when probes or boundaries change, so results from different suites are never compared. */
export const SUITE_VERSION = 3;

export interface Measurements {
	/** Declared by provider metadata or models.json; pi cannot tell a default from a real value. */
	contextWindow: number;
	speed: SpeedResult;
	tools: ScoreResult;
	instructions: ScoreResult;
	retrieval: RetrievalResult;
	multiStep: MultiStepResult;
	/** The harder tier; undefined when the model did not pass every basic probe, so it was not run. */
	hard: HardMeasurements | undefined;
}

export type Tier = "low" | "mid" | "high" | "unknown";

export interface Range {
	tier: Tier;
	/** Plain-language name of the tier, e.g. "Reliable". */
	label: string;
	/** The measurement behind it, e.g. "3 of 3". */
	detail: string;
}

export type Dimension =
	| "speed"
	| "context"
	| "tools"
	| "instructions"
	| "retrieval"
	| "multiStep"
	| "longRetrieval"
	| "bugFinding"
	| "reasoning";

export const DIMENSION_NAMES: Record<Dimension, string> = {
	speed: "Speed",
	context: "Context",
	tools: "Using tools",
	instructions: "Following instructions",
	retrieval: "Finding facts in long text",
	multiStep: "Small multi-step task",
	longRetrieval: "Facts in a very long text",
	bugFinding: "Finding a bug",
	reasoning: "An engineering calculation",
};

/** Dimensions measured for every model, in display order. */
export const BASIC_DIMENSIONS: readonly Dimension[] = [
	"speed",
	"context",
	"tools",
	"instructions",
	"retrieval",
	"multiStep",
];

/** Dimensions of the harder tier, measured only for models that pass every basic probe. */
export const HARD_DIMENSIONS: readonly Dimension[] = ["longRetrieval", "bugFinding", "reasoning"];

/** The dimensions worth showing for a placement: the harder tier only when it ran. */
export function shownDimensions(placement: Placement): Dimension[] {
	return placement.hardRun ? [...BASIC_DIMENSIONS, ...HARD_DIMENSIONS] : [...BASIC_DIMENSIONS];
}

export type ModelClass = "chat-only" | "basic" | "capable" | "strong" | "advanced";

export const CLASS_DESCRIPTIONS: Record<ModelClass, { label: string; summary: string }> = {
	"chat-only": {
		label: "Chat only",
		summary: "Good for questions about files you share. It does not use tools reliably.",
	},
	basic: { label: "Basic", summary: "Handles single, clear steps. Check its work closely." },
	capable: { label: "Capable", summary: "Handles small multi-step tasks. Check the results." },
	strong: {
		label: "Strong",
		summary: "Passed every basic check, but not all the harder ones. Check longer or trickier work closely.",
	},
	advanced: {
		label: "Advanced",
		summary:
			"Passed the basic and the harder checks: very long text, finding bugs, multi-part calculations. Your own benchmark shows how far that goes on your work.",
	},
};

export interface Recommendations {
	/**
	 * The highest careful level this model handles reliably: a ceiling, not a starting point. The
	 * level itself is the user's choice; newcomers start lower.
	 */
	highestLevel: CarefulLevel;
	/** Thinking effort to start with; undefined when the model has no adjustable reasoning. */
	effort: "low" | "medium" | undefined;
	taskSize: string;
	/** Where to double-check its work, most important first. */
	doubleCheck: string[];
}

export interface Placement {
	ranges: Record<Dimension, Range>;
	/** Whether the harder tier ran. */
	hardRun: boolean;
	modelClass: ModelClass;
	recommendations: Recommendations;
}

/** Place measurements in ranges and derive the class and recommendations. */
export function place(m: Measurements, reasoning: boolean): Placement {
	const ranges: Record<Dimension, Range> = {
		speed: speedRange(m.speed),
		context: contextRange(m.contextWindow),
		tools: scoreRange(m.tools),
		instructions: scoreRange(m.instructions),
		retrieval: {
			...scoreRange(m.retrieval),
			detail: `${m.retrieval.passed} of 2 in ~${kilo(m.retrieval.approxTokens)} tokens`,
		},
		multiStep: taskRange(m.multiStep),
		longRetrieval: m.hard?.longRetrieval
			? {
					...fractionRange(m.hard.longRetrieval),
					detail: `${m.hard.longRetrieval.passed} of 3 in ~${kilo(m.hard.longRetrieval.approxTokens)} tokens`,
				}
			: notRun(m.hard ? "the context window is too short" : ""),
		bugFinding: m.hard ? fractionRange(m.hard.bugFinding) : notRun(""),
		reasoning: m.hard ? fractionRange(m.hard.reasoning) : notRun(""),
	};
	const modelClass = classify(m, ranges);
	return {
		ranges,
		hardRun: m.hard !== undefined,
		modelClass,
		recommendations: recommend(m, ranges, modelClass, reasoning),
	};
}

/** Whether every basic probe passed, the condition for running the harder tier. */
export function passedBasics(m: Omit<Measurements, "hard" | "contextWindow" | "speed">): boolean {
	return [m.tools, m.instructions, m.retrieval, m.multiStep].every((s) => s.passed === s.total);
}

// Below ~12 tokens/s a reply arrives slower than people read; above ~40 it feels instant.
// Laptop llama.cpp runs of 8B models land around 40-80 tokens/s on recent Apple chips and far
// lower on CPU only; hosted Haiku-class models stream above 130 and Opus-class around 75.
const SLOW_TOKENS_PER_SECOND = 12;
const FAST_TOKENS_PER_SECOND = 40;
const SLOW_START_MS = 10_000;

function speedRange(speed: SpeedResult): Range {
	const start = speed.firstTokenMs === undefined ? "" : `first word after ${(speed.firstTokenMs / 1000).toFixed(1)} s`;
	if (speed.tokensPerSecond === undefined) return { tier: "unknown", label: "Not measured", detail: start };
	const rate = `${Math.round(speed.tokensPerSecond)} tokens/s`;
	const detail = start ? `${rate}, ${start}` : rate;
	const slowStart = (speed.firstTokenMs ?? 0) > SLOW_START_MS;
	if (speed.tokensPerSecond < SLOW_TOKENS_PER_SECOND) return { tier: "low", label: "Slow", detail };
	if (speed.tokensPerSecond < FAST_TOKENS_PER_SECOND || slowStart) return { tier: "mid", label: "Usable", detail };
	return { tier: "high", label: "Fast", detail };
}

// 32k tokens is roughly 60 pages; 128k holds several long files at once.
function contextRange(tokens: number): Range {
	const detail = `${kilo(tokens)} tokens, as configured`;
	if (tokens < 32_000) return { tier: "low", label: "Short: a few pages at a time", detail };
	if (tokens < 128_000) return { tier: "mid", label: "Medium: a few files at a time", detail };
	return { tier: "high", label: "Long: many files at once", detail };
}

function scoreRange(score: ScoreResult): Range {
	const detail = `${score.passed} of ${score.total}`;
	if (score.passed === score.total) return { tier: "high", label: "Reliable", detail };
	if (score.passed >= score.total - 1 && score.passed > 0) return { tier: "mid", label: "Usually", detail };
	return { tier: "low", label: "Unreliable", detail };
}

// Harder probes have more cases, so half right is "usually", not "unreliable".
function fractionRange(score: ScoreResult): Range {
	const detail = `${score.passed} of ${score.total}`;
	if (score.passed === score.total) return { tier: "high", label: "Reliable", detail };
	if (score.passed * 2 >= score.total) return { tier: "mid", label: "Usually", detail };
	return { tier: "low", label: "Unreliable", detail };
}

function notRun(detail: string): Range {
	return { tier: "unknown", label: "Not run", detail };
}

const TASK_LABELS: Record<Tier, string> = {
	high: "Done right",
	mid: "Partly done",
	low: "Not done",
	unknown: "Not run",
};

function taskRange(task: MultiStepResult): Range {
	const tier = scoreRange(task).tier;
	return { tier, label: TASK_LABELS[tier], detail: `${task.passed} of ${task.total} checks` };
}

function classify(m: Measurements, ranges: Record<Dimension, Range>): ModelClass {
	if (m.tools.passed <= 1) return "chat-only";
	if (passedBasics(m)) return isAdvanced(ranges) ? "advanced" : "strong";
	if (m.multiStep.passed >= 2 && m.tools.passed >= 2 && m.instructions.passed >= 2) return "capable";
	return "basic";
}

/** Advanced: no harder probe unreliable, and at most one only "usually" right. A skipped probe counts as "usually". */
function isAdvanced(ranges: Record<Dimension, Range>): boolean {
	const tiers = HARD_DIMENSIONS.map((d) => (ranges[d].tier === "unknown" ? "mid" : ranges[d].tier));
	return !tiers.includes("low") && tiers.filter((t) => t === "mid").length <= 1;
}

const LEVEL_FOR_CLASS: Record<ModelClass, CarefulLevel> = {
	"chat-only": 1,
	basic: 2,
	capable: 3,
	strong: 3,
	advanced: 3,
};

const TASK_SIZE: Record<ModelClass, string> = {
	"chat-only": "one question about the files you share",
	basic: "one file at a time",
	capable: "small multi-step tasks",
	strong: "multi-step tasks in one or two files",
	advanced: "larger changes across several files",
};

function recommend(
	m: Measurements,
	ranges: Record<Dimension, Range>,
	modelClass: ModelClass,
	reasoning: boolean,
): Recommendations {
	const doubleCheck = ["numbers, units, and calculations"];
	if (m.tools.passed < m.tools.total) doubleCheck.push("that it really opened the files it talks about");
	if (m.multiStep.passed < m.multiStep.total) doubleCheck.push("every file it changed");
	if (m.retrieval.passed < m.retrieval.total) doubleCheck.push("facts it quotes from long files");
	if (m.instructions.passed < m.instructions.total)
		doubleCheck.push("that tables and outputs have the format you asked for");
	if (ranges.context.tier === "low") doubleCheck.push("that it saw the whole of a long file");
	if (m.hard?.reasoning && m.hard.reasoning.passed < m.hard.reasoning.total)
		doubleCheck.push("every step of multi-part calculations");
	if (m.hard?.bugFinding && m.hard.bugFinding.passed < m.hard.bugFinding.total)
		doubleCheck.push("code it reviews: it can miss subtle bugs");
	if (m.hard?.longRetrieval && m.hard.longRetrieval.passed < m.hard.longRetrieval.total)
		doubleCheck.push("facts from very long files, and whether a later note replaced them");
	return {
		highestLevel: LEVEL_FOR_CLASS[modelClass],
		// More thinking makes a slow model much slower; start low there and raise it for hard tasks.
		effort: reasoning ? (ranges.speed.tier === "low" ? "low" : "medium") : undefined,
		taskSize: TASK_SIZE[modelClass],
		doubleCheck,
	};
}

function kilo(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}
