/**
 * Benchmarks: ladders of tasks the user knows the answers to, run on a copy and graded by the user.
 *
 * `/bench` runs a ladder, builds a new one with pi's help, copies an example to edit, or compares
 * results across models, efforts, and careful levels. Each task runs as its own agent in a fresh
 * folder (runner.ts), so the user's files and conversation are never touched.
 *
 * Works on its own. Other extensions hear about finished runs on `benchmark:finished`, and the
 * expectations card asks for this extension's lines on `expectations:collect`.
 */

import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { EXPECTATIONS_COLLECT_EVENT, type ExpectationsCollectEvent } from "../capability/expectations.ts";
import { type CarefulLevel, LEVELS, levelLabel } from "../careful/levels.ts";
import { buildLadder } from "./builder.ts";
import { compareRuns, formatComparison } from "./compare.ts";
import { BENCHMARK_FINISHED_EVENT, type BenchmarkFinishedEvent } from "./events.ts";
import { type Ladder, parseLadder } from "./ladder.ts";
import { type LadderRunSummary, runLadder } from "./run-ladder.ts";
import {
	defaultBenchmarkDir,
	type LadderEntry,
	listLadders,
	loadRuns,
	PROJECT_LADDER_DIR,
	saveLadder,
} from "./store.ts";
import { summarizeForModel } from "./summary.ts";

export interface BenchmarkOptions {
	/** Where personal ladders and history live. Defaults to ~/.pi/agent/benchmark. */
	dir?: string;
}

const REPORT_ENTRY = "benchmark:report";

const ACTIONS = {
	run: "Run a ladder",
	new: "Make a new ladder from tasks you know the answers to",
	example: "Copy an example ladder to change",
	compare: "Compare results across models and settings",
} as const;

/** Register `/bench` and its report renderer. */
export function createBenchmarkExtension(pi: ExtensionAPI, options: BenchmarkOptions = {}): void {
	const dir = options.dir ?? defaultBenchmarkDir();

	pi.registerEntryRenderer(REPORT_ENTRY, (entry, _options, theme) => {
		const data = entry.data as { title: string; lines: string[] };
		return new Text(`${theme.bold(theme.fg("accent", data.title))}\n${data.lines.join("\n")}`, 1, 0);
	});

	pi.events.on(EXPECTATIONS_COLLECT_EVENT, (data) => {
		const event = data as ExpectationsCollectEvent;
		// Collectors add lines synchronously: the card reads them right after emitting.
		event.sections.push({ title: "Your benchmarks", lines: summarizeForModel(loadRuns(dir), event.model) });
	});

	pi.registerCommand("bench", {
		description: "Benchmarks: run tasks you know the answers to, grade them, and compare models and settings",
		getArgumentCompletions: (prefix) =>
			Object.keys(ACTIONS)
				.filter((a) => a.startsWith(prefix.trim()))
				.map((a) => ({ value: a, label: a })),
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/bench needs the interactive screen.", "warning");
				return;
			}
			// `/bench run example:lab-data` runs that ladder directly, as onboarding does.
			const [arg = "", ladderKey] = args.trim().split(/\s+/, 2);
			const action = Object.hasOwn(ACTIONS, arg) ? (arg as keyof typeof ACTIONS) : await pickAction(ctx);
			switch (action) {
				case "run":
					return run(ctx, ladderKey);
				case "new":
					return create(ctx);
				case "example":
					return copyExample(ctx);
				case "compare":
					return compare(ctx);
				case undefined:
					return;
			}
		},
	});

	/** Run a ladder. Every way out, including Escape and a missing model, ends with `benchmark:finished`. */
	async function run(ctx: ExtensionCommandContext, ladderKey: string | undefined): Promise<void> {
		const picked = await runPicked(ctx, ladderKey);
		const finished: BenchmarkFinishedEvent = picked
			? { ladderName: picked.entry.ladder.name, runs: picked.summary.runs, stopped: picked.summary.stopped }
			: { ladderName: "", runs: [], stopped: true };
		pi.events.emit(BENCHMARK_FINISHED_EVENT, finished);
	}

	async function runPicked(
		ctx: ExtensionCommandContext,
		ladderKey: string | undefined,
	): Promise<{ entry: LadderEntry; summary: LadderRunSummary } | undefined> {
		if (!ctx.model) {
			ctx.ui.notify("No model is connected. Use /login or /model first.", "warning");
			return undefined;
		}
		const entry = ladderKey
			? listLadders(dir, ctx.cwd).ladders.find((l) => l.key === ladderKey)
			: await pickLadder(ctx, "Which ladder?");
		if (!entry) {
			if (ladderKey) ctx.ui.notify(`No ladder ${ladderKey} here. Run /bench run to pick one.`, "warning");
			return undefined;
		}
		// A ladder named on the command line, as onboarding starts it, runs at its own levels without asking.
		const levels = ladderKey ? { levelOverride: undefined } : await pickLevels(ctx, entry);
		if (!levels) return undefined;
		const summary = await runLadder(entry, { levelOverride: levels.levelOverride, dir }, ctx);
		if (summary.runs.length > 0) report(entry, `Benchmark: ${entry.ladder.name}`);
		return { entry, summary };
	}

	/** Ask whether to run at the ladder's levels or one level for every task. Undefined when cancelled. */
	async function pickLevels(
		ctx: ExtensionCommandContext,
		entry: LadderEntry,
	): Promise<{ levelOverride: CarefulLevel | undefined } | undefined> {
		const about = entry.ladder.description ? `${entry.ladder.name}\n${entry.ladder.description}` : entry.ladder.name;
		const choice = await ctx.ui.select(
			[
				about,
				"",
				`Model: ${ctx.model?.provider}/${ctx.model?.id}, effort ${ctx.thinkingLevel}. Change them with /model and /thinking.`,
				"Each task runs on a copy of the files, never on your real files.",
			].join("\n"),
			[
				"Run each task at its own careful level",
				...LEVELS.map((l) => `Run every task at level ${levelLabel(l.level)}`),
			],
		);
		if (choice === undefined) return undefined;
		return { levelOverride: LEVELS.find((l) => choice.endsWith(levelLabel(l.level)))?.level };
	}

	async function create(ctx: ExtensionCommandContext): Promise<void> {
		const ladder = await buildLadder(ctx);
		if (!ladder) return;
		// The builder's answers pass the same checks as a ladder file from disk.
		const parsed = parseLadder(JSON.parse(JSON.stringify(ladder)));
		if (!parsed.ok) {
			ctx.ui.notify(`The ladder could not be saved: ${parsed.error}`, "error");
			return;
		}
		await save(ctx, parsed.ladder);
	}

	async function copyExample(ctx: ExtensionCommandContext): Promise<void> {
		const entry = await pickLadder(ctx, "Which example?", "example");
		if (entry) await save(ctx, { ...entry.ladder, name: entry.ladder.name.replace(/^Example: /, "") });
	}

	async function save(ctx: ExtensionCommandContext, ladder: Ladder): Promise<void> {
		const where = await ctx.ui.select("Who is this ladder for?", [
			"Just me",
			`My team: save it in this project folder (${PROJECT_LADDER_DIR})`,
		]);
		if (where === undefined) return;
		const folder = where === "Just me" ? join(dir, "ladders") : join(ctx.cwd, PROJECT_LADDER_DIR);
		const path = saveLadder(folder, ladder);
		ctx.ui.notify(`Saved ${ladder.name} to ${path}. Run it with /bench run; edit the file to change it.`, "info");
	}

	async function compare(ctx: ExtensionCommandContext): Promise<void> {
		const entry = await pickLadder(ctx, "Compare which ladder?");
		if (!entry) return;
		if (loadRuns(dir, entry.key).length === 0) {
			ctx.ui.notify(`${entry.ladder.name} has no graded runs yet. Run it with /bench run.`, "info");
			return;
		}
		report(entry, `Compare: ${entry.ladder.name}`);
	}

	/** Add the comparison for a ladder to the chat. It is shown to the user, never sent to the model. */
	function report(entry: LadderEntry, title: string): void {
		const comparison = compareRuns(loadRuns(dir, entry.key), entry.ladder.tasks);
		const hint = pi.getCommands().some((c) => c.name === "expectations")
			? ["", "Run /expectations to see what this means for the model."]
			: [];
		pi.appendEntry(REPORT_ENTRY, { title, lines: [...formatComparison(comparison), ...hint] });
	}

	async function pickLadder(
		ctx: ExtensionCommandContext,
		title: string,
		only?: LadderEntry["source"],
	): Promise<LadderEntry | undefined> {
		const { ladders, problems } = listLadders(dir, ctx.cwd);
		if (problems.length > 0) ctx.ui.notify(`Some ladders could not be read:\n${problems.join("\n")}`, "warning");
		const shown = ladders.filter((l) => only === undefined || l.source === only);
		const labels = shown.map((l) => `${l.ladder.name} (${l.source}, ${l.ladder.tasks.length} tasks)`);
		const choice = await ctx.ui.select(title, labels);
		return choice === undefined ? undefined : shown[labels.indexOf(choice)];
	}
}

async function pickAction(ctx: ExtensionCommandContext): Promise<keyof typeof ACTIONS | undefined> {
	const choice = await ctx.ui.select(
		"Benchmarks\n\nA benchmark is a short list of tasks you already know the answers to. Run it after changing the model, the effort, or the careful level, and you see what changed.",
		Object.values(ACTIONS),
	);
	return (Object.entries(ACTIONS) as [keyof typeof ACTIONS, string][]).find(([, label]) => label === choice)?.[0];
}

export default function benchmarkExtension(pi: ExtensionAPI): void {
	createBenchmarkExtension(pi);
}
