/**
 * Automatic checks for a run: shown next to the answer, so the user can grade quickly.
 *
 * They help the user judge; they never grade. Files are read from the run's folder after the run,
 * compared with what was there before it, and commands run in that folder.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Check } from "./ladder.ts";
import type { CheckResult } from "./store.ts";

/** File contents before the run, for `file-unchanged` checks. Missing files are recorded as undefined. */
export type Snapshot = Map<string, string | undefined>;

// A check command is a quick test such as running a script; anything slower is stopped.
const COMMAND_TIMEOUT_MS = 60_000;

/** Record the files that `file-unchanged` checks compare against. */
export function snapshot(checks: readonly Check[], dir: string): Snapshot {
	const out: Snapshot = new Map();
	for (const check of checks) {
		if (check.type === "file-unchanged") out.set(check.path, readText(join(dir, check.path)));
	}
	return out;
}

/** Run every check against the answer and the run's folder. */
export async function runChecks(
	checks: readonly Check[],
	answer: string,
	dir: string,
	before: Snapshot,
): Promise<CheckResult[]> {
	const results: CheckResult[] = [];
	for (const check of checks) results.push(await runCheck(check, answer, dir, before));
	return results;
}

async function runCheck(check: Check, answer: string, dir: string, before: Snapshot): Promise<CheckResult> {
	switch (check.type) {
		case "answer-contains":
			return {
				label: `answer mentions "${check.text}"`,
				passed: answer.toLowerCase().includes(check.text.toLowerCase()),
			};
		case "file-contains":
			return {
				label: `${check.path} contains "${check.text}"`,
				passed: readText(join(dir, check.path))?.includes(check.text) ?? false,
			};
		case "file-unchanged":
			return {
				label: `${check.path} is unchanged`,
				passed: readText(join(dir, check.path)) === before.get(check.path),
			};
		case "command": {
			const code = await runCommand(check.command, dir);
			return {
				label: `\`${check.command}\` exits with ${check.exitCode}${code === check.exitCode ? "" : ` (got ${code ?? "a timeout"})`}`,
				passed: code === check.exitCode,
			};
		}
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
}

/** Exit code of `command` run by the shell in `dir`, or undefined when it timed out or could not start. */
function runCommand(command: string, dir: string): Promise<number | undefined> {
	return new Promise((resolve) => {
		const child = spawn(command, { cwd: dir, shell: true, stdio: "ignore", timeout: COMMAND_TIMEOUT_MS });
		child.on("error", () => resolve(undefined));
		child.on("close", (code) => resolve(code ?? undefined));
	});
}
