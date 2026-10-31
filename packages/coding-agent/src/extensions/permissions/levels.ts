/**
 * Careful levels: how much the agent may do, from "only what I share" to "it's yours".
 *
 * A level caps what the agent can do, not only when it asks:
 *
 *   1  Only what I share     no tools; works from files the user attaches with @
 *   2  Look, don't touch     read, list and search; no writes and no shell
 *   3  Ask before changing   reads freely; asks before every change and every command that could change something
 *   4  It's yours            everything without asking, except dangerous actions
 *
 * Levels 1 and 2 remove the forbidden tools from the model request and block them if anything calls
 * them anyway, so no rule or setting can grant a write there. "adaptive" is the advanced mode for
 * experienced users: rules and learning from the adaptive permission gate. It is set in config or
 * with /permissions, never offered in the beginner picker.
 */

import type { GateRequest } from "./policy.ts";
import { READ_TOOLS } from "./request.ts";
import { Risk } from "./risk.ts";

export type CarefulLevel = 1 | 2 | 3 | 4;
export type PermissionMode = CarefulLevel | "adaptive";

/** The level newcomers start at, and the level used until the user picks one. */
export const DEFAULT_MODE: PermissionMode = 2;

export interface LevelInfo {
	level: CarefulLevel;
	label: string;
	/** Answers the user's question: what might it do to my files? */
	summary: string;
	/** What the agent can and cannot do, one item per line. */
	details: string[];
	/** Concrete example of a request that works well at this level. */
	example: string;
}

export const LEVELS: readonly LevelInfo[] = [
	{
		level: 1,
		label: "Only what I share",
		summary: "It can't open, change or run anything. It only sees files you attach with @.",
		details: [
			"No tools at all: it cannot open, search, change or run anything.",
			"Attach a file by typing @ and its name; pi pastes the file into your message.",
		],
		example: "@data/header.txt What is the sample rate in this header?",
	},
	{
		level: 2,
		label: "Look, don't touch",
		summary: "It can open and search files in this folder. It can't change, delete or run anything.",
		details: [
			"Can open, list and search files.",
			"Cannot change, create or delete files, and cannot run commands (a command can change files).",
			"Can write a plan for you to review before you move to level 3.",
		],
		example: "Which script makes figure 3?",
	},
	{
		level: 3,
		label: "Ask before changing",
		summary: "It looks around freely. It asks you before it changes a file or runs a command.",
		details: [
			"Can open, list and search files without asking.",
			"Asks before every file change and before every command that could change something.",
			"You see what it wants to do and can say yes, no, or tell it what to do instead.",
		],
		example: "Change the units in the pressure column of results.csv from psi to kPa.",
	},
	{
		level: 4,
		label: "It's yours",
		summary: "It changes files and runs commands without asking. It still asks before anything dangerous.",
		details: [
			"Can change, create and delete files and run commands without asking.",
			"Still asks before dangerous actions, such as deleting your home folder or using sudo.",
			"Use it in folders you have a backup of, or that are under version control.",
		],
		example: "Write a script that plots data.csv, run it, and check the axis labels.",
	},
];

/** Info for a careful level. */
export function levelInfo(level: CarefulLevel): LevelInfo {
	return LEVELS[level - 1];
}

/** One-line name of a mode for status lines and messages. */
export function modeLabel(mode: PermissionMode): string {
	return mode === "adaptive" ? "adaptive rules" : `${mode} ${levelInfo(mode).label}`;
}

/** Parse a mode from config, a flag, or a command argument. */
export function parseMode(value: unknown): PermissionMode | undefined {
	if (value === "adaptive") return "adaptive";
	const n = typeof value === "string" && /^[1-4]$/.test(value.trim()) ? Number(value) : value;
	return n === 1 || n === 2 || n === 3 || n === 4 ? n : undefined;
}

// Adaptive rules ask until learned, so they sit between asking every time and never asking.
const MODE_RANK: Record<PermissionMode, number> = { 1: 1, 2: 2, 3: 3, adaptive: 3.5, 4: 4 };

/** The mode in effect when a project allows at most `cap`: the lower of the two. */
export function capMode(mode: PermissionMode, cap: CarefulLevel | undefined): PermissionMode {
	if (cap === undefined) return mode;
	return MODE_RANK[mode] > MODE_RANK[cap] ? cap : mode;
}

/** Tools a mode allows at all, or undefined when it does not limit tools. */
export function allowedTools(mode: PermissionMode): readonly string[] | undefined {
	if (mode === 1) return [];
	if (mode === 2) return READ_TOOLS;
	return undefined;
}

/** System prompt section telling the model what it can do, so it does not try what it cannot. */
export function promptSection(mode: PermissionMode): string | undefined {
	switch (mode) {
		case 1:
			return [
				`The user chose careful level 1 (${levelInfo(1).label}). You have no tools: you cannot read, search, change, or run anything.`,
				"Work only from file contents the user attached in the conversation (shown in <file> blocks).",
				"If you need another file, ask the user to attach it by typing @ followed by its path.",
			].join("\n");
		case 2:
			return [
				`The user chose careful level 2 (${levelInfo(2).label}). You can read, list, and search files.`,
				"You cannot create, change, or delete files or run commands; those tools are not available.",
				"When a task needs changes, write a short numbered plan the user can review, and say they can switch to level 3 with /careful to have you carry it out.",
			].join("\n");
		case 3:
			return [
				`The user chose careful level 3 (${levelInfo(3).label}). You can read, list, and search freely.`,
				"Every file change and every command that could change something needs the user's approval, and they may say no.",
				"Before such a step, say in one sentence what you are about to do and why. If the user says no, do not retry it; follow their reason or ask.",
			].join("\n");
		case 4:
			return [
				`The user chose careful level 4 (${levelInfo(4).label}). You may change files and run commands in this project without asking.`,
				"Dangerous actions, such as deleting files outside the project or using sudo, still need the user's approval.",
			].join("\n");
		case "adaptive":
			return undefined;
	}
}

export type LevelDecision = { action: "allow" } | { action: "ask" } | { action: "block"; reason: string };

/**
 * Decide a tool call at a careful level. `request` is undefined for calls the request builder does
 * not gate (ordinary reads).
 */
export function decideForLevel(level: CarefulLevel, toolName: string, request: GateRequest | undefined): LevelDecision {
	const allowed = allowedTools(level);
	if (allowed && !allowed.includes(toolName)) {
		return {
			action: "block",
			reason:
				level === 1
					? `Careful level 1 (${levelInfo(1).label}) allows no tools. Answer from the files the user attached, or ask them to attach the file you need with @path.`
					: `Careful level 2 (${levelInfo(2).label}) allows only reading, listing, and searching. ${toolName} is not available. Describe the change as a plan instead; the user can switch to level 3 with /careful.`,
		};
	}
	if (!request) return { action: "allow" };
	const top = request.analyses.reduce<Risk>((risk, a) => (a.risk > risk ? a.risk : risk), Risk.safe);
	if (level === 4) return top >= Risk.critical ? { action: "ask" } : { action: "allow" };
	// Levels 2 and 3: anything beyond a plain read asks, including reads of credentials.
	if (top > Risk.safe || request.issues.length > 0) return { action: "ask" };
	return { action: "allow" };
}
