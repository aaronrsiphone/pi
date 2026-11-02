/**
 * Onboarding progress on disk, per user: `<agentDir>/onboarding/state.json`.
 *
 * Saved after every answer so setup can be paused with Escape, closed, and resumed later.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type OnboardingState, parseState } from "./flow.ts";

/** Default directory for onboarding state. */
export function defaultOnboardingDir(): string {
	return join(getAgentDir(), "onboarding");
}

/** Read saved progress; a missing or broken file means onboarding has not started. */
export function loadState(dir: string): OnboardingState {
	const file = join(dir, "state.json");
	if (!existsSync(file)) return parseState(undefined);
	try {
		return parseState(JSON.parse(readFileSync(file, "utf-8")));
	} catch (error) {
		console.error(`[onboarding] ignoring unreadable ${file}:`, error);
		return parseState(undefined);
	}
}

/** Write progress atomically, so a crash mid-write never leaves a half file. */
export function saveState(dir: string, state: OnboardingState): void {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "state.json");
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(state, null, "\t")}\n`, "utf-8");
	renameSync(tmp, file);
}
