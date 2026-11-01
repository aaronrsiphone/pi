/**
 * Compare runs of one ladder across settings: model, thinking effort, and careful level.
 *
 * The lesson a benchmark teaches is that settings change results. This turns the history into a
 * table with one column per setup, so after switching model or effort the user sees what changed.
 */

import type { Outcome, RunRecord } from "./store.ts";

/** The settings a run used; runs with the same setup are compared with each other. */
export interface Setup {
	key: string;
	model: string;
	thinkingLevel: string;
	/** "ladder levels" when every task ran at its own level, otherwise the one level used. */
	levels: string;
}

export interface Cell {
	outcome: Outcome;
	durationMs: number;
	toolCalls: number;
	tokens: number;
}

export interface Comparison {
	/** Oldest first, at most `MAX_SETUPS`. */
	setups: Setup[];
	rows: { taskId: string; title: string; cells: (Cell | undefined)[] }[];
}

// More columns than this do not fit a terminal; the newest setups are the interesting ones.
const MAX_SETUPS = 3;

/** Group a ladder's runs by setup and keep each task's latest run per setup. */
export function compareRuns(runs: readonly RunRecord[], tasks: readonly { id: string; title: string }[]): Comparison {
	const setups: Setup[] = [];
	const latest = new Map<string, RunRecord>();
	for (const run of runs) {
		const setup = setupOf(run);
		const existing = setups.findIndex((s) => s.key === setup.key);
		// A setup used again moves to the end, so the newest setups are kept.
		if (existing !== -1) setups.splice(existing, 1);
		setups.push(setup);
		latest.set(`${setup.key}\u0000${run.taskId}`, run);
	}
	const shown = setups.slice(-MAX_SETUPS);
	return {
		setups: shown,
		rows: tasks.map((task) => ({
			taskId: task.id,
			title: task.title,
			cells: shown.map((setup) => {
				const run = latest.get(`${setup.key}\u0000${task.id}`);
				return run
					? {
							outcome: run.outcome,
							durationMs: run.durationMs,
							toolCalls: run.toolCalls,
							tokens: run.inputTokens + run.outputTokens,
						}
					: undefined;
			}),
		})),
	};
}

/** Runs of one ladder that ran together, at the ladder's levels or one chosen level, share a setup. */
function setupOf(run: RunRecord): Setup {
	const levels = run.levelOverride === undefined ? "ladder levels" : `level ${run.levelOverride}`;
	return {
		key: `${run.model}|${run.thinkingLevel}|${levels}`,
		model: run.model,
		thinkingLevel: run.thinkingLevel,
		levels,
	};
}

/** The comparison as text lines: one block per task, one line per setup. */
export function formatComparison(comparison: Comparison): string[] {
	const lines: string[] = [];
	comparison.setups.forEach((setup, i) => {
		lines.push(`${String.fromCharCode(65 + i)}: ${setup.model}, effort ${setup.thinkingLevel}, ${setup.levels}`);
	});
	for (const row of comparison.rows) {
		lines.push("", row.title);
		row.cells.forEach((cell, i) => {
			const name = String.fromCharCode(65 + i);
			lines.push(cell ? `  ${name}  ${formatCell(cell)}` : `  ${name}  not run`);
		});
	}
	lines.push("", "Totals");
	comparison.setups.forEach((_setup, i) => {
		const cells = comparison.rows.map((r) => r.cells[i]).filter((c): c is Cell => c !== undefined);
		const passed = cells.filter((c) => c.outcome === "pass").length;
		const seconds = cells.reduce((sum, c) => sum + c.durationMs, 0) / 1000;
		const tokens = cells.reduce((sum, c) => sum + c.tokens, 0);
		lines.push(
			`  ${String.fromCharCode(65 + i)}  ${passed} of ${comparison.rows.length} passed, ${formatSeconds(seconds)}, ${formatTokens(tokens)} tokens`,
		);
	});
	return lines;
}

/** One run as "pass, 12 s, 4 step(s), 3.1k tokens". */
export function formatCell(cell: Cell): string {
	return `${cell.outcome}, ${formatStats(cell.durationMs, cell.toolCalls, cell.tokens)}`;
}

/** What a run cost as "12 s, 4 step(s), 3.1k tokens". */
export function formatStats(durationMs: number, toolCalls: number, tokens: number): string {
	return `${formatSeconds(durationMs / 1000)}, ${toolCalls} step(s), ${formatTokens(tokens)} tokens`;
}

function formatSeconds(seconds: number): string {
	return seconds < 90 ? `${Math.round(seconds)} s` : `${(seconds / 60).toFixed(1)} min`;
}

function formatTokens(tokens: number): string {
	return tokens < 1000 ? String(tokens) : `${(tokens / 1000).toFixed(1)}k`;
}
