/**
 * Run a ladder: every task in a fresh copy, then the user grades each result.
 *
 * Per task: prepare the folder, run the agent with live progress (Escape stops the run), run the
 * automatic checks, and show the answer, the checks, and how the task is judged. The user picks
 * pass, partial, or fail; the model never grades. Every graded run goes into the user's history.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import type { CarefulLevel } from "../careful/levels.ts";
import { runChecks, snapshot } from "./checks.ts";
import { formatStats } from "./compare.ts";
import { kindLabel, type LadderTask } from "./ladder.ts";
import { type RunResult, runTask } from "./runner.ts";
import { appendRun, type CheckResult, type LadderEntry, type Outcome, type RunRecord } from "./store.ts";
import { prepareWorkspace } from "./workspace.ts";

export interface LadderRunOptions {
	/** Run every task at this level instead of the ladder's own levels. */
	levelOverride: CarefulLevel | undefined;
	/** Where history is saved. */
	dir: string;
	/** Where the runs read models.json and logins. Defaults to pi's agent directory. */
	agentDir?: string;
}

/** What happened to each task; `stopped` is true when the user left before the end. */
export interface LadderRunSummary {
	runs: RunRecord[];
	stopped: boolean;
}

const WIDGET_KEY = "benchmark";

/** Run the tasks of `entry` in order and record the graded runs. */
export async function runLadder(
	entry: LadderEntry,
	options: LadderRunOptions,
	ctx: ExtensionCommandContext,
): Promise<LadderRunSummary> {
	const model = ctx.model;
	if (!model) return { runs: [], stopped: true };
	const runs: RunRecord[] = [];
	const commandsAllowed = entry.source !== "project" || ctx.isProjectTrusted();
	for (const [i, ladderTask] of entry.ladder.tasks.entries()) {
		const task = { ...ladderTask, level: options.levelOverride ?? ladderTask.level };
		const workspace = prepareWorkspace(entry.ladder.files, ctx.cwd);
		if (!workspace.ok) {
			ctx.ui.notify(workspace.error, "error");
			return { runs, stopped: true };
		}
		try {
			const checks = commandsAllowed ? task.checks : task.checks.filter((c) => c.type !== "command");
			const before = snapshot(checks, workspace.dir);
			const header = `Task ${i + 1} of ${entry.ladder.tasks.length}: ${task.title}`;
			const result = await runWithProgress(task, workspace.dir, header, options.agentDir, ctx);
			const checkResults = await runChecks(checks, result.answer, workspace.dir, before);
			const view = { dir: workspace.dir, header, commandsSkipped: checks.length < task.checks.length };
			const outcome = await grade(task, result, checkResults, view, ctx);
			if (outcome === undefined) return { runs, stopped: true };
			if (outcome === "skip") continue;
			const run: RunRecord = {
				version: 1,
				ladderKey: entry.key,
				ladderName: entry.ladder.name,
				taskId: task.id,
				taskTitle: task.title,
				taskKind: task.kind,
				at: Date.now(),
				model: `${model.provider}/${model.id}`,
				thinkingLevel: ctx.thinkingLevel ?? "off",
				level: task.level,
				levelOverride: options.levelOverride,
				durationMs: Math.round(result.durationMs),
				toolCalls: result.toolCalls,
				inputTokens: result.inputTokens,
				outputTokens: result.outputTokens,
				outcome,
				checks: checkResults,
				answer: result.answer.slice(0, 2000),
				error: result.error,
			};
			appendRun(options.dir, run);
			runs.push(run);
		} finally {
			workspace.dispose();
		}
	}
	return { runs, stopped: false };
}

/** Run one task with a progress widget; Escape stops it. Approval questions get Escape first. */
async function runWithProgress(
	task: LadderTask,
	dir: string,
	header: string,
	agentDir: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<RunResult> {
	const model = ctx.model!;
	const controller = new AbortController();
	let asking = false;
	const show = (lines: string[]) =>
		ctx.ui.setWidget(WIDGET_KEY, [
			header,
			`  at careful level ${task.level}, in a copy of the folder`,
			...lines,
			"  Esc stops this task",
		]);
	show(["  starting..."]);
	const stopOnEscape = ctx.ui.onTerminalInput((data) => {
		if (asking || !getKeybindings().matches(data, "app.interrupt")) return undefined;
		controller.abort();
		return { consume: true };
	});
	const ui = ctx.hasUI
		? {
				select: async (...args: Parameters<typeof ctx.ui.select>) => {
					asking = true;
					try {
						return await ctx.ui.select(...args);
					} finally {
						asking = false;
					}
				},
				input: async (...args: Parameters<typeof ctx.ui.input>) => {
					asking = true;
					try {
						return await ctx.ui.input(...args);
					} finally {
						asking = false;
					}
				},
			}
		: undefined;
	try {
		return await runTask(task, dir, {
			model,
			thinkingLevel: ctx.thinkingLevel ?? "off",
			ui,
			agentDir,
			signal: controller.signal,
			onProgress: (p) => show([`  ${p.toolCalls} step(s) so far${p.lastStep ? `, last: ${p.lastStep}` : ""}`]),
		});
	} finally {
		stopOnEscape();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

const GRADES: readonly { label: string; outcome: Outcome | "skip" }[] = [
	{ label: "Pass: it got it right", outcome: "pass" },
	{ label: "Partial: partly right, or right with help", outcome: "partial" },
	{ label: "Fail: wrong, or not done", outcome: "fail" },
	{ label: "Skip: don't record this run", outcome: "skip" },
];

/** Show the result and ask the user for a grade. Returns undefined when they stop the ladder with Escape. */
async function grade(
	task: LadderTask,
	result: RunResult,
	checks: CheckResult[],
	view: { dir: string; header: string; commandsSkipped: boolean },
	ctx: ExtensionCommandContext,
): Promise<Outcome | "skip" | undefined> {
	const lines = [
		view.header,
		`${kindLabel(task.kind)}, careful level ${task.level}`,
		"",
		`You asked: ${clip(task.prompt, 300)}`,
		"",
		result.answer ? `Pi answered:\n${clip(result.answer, 1500)}` : "Pi gave no answer.",
	];
	if (result.error) lines.push("", `The run stopped early: ${result.error}`);
	if (checks.length > 0) {
		lines.push("", "Checks:", ...checks.map((c) => `  ${c.passed ? "ok  " : "FAIL"}  ${c.label}`));
	}
	if (view.commandsSkipped) lines.push("  (command checks skipped: this project is not trusted)");
	if (task.judge) lines.push("", `How to judge: ${task.judge}`);
	lines.push(
		"",
		`It took ${formatStats(result.durationMs, result.toolCalls, result.inputTokens + result.outputTokens)}.`,
		`Its files are in ${view.dir} until you grade.`,
		"",
		"Was it right? Pi never grades its own work: you decide.",
	);
	const choice = await ctx.ui.select(
		lines.join("\n"),
		GRADES.map((g) => g.label),
	);
	return GRADES.find((g) => g.label === choice)?.outcome;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
