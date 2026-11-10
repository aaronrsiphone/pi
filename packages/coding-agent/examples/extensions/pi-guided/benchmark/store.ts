/**
 * Where ladders and run history live.
 *
 *   <agentDir>/benchmark/ladders/*.json    personal ladders
 *   <project>/.pi/benchmarks/*.json        a team's ladders, shared in the project folder
 *   <agentDir>/benchmark/runs.jsonl        run history, per user, one run per line
 *
 * Project ladders show up alongside personal ones; run history always stays with the user, so each
 * colleague's results from a shared ladder are their own.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { CarefulLevel } from "../careful/levels.ts";
import { EXAMPLE_LADDERS } from "./examples.ts";
import { type Ladder, parseLadder, type TaskKind } from "./ladder.ts";

export type LadderSource = "personal" | "project" | "example";

export interface LadderEntry {
	/** Identifies the ladder in run history. */
	key: string;
	source: LadderSource;
	/** The file it was read from; undefined for examples. */
	path: string | undefined;
	ladder: Ladder;
}

export type Outcome = "pass" | "partial" | "fail";

export interface CheckResult {
	label: string;
	passed: boolean;
}

/** One run of one task, with the settings it ran with and what it cost. */
export interface RunRecord {
	version: 1;
	ladderKey: string;
	ladderName: string;
	taskId: string;
	taskTitle: string;
	taskKind: TaskKind;
	at: number;
	/** `provider/model`. */
	model: string;
	thinkingLevel: ThinkingLevel;
	level: CarefulLevel;
	/** The one level every task ran at, when the user chose it instead of the ladder's levels. */
	levelOverride: CarefulLevel | undefined;
	durationMs: number;
	/** Tool calls the agent made, the "steps". */
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	/** The user's grade. */
	outcome: Outcome;
	checks: CheckResult[];
	/** The agent's final answer, cut to keep history small. */
	answer: string;
	error: string | undefined;
}

/** Project folder for shared ladders, relative to the project. */
export const PROJECT_LADDER_DIR = join(CONFIG_DIR_NAME, "benchmarks");

/** Default directory for personal ladders and history. */
export function defaultBenchmarkDir(): string {
	return join(getAgentDir(), "benchmark");
}

/** Every ladder the user can run here: personal, then the project's, then the examples. Broken files are reported. */
export function listLadders(dir: string, projectDir: string): { ladders: LadderEntry[]; problems: string[] } {
	const ladders: LadderEntry[] = [];
	const problems: string[] = [];
	for (const [source, folder] of [
		["personal", join(dir, "ladders")],
		["project", join(projectDir, PROJECT_LADDER_DIR)],
	] as const) {
		if (!existsSync(folder)) continue;
		for (const name of readdirSync(folder)
			.filter((n) => n.endsWith(".json"))
			.sort()) {
			const path = join(folder, name);
			const parsed = readLadder(path);
			if (parsed.ok) ladders.push({ key: `${source}:${path}`, source, path, ladder: parsed.ladder });
			else problems.push(`${path}: ${parsed.error}`);
		}
	}
	for (const [id, ladder] of Object.entries(EXAMPLE_LADDERS)) {
		ladders.push({ key: `example:${id}`, source: "example", path: undefined, ladder });
	}
	return { ladders, problems };
}

function readLadder(path: string): ReturnType<typeof parseLadder> {
	try {
		return parseLadder(JSON.parse(readFileSync(path, "utf-8")));
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Save a ladder as a personal ladder, or into the project for the team. Returns the file path. */
export function saveLadder(folder: string, ladder: Ladder): string {
	mkdirSync(folder, { recursive: true });
	const slug =
		ladder.name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "") || "ladder";
	let path = join(folder, `${slug}.json`);
	for (let n = 2; existsSync(path); n++) path = join(folder, `${slug}-${n}.json`);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(ladder, null, "\t")}\n`, "utf-8");
	renameSync(tmp, path);
	return path;
}

/** Append one run to the user's history. */
export function appendRun(dir: string, run: RunRecord): void {
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(run)}\n`, "utf-8");
}

/** The user's runs, oldest first, optionally for one ladder. Lines that do not parse are skipped. */
export function loadRuns(dir: string, ladderKey?: string): RunRecord[] {
	const file = join(dir, "runs.jsonl");
	if (!existsSync(file)) return [];
	const runs: RunRecord[] = [];
	for (const line of readFileSync(file, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const run = JSON.parse(line) as RunRecord;
			if (run.version === 1 && (ladderKey === undefined || run.ladderKey === ladderKey)) runs.push(run);
		} catch {
			// A line cut by a crash; the rest of the history is still good.
		}
	}
	return runs;
}
