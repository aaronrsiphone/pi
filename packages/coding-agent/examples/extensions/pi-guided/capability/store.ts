/**
 * Probe results per user: `<agentDir>/capability/<model>.json`, the latest run plus a short history.
 *
 * Results from another suite version are ignored, so a changed probe never compares with an old one.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SUITE_VERSION } from "./ranges.ts";
import type { SuiteResult } from "./suite.ts";

/** Default directory for probe results. */
export function defaultCapabilityDir(): string {
	return join(getAgentDir(), "capability");
}

interface ResultFile {
	results: SuiteResult[];
}

// Enough to see a trend after changing settings, small enough to read at every start.
const MAX_HISTORY = 10;

/** Save a run, newest first. */
export function saveResult(dir: string, result: SuiteResult): void {
	mkdirSync(dir, { recursive: true });
	const file = fileFor(dir, result.model);
	const results = [result, ...readFile(file).results].slice(0, MAX_HISTORY);
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ results }, null, "\t")}\n`, "utf-8");
	renameSync(tmp, file);
}

/** Runs of the current suite for `provider/model`, newest first. */
export function loadResults(dir: string, model: string): SuiteResult[] {
	return readFile(fileFor(dir, model)).results.filter((r) => r.suiteVersion === SUITE_VERSION);
}

/**
 * The latest saved run for `provider/model` at this thinking effort, so the model need not be
 * measured again. A different effort or suite version measures differently, so it does not count.
 */
export function savedResult(dir: string, model: string, thinkingLevel: string): SuiteResult | undefined {
	return loadResults(dir, model).find((r) => r.thinkingLevel === thinkingLevel);
}

function fileFor(dir: string, model: string): string {
	return join(dir, `${model.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
}

function readFile(file: string): ResultFile {
	if (!existsSync(file)) return { results: [] };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<ResultFile>;
		return { results: Array.isArray(parsed.results) ? parsed.results : [] };
	} catch (error) {
		console.error(`[capability] ignoring unreadable ${file}:`, error);
		return { results: [] };
	}
}
