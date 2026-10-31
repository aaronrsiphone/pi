/**
 * Careful levels: what the agent may do to the user's files, from "only what I share" to "it's yours".
 *
 *   1  Only what I share     no tools; works from files the user attaches with @
 *   2  Look, don't touch     read, list and search; no writes and no commands
 *   3  Ask before changing   reads freely; asks before every other tool call
 *   4  It's yours            everything, without asking
 *
 * Levels 1 and 2 remove the forbidden tools from the model request and block them if anything calls
 * them anyway, so no setting can grant a write there. Level 4 does not gate at all.
 *
 * Pure data and decisions, shared by every extension that runs the agent at a level: the careful
 * extension for the user's session, and the benchmark extension for its own runs.
 */

export type CarefulLevel = 1 | 2 | 3 | 4;

/** The level newcomers start at, and the level used until the user picks one. */
export const DEFAULT_LEVEL: CarefulLevel = 2;

/** Pi's built-in tools that only read. Listing files is `ls`, so level 3 never needs a shell to look around. */
export const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/** Event-bus channel: ask the careful extension to save and apply a level. Payload: `CarefulSetEvent`. */
export const CAREFUL_SET_EVENT = "careful:set";

/** Event-bus channel: the level in effect, sent at session start and after every change. Payload: `CarefulChangedEvent`. */
export const CAREFUL_CHANGED_EVENT = "careful:changed";

export interface CarefulSetEvent {
	level: CarefulLevel;
}

export interface CarefulChangedEvent {
	level: CarefulLevel;
}

export interface LevelInfo {
	level: CarefulLevel;
	label: string;
	/** Answers the user's question: what might it do to my files? */
	summary: string;
	/** What the agent can and cannot do, one item per line. */
	details: string[];
	/** A request that works well at this level. */
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
		summary: "It can open, list and search files. It can't change, delete or run anything.",
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
		summary: "It opens and searches files freely. It asks you before every change and every command.",
		details: [
			"Can open, list and search files without asking.",
			"Asks before every file change and every command.",
			"You see what it wants to do and can say yes, no, or tell it what to do instead.",
		],
		example: "Change the units in the pressure column of results.csv from psi to kPa.",
	},
	{
		level: 4,
		label: "It's yours",
		summary: "It changes files and runs commands without asking.",
		details: [
			"Can change, create and delete files and run commands without asking.",
			"Use it in folders you have a backup of, or that are under version control.",
		],
		example: "Write a script that plots data.csv, run it, and check the axis labels.",
	},
];

/** Info for a careful level. */
export function levelInfo(level: CarefulLevel): LevelInfo {
	return LEVELS[level - 1];
}

/** "2 Look, don't touch", for status lines and messages. */
export function levelLabel(level: CarefulLevel): string {
	return `${level} ${levelInfo(level).label}`;
}

/** Parse a level from config, a flag, or a command argument. */
export function parseLevel(value: unknown): CarefulLevel | undefined {
	const n = typeof value === "string" && /^[1-4]$/.test(value.trim()) ? Number(value) : value;
	return n === 1 || n === 2 || n === 3 || n === 4 ? n : undefined;
}

/** The level in effect when a project allows at most `cap`: the lower of the two. */
export function capLevel(level: CarefulLevel, cap: CarefulLevel | undefined): CarefulLevel {
	return cap !== undefined && cap < level ? cap : level;
}

/** Tools a level allows at all, or undefined when it does not limit tools. */
export function allowedTools(level: CarefulLevel): readonly string[] | undefined {
	if (level === 1) return [];
	if (level === 2) return READ_TOOLS;
	return undefined;
}

/** System prompt section telling the model what it can do, so it does not try what it cannot. */
export function promptSection(level: CarefulLevel): string | undefined {
	switch (level) {
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
				"Every file change and every command needs the user's approval, and they may say no. Use ls, find, and grep to look around instead of shell commands.",
				"Before such a step, say in one sentence what you are about to do and why. If the user says no, do not retry it; follow their reason or ask.",
			].join("\n");
		case 4:
			return undefined;
	}
}

export type LevelDecision = { action: "allow" } | { action: "ask" } | { action: "block"; reason: string };

/** Decide one tool call at a careful level. */
export function decideForLevel(level: CarefulLevel, toolName: string): LevelDecision {
	if (level === 4) return { action: "allow" };
	if (READ_TOOLS.includes(toolName)) return level === 1 ? blockAtLevel1() : { action: "allow" };
	if (level === 1) return blockAtLevel1();
	if (level === 2) {
		return {
			action: "block",
			reason: `Careful level 2 (${levelInfo(2).label}) allows only reading, listing, and searching. ${toolName} is not available. Describe the change as a plan instead; the user can switch to level 3 with /careful.`,
		};
	}
	return { action: "ask" };
}

function blockAtLevel1(): LevelDecision {
	return {
		action: "block",
		reason: `Careful level 1 (${levelInfo(1).label}) allows no tools. Answer from the files the user attached, or ask them to attach the file you need with @path.`,
	};
}
