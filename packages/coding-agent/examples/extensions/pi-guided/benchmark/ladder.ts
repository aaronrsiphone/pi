/**
 * Benchmark ladders: tasks the user already knows the answers to, from easy to a real task.
 *
 * A ladder is a JSON file. Each task records the prompt, the files it needs, the careful level it
 * runs at, and how its result is judged. The user grades every run; optional checks (expected text,
 * file contents, a command's exit code) are shown next to the answer so grading is quick.
 *
 * `parseLadder` is the trust boundary for files on disk, including ladders shared in a project.
 */

import { type CarefulLevel, parseLevel } from "../careful/levels.ts";

export type TaskKind = "answer-from-file" | "find" | "small-edit" | "multi-step" | "real";

export type Check =
	/** The final answer contains this text (case-insensitive). */
	| { type: "answer-contains"; text: string }
	/** A file in the run's folder contains this text after the run. */
	| { type: "file-contains"; path: string; text: string }
	/** A file in the run's folder is exactly as it was before the run. */
	| { type: "file-unchanged"; path: string }
	/** A command run in the run's folder after the run exits with this code. */
	| { type: "command"; command: string; exitCode: number };

export interface LadderTask {
	/** Stable id within the ladder, so runs of an edited ladder still compare. */
	id: string;
	title: string;
	kind: TaskKind;
	prompt: string;
	/** Files the task needs, relative to the folder. At careful level 1 they are attached to the prompt. */
	files: string[];
	level: CarefulLevel;
	/** How the user judges the result, in their own words. */
	judge: string;
	checks: Check[];
}

export interface Ladder {
	version: 1;
	name: string;
	description: string;
	/**
	 * Files the ladder brings with it, path to content. When present, every run starts from these
	 * files alone; otherwise it starts from a copy of the project folder.
	 */
	files: Record<string, string> | undefined;
	tasks: LadderTask[];
}

/** The five steps of a ladder, with what each kind of task is and an example for a scientist. */
export const TASK_KINDS: readonly { kind: TaskKind; label: string; example: string; level: CarefulLevel }[] = [
	{
		kind: "answer-from-file",
		label: "Answer from a file I share",
		example: "What's the sample rate in this header?",
		level: 1,
	},
	{ kind: "find", label: "Find something in a folder", example: "Which script makes figure 3?", level: 2 },
	{ kind: "small-edit", label: "Small edit", example: "Change the units in this column from psi to kPa.", level: 3 },
	{
		kind: "multi-step",
		label: "Multi-step",
		example: "Write a script to plot this CSV, run it, and check the axis labels.",
		level: 3,
	},
	{
		kind: "real",
		label: "A real task",
		example: "Something from your own work that you know the answer to.",
		level: 3,
	},
];

/** Label of a task kind, for lists and tables. */
export function kindLabel(kind: TaskKind): string {
	return TASK_KINDS.find((k) => k.kind === kind)?.label ?? kind;
}

/** Validate a ladder read from disk. Returns the ladder, or the first problem found. */
export function parseLadder(raw: unknown): { ok: true; ladder: Ladder } | { ok: false; error: string } {
	if (!isRecord(raw)) return { ok: false, error: "not a JSON object" };
	if (raw.version !== 1) return { ok: false, error: "unknown version (expected 1)" };
	if (typeof raw.name !== "string" || !raw.name.trim()) return { ok: false, error: "missing name" };
	if (!Array.isArray(raw.tasks)) return { ok: false, error: "missing tasks" };
	let files: Record<string, string> | undefined;
	if (raw.files !== undefined) {
		if (!isRecord(raw.files) || Object.values(raw.files).some((v) => typeof v !== "string")) {
			return { ok: false, error: "files must map paths to text" };
		}
		const unsafe = Object.keys(raw.files).find((path) => !isInsidePath(path));
		if (unsafe) return { ok: false, error: `file path ${unsafe} leaves the ladder's folder` };
		files = raw.files as Record<string, string>;
	}
	const tasks: LadderTask[] = [];
	for (const [i, item] of raw.tasks.entries()) {
		const task = parseTask(item);
		if (typeof task === "string") return { ok: false, error: `task ${i + 1}: ${task}` };
		if (tasks.some((t) => t.id === task.id)) return { ok: false, error: `task ${i + 1}: duplicate id ${task.id}` };
		tasks.push(task);
	}
	return {
		ok: true,
		ladder: {
			version: 1,
			name: raw.name.trim(),
			description: typeof raw.description === "string" ? raw.description : "",
			files,
			tasks,
		},
	};
}

function parseTask(raw: unknown): LadderTask | string {
	if (!isRecord(raw)) return "not an object";
	const kinds = TASK_KINDS.map((k) => k.kind);
	if (typeof raw.id !== "string" || !raw.id) return "missing id";
	if (typeof raw.prompt !== "string" || !raw.prompt.trim()) return "missing prompt";
	if (!kinds.includes(raw.kind as TaskKind)) return `kind must be one of ${kinds.join(", ")}`;
	const level = parseLevel(raw.level);
	if (level === undefined) return "level must be 1 to 4";
	const files = raw.files ?? [];
	if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !isInsidePath(f))) {
		return "files must be paths inside the folder";
	}
	const checks: Check[] = [];
	for (const check of Array.isArray(raw.checks) ? raw.checks : []) {
		const parsed = parseCheck(check);
		if (typeof parsed === "string") return parsed;
		checks.push(parsed);
	}
	return {
		id: raw.id,
		title: typeof raw.title === "string" && raw.title ? raw.title : raw.prompt.slice(0, 60),
		kind: raw.kind as TaskKind,
		prompt: raw.prompt,
		files: files as string[],
		level,
		judge: typeof raw.judge === "string" ? raw.judge : "",
		checks,
	};
}

function parseCheck(raw: unknown): Check | string {
	if (!isRecord(raw)) return "check is not an object";
	switch (raw.type) {
		case "answer-contains":
			return typeof raw.text === "string" && raw.text
				? { type: raw.type, text: raw.text }
				: "answer-contains needs text";
		case "file-contains":
			return typeof raw.path === "string" && isInsidePath(raw.path) && typeof raw.text === "string"
				? { type: raw.type, path: raw.path, text: raw.text }
				: "file-contains needs a path inside the folder and text";
		case "file-unchanged":
			return typeof raw.path === "string" && isInsidePath(raw.path)
				? { type: raw.type, path: raw.path }
				: "file-unchanged needs a path inside the folder";
		case "command":
			return typeof raw.command === "string" && raw.command && Number.isInteger(raw.exitCode ?? 0)
				? { type: raw.type, command: raw.command, exitCode: (raw.exitCode as number | undefined) ?? 0 }
				: "command needs a command and an integer exitCode";
		default:
			return `unknown check type ${String(raw.type)}`;
	}
}

/** A relative path that stays inside its folder: no absolute paths, no `..` segments. */
function isInsidePath(path: string): boolean {
	return path !== "" && !/^([/\\]|[A-Za-z]:)/.test(path) && !path.split(/[/\\]/).includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
