/**
 * What the user's own benchmarks say about one model, in plain words, for the expectations card.
 *
 * Uses each task's latest graded run with that model, so a task that failed once and passes now
 * counts as passing.
 */

import { kindLabel } from "./ladder.ts";
import type { RunRecord } from "./store.ts";

/** Lines for the card: how many tasks passed, which kinds went well, and which need checking. */
export function summarizeForModel(runs: readonly RunRecord[], model: string): string[] {
	const latest = new Map<string, RunRecord>();
	for (const run of runs) if (run.model === model) latest.set(`${run.ladderKey}\u0000${run.taskId}`, run);
	if (latest.size === 0)
		return ["No benchmark runs with this model yet. Run /bench to try tasks you know the answers to."];
	const graded = [...latest.values()];
	const count = (outcome: RunRecord["outcome"]) => graded.filter((r) => r.outcome === outcome).length;
	const lines = [
		`${count("pass")} of ${graded.length} task(s) passed, ${count("partial")} partly, ${count("fail")} failed.`,
	];
	const byKind = new Map<string, RunRecord[]>();
	for (const run of graded) {
		const kind = kindLabel(run.taskKind);
		byKind.set(kind, [...(byKind.get(kind) ?? []), run]);
	}
	const good = [...byKind].filter(([, rs]) => rs.every((r) => r.outcome === "pass")).map(([k]) => k);
	const weak = [...byKind].filter(([, rs]) => rs.some((r) => r.outcome !== "pass")).map(([k]) => k);
	if (good.length > 0) lines.push(`Did well: ${good.join(", ")}.`);
	if (weak.length > 0) lines.push(`Check its work on: ${weak.join(", ")}.`);
	return lines;
}
