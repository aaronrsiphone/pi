/**
 * The benchmark and expectations steps, and the "move up a level" suggestion after a benchmark.
 *
 * Onboarding does not run benchmarks itself: it starts the benchmark extension's `/bench` command
 * and waits for `benchmark:finished`, the way it waits for `/login`. Both steps are skipped when
 * the extension behind them is turned off.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BenchmarkFinishedEvent } from "../benchmark/events.ts";
import { type CarefulLevel, levelInfo, levelLabel } from "../careful/levels.ts";
import type { FlowEvent } from "./flow.ts";

/** The example ladder newcomers run first: lab data, four tasks with known answers. */
export const FIRST_LADDER = "example:lab-data";

const RUN_EXAMPLE = "Run the example ladder now (lab data, 4 short tasks)";
const MAKE_OWN = "Make my own ladder from tasks in my work";
const LATER = "Later: run /bench any time";

/** Offer the first benchmark. `run` starts `/bench` with the given arguments. */
export async function runBenchmarkStep(
	ctx: ExtensionContext,
	experienced: boolean,
	run: (args: string) => void,
): Promise<FlowEvent | undefined> {
	const intro = experienced
		? [
				"Benchmarks (optional)",
				"",
				"/bench runs tasks you know the answers to, on a copy of the files, and you grade them. Run it again after changing the model, effort, or careful level to compare.",
			]
		: [
				"Your first benchmark",
				"",
				"A benchmark is a short list of tasks you already know the answers to, from easy to harder.",
				"Pi runs each task on a copy of the files, never on your real files. You grade every answer: pass, partial, or fail.",
				"Pi never grades its own work. Run the same list again after changing the model or settings to see what changed.",
			];
	const choice = await ctx.ui.select(intro.join("\n"), [RUN_EXAMPLE, MAKE_OWN, LATER]);
	if (choice === undefined) return undefined;
	if (choice === LATER) return { type: "benchmark-done" };
	if (choice === MAKE_OWN) {
		run("new");
		// Building a ladder does not run it; setup goes on and the user runs it with /bench run.
		return { type: "benchmark-done" };
	}
	run(`run ${FIRST_LADDER}`);
	return { type: "benchmark-started" };
}

/** Shown when setup resumes while a benchmark it started has not reported back. */
export async function runWaitingForBenchmark(
	ctx: ExtensionContext,
	run: (args: string) => void,
): Promise<FlowEvent | undefined> {
	const choice = await ctx.ui.select("Setup is waiting for your first benchmark to finish.", [
		"Run the example ladder again",
		"Skip the benchmark for now",
	]);
	if (choice === undefined) return undefined;
	if (choice.startsWith("Skip")) return { type: "benchmark-done" };
	run(`run ${FIRST_LADDER}`);
	return { type: "benchmark-started" };
}

/** Show the expectations card. `show` runs `/expectations`. */
export function runExpectationsStep(ctx: ExtensionContext, show: () => void): FlowEvent {
	show();
	ctx.ui.notify("Above: what to expect from this model. Run /expectations any time to see it again.", "info");
	return { type: "saw-expectations" };
}

/**
 * After a benchmark: when every task at the current level passed, suggest the next level and a
 * harder task. Returns undefined when there is nothing to suggest.
 */
export function moveUpSuggestion(event: BenchmarkFinishedEvent, current: CarefulLevel | undefined): string | undefined {
	if (current === undefined || current === 4) return undefined;
	const atLevel = event.runs.filter((r) => r.level === current);
	if (atLevel.length === 0 || atLevel.some((r) => r.outcome !== "pass")) return undefined;
	const next = (current + 1) as CarefulLevel;
	return [
		`Every task at level ${levelLabel(current)} passed.`,
		`When you are ready, move up with /careful ${next} (${levelInfo(next).label}). ${levelInfo(next).summary}`,
		`Then try a harder task, for example: "${levelInfo(next).example}"`,
		next === 4 ? "Use level 4 only in folders you have a backup of." : "",
	]
		.filter(Boolean)
		.join("\n");
}
