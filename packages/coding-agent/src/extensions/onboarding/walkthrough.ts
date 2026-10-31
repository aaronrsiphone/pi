/**
 * The permission walkthrough: experience question, careful level, a practice approval, first task.
 *
 * Everything here is fixed text and pi's own code. The practice question is built by the same code
 * as a real approval question, from a sample command, and nothing runs.
 */

import type { ExtensionContext } from "../../core/extensions/types.ts";
import { APPROVAL_OPTIONS, type ApprovalAction, describeCall } from "../careful/approval.ts";
import { type CarefulLevel, DEFAULT_LEVEL, LEVELS, levelInfo } from "../careful/levels.ts";
import type { FlowEvent } from "./flow.ts";

export interface LevelDeps {
	/** Save the level and apply it to this session (through the careful extension). */
	chooseLevel(level: CarefulLevel): void;
	/** The level the probe results recommend for this model, if it was measured. */
	modelLevel: CarefulLevel | undefined;
}

const NEW_TO_AGENTS = "No, this is new to me";
const USED_AGENTS = "Yes, I have used one (Claude Code, Copilot agent mode, Cursor, ...)";

/** Ask whether the user has used an AI agent; experienced users get the short path. */
export async function runExperience(ctx: ExtensionContext): Promise<FlowEvent | undefined> {
	const choice = await ctx.ui.select(
		"Have you used an AI agent before?\n\nAn agent is an AI that can open, change and run things on your computer, not only chat.",
		[NEW_TO_AGENTS, USED_AGENTS],
	);
	if (choice === undefined) return undefined;
	return { type: "answered-experience", experienced: choice === USED_AGENTS };
}

// Newcomers start here even with a strong model; a weaker model lowers it.
const NEWCOMER_LEVEL = DEFAULT_LEVEL;

/** Explain the careful levels and save the one the user picks. */
export async function runLevels(
	ctx: ExtensionContext,
	experienced: boolean,
	deps: LevelDeps,
): Promise<FlowEvent | undefined> {
	const recommended = experienced
		? (deps.modelLevel ?? NEWCOMER_LEVEL)
		: (Math.min(NEWCOMER_LEVEL, deps.modelLevel ?? NEWCOMER_LEVEL) as CarefulLevel);
	const intro = experienced
		? "Pick how careful pi should be. Change it any time with /careful."
		: `Before pi starts, decide what it may do to your files. You can change this any time with /careful.\nNew to agents? Start at level ${recommended} and move up when you trust the results.`;
	const lines = LEVELS.map((l) => `${l.level}. ${l.label}: ${l.summary}`);
	const options = LEVELS.map(
		(l) => `${l.level}. ${l.label}${l.level === recommended ? " (recommended to start)" : ""}`,
	);
	const choice = await ctx.ui.select(`How careful should pi be?\n\n${intro}\n\n${lines.join("\n")}`, options);
	if (choice === undefined) return undefined;
	const level = LEVELS[options.indexOf(choice)].level;
	deps.chooseLevel(level);
	const settings = experienced
		? "\n\nSettings: /careful (level), /model, /thinking (effort), /login, /probe (measure the model), /onboarding (run setup again)."
		: "";
	ctx.ui.notify(
		`Careful level ${level}: ${levelInfo(level).label}.\n${levelInfo(level).details.join("\n")}${settings}`,
		"info",
	);
	return { type: "chose-level" };
}

// A command a scientist recognizes; at level 3 every command asks like this.
const PRACTICE_COMMAND = "rm results/old-run.csv";

const AFTER_PRACTICE: Record<ApprovalAction, string> = {
	yes: 'Pi would run it now. Say yes only when you understand what it does. If you are unsure, pick "Let\'s talk about it first".',
	no: "Pi skips this step and tries another way, or asks you what to do.",
	"no-reason": "Pi skips this step and follows what you typed, for example: keep the old file and write a new one.",
	chat: "Pi stops and explains what it wanted to do and why. Nothing runs until you agree.",
};

/** Show what an approval question looks like and what each answer does. Nothing runs. */
export async function runPractice(ctx: ExtensionContext): Promise<FlowEvent | undefined> {
	const question = describeCall("bash", { command: PRACTICE_COMMAND }, ctx.cwd);
	const label = await ctx.ui.select(
		`Practice: at level 3 pi asks like this before every change and every command. Nothing will run.\n\n${question.title}\n\n${question.description}`,
		APPROVAL_OPTIONS.map((o) => o.label),
	);
	const action = APPROVAL_OPTIONS.find((o) => o.label === label)?.action;
	if (!action) return undefined;
	const done = await ctx.ui.select(`You chose "${label}".\n\n${AFTER_PRACTICE[action]}`, ["Continue"]);
	return done === undefined ? undefined : { type: "practiced" };
}

const USE_EXAMPLE = "Put the example in the message box";

/** Suggest a first task with a known answer, matched to the level in effect (level 4 when careful is off). */
export async function runFirstTask(
	ctx: ExtensionContext,
	current: CarefulLevel | undefined,
): Promise<FlowEvent | undefined> {
	const level = current ?? 4;
	const example = levelInfo(level).example;
	const choice = await ctx.ui.select(
		[
			"Your first task",
			"",
			"Start with something you already know the answer to, so you can check what pi says.",
			current ? `At level ${level} (${levelInfo(level).label}) a good first task is:` : "A good first task is:",
			`  ${example}`,
			"",
			current
				? "Change it to fit your own files, then press Enter. Move up a level with /careful when the answers are right."
				: "Change it to fit your own files, then press Enter.",
		].join("\n"),
		[USE_EXAMPLE, "I'll write my own"],
	);
	if (choice === undefined) return undefined;
	if (choice === USE_EXAMPLE) ctx.ui.setEditorText(example);
	ctx.ui.notify(
		current
			? "Setup done. Run /onboarding to go through it again, or /careful to change the level."
			: "Setup done. Run /onboarding to go through it again.",
		"info",
	);
	return { type: "suggested-task" };
}
