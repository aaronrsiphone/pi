/**
 * Build a ladder step by step, with pi's help, from tasks the user already knows the answers to.
 *
 * Pi asks in code, one question at a time, for each of the five kinds of task: the prompt, the
 * files it needs, how the user will judge it, and an optional automatic check. Nothing here asks
 * the model; the guide must not depend on the model being tested.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { LEVELS, levelLabel } from "../careful/levels.ts";
import { type Check, type Ladder, type LadderTask, TASK_KINDS } from "./ladder.ts";

const ADD = "Add a task like this";
const SKIP = "Skip this kind";
const FINISH = "Finish the ladder";

/** Ask for a ladder. Returns undefined when the user cancels with Escape or adds no task. */
export async function buildLadder(ctx: ExtensionCommandContext): Promise<Ladder | undefined> {
	const name = (await ctx.ui.input("Name the ladder", "e.g. Rig B data checks"))?.trim();
	if (!name) return undefined;
	const tasks: LadderTask[] = [];
	for (const [i, kind] of TASK_KINDS.entries()) {
		const choice = await ctx.ui.select(
			[
				`Step ${i + 1} of ${TASK_KINDS.length}: ${kind.label}`,
				"",
				`For example: "${kind.example}"`,
				"",
				"Pick a task you already know the answer to, so you can tell whether pi got it right.",
				`It runs at careful level ${levelLabel(kind.level)} unless you change it.`,
			].join("\n"),
			tasks.length > 0 ? [ADD, SKIP, FINISH] : [ADD, SKIP],
		);
		if (choice === undefined) return undefined;
		if (choice === FINISH) break;
		if (choice === SKIP) continue;
		const task = await askTask(kind, tasks.length + 1, ctx);
		if (!task) return undefined;
		tasks.push(task);
	}
	if (tasks.length === 0) return undefined;
	return { version: 1, name, description: "", files: undefined, tasks };
}

async function askTask(
	kind: (typeof TASK_KINDS)[number],
	n: number,
	ctx: ExtensionCommandContext,
): Promise<LadderTask | undefined> {
	const prompt = (await ctx.ui.editor(`${kind.label}: what will you ask pi?`, kind.example))?.trim();
	if (!prompt) return undefined;
	const files = await ctx.ui.input(
		"Which files does it need? (paths in this folder, separated by commas; leave empty if none)",
		kind.level === 1 ? "e.g. data/header.txt" : "",
	);
	if (files === undefined) return undefined;
	const levelChoice = await ctx.ui.select(
		"At which careful level should it run?",
		LEVELS.map((l) => `${levelLabel(l.level)}${l.level === kind.level ? " (suggested)" : ""}`),
	);
	if (levelChoice === undefined) return undefined;
	const level = LEVELS.find((l) => levelChoice.startsWith(levelLabel(l.level)))!.level;
	const judge = await ctx.ui.input("How will you judge the answer? What is the right result?", "e.g. 48000 Hz");
	if (judge === undefined) return undefined;
	const check = await askCheck(ctx);
	if (check === null) return undefined;
	return {
		id: `task-${n}`,
		title: prompt.split("\n")[0].slice(0, 60),
		kind: kind.kind,
		prompt,
		files: files
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean),
		level,
		judge: judge.trim(),
		checks: check ? [check] : [],
	};
}

const CHECK_ANSWER = "The answer should mention some text";
const CHECK_FILE = "A file should contain some text afterwards";
const CHECK_NONE = "No automatic check, I'll judge myself";

/** An optional automatic check. Returns undefined for none, and null when the user cancels. */
async function askCheck(ctx: ExtensionCommandContext): Promise<Check | undefined | null> {
	const choice = await ctx.ui.select(
		"Add an automatic check? Pi shows it next to the answer to help you grade; you still decide.",
		[CHECK_NONE, CHECK_ANSWER, CHECK_FILE],
	);
	if (choice === undefined) return null;
	if (choice === CHECK_NONE) return undefined;
	if (choice === CHECK_ANSWER) {
		const text = (await ctx.ui.input("Text the answer should mention", "e.g. 48000"))?.trim();
		return text ? { type: "answer-contains", text } : null;
	}
	const path = (await ctx.ui.input("Which file?", "e.g. data/pressure.csv"))?.trim();
	if (!path) return null;
	const text = (await ctx.ui.input(`Text ${path} should contain afterwards`, "e.g. pressure_kpa"))?.trim();
	return text ? { type: "file-contains", path, text } : null;
}
