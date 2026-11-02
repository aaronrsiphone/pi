/**
 * Where the careful level is saved.
 *
 *   <agentDir>/careful/config.json   { "level": 1-4 }    the user's chosen level, for every project
 *   <project>/.pi/careful.json       { "maxLevel": 1-4 } a project's cap, which can only lower the level
 *
 * A project file is honoured without project trust because it can only make pi more careful.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type CarefulLevel, parseLevel } from "./levels.ts";

/** Path of a project's cap file, relative to the project folder. */
export const PROJECT_CAP_FILE = join(CONFIG_DIR_NAME, "careful.json");

/** Default directory for the user's saved level. */
export function defaultCarefulDir(): string {
	return join(getAgentDir(), "careful");
}

/** The level the user saved, or undefined when they have not picked one. */
export function readSavedLevel(dir: string): CarefulLevel | undefined {
	try {
		return parseLevel((JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as { level?: unknown }).level);
	} catch {
		return undefined;
	}
}

/** Save the user's level atomically, so a crash mid-write never leaves a half file. */
export function writeSavedLevel(dir: string, level: CarefulLevel): void {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "config.json");
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ level }, null, "\t")}\n`, "utf-8");
	renameSync(tmp, file);
}

/** Reads a project's cap, re-reading the file only when it changed, since this runs on every tool call. */
export function createProjectCapReader(): (projectDir: string) => CarefulLevel | undefined {
	let cache: { file: string; mtimeMs: number; cap: CarefulLevel | undefined } | undefined;
	return (projectDir) => {
		const file = join(projectDir, PROJECT_CAP_FILE);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return undefined;
		}
		if (cache?.file !== file || cache.mtimeMs !== mtimeMs) {
			let cap: CarefulLevel | undefined;
			try {
				cap = parseLevel((JSON.parse(readFileSync(file, "utf-8")) as { maxLevel?: unknown }).maxLevel);
			} catch (error) {
				console.error(`[careful] ignoring invalid ${file}:`, error);
			}
			cache = { file, mtimeMs, cap };
		}
		return cache.cap;
	};
}
