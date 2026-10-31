/**
 * The approval question at careful level 3, in plain language.
 *
 * `describeCall` and `answerToResult` are pure, so the wording and the effect of every answer can be
 * tested without a UI. `askApproval` puts them together; the benchmark extension uses it for its own
 * runs at level 3, so a benchmark asks exactly the way a normal session does.
 */

import { existsSync } from "node:fs";
import type { ExtensionUIContext, ToolCallEventResult } from "../../core/extensions/types.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";

export type ApprovalAction = "yes" | "no" | "no-reason" | "chat";

export interface ApprovalOption {
	label: string;
	action: ApprovalAction;
}

export interface ApprovalQuestion {
	/** First line of the dialog. */
	title: string;
	/** What the call does, one item per line. */
	description: string;
	/** One line naming the call, for messages to the model. */
	summary: string;
}

export const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
	{ label: "Yes, do it", action: "yes" },
	{ label: "No", action: "no" },
	{ label: "No, and tell it what to do instead...", action: "no-reason" },
	{ label: "Let's talk about it first", action: "chat" },
];

/** Describe a tool call for the user: what it changes or runs, from its name and arguments. */
export function describeCall(toolName: string, input: Record<string, unknown>, cwd: string): ApprovalQuestion {
	const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
	if (toolName === "bash" || toolName === "powershell") {
		const command = text("command");
		return {
			title: "Pi wants to run a command",
			description: [
				clip(command, 600, false),
				"",
				"A command can create, change or delete files. Say yes only if you know what it does.",
			].join("\n"),
			summary: `the command ${clip(command, 200)}`,
		};
	}
	if (toolName === "write") {
		const path = text("path");
		const exists = path !== "" && existsSync(resolveToCwd(path, cwd));
		const lines = text("content").split("\n").length;
		return {
			title: exists ? "Pi wants to replace a file" : "Pi wants to create a file",
			description: [
				path,
				"",
				exists
					? `Replaces everything in this file with ${lines} new line(s). The old contents are lost.`
					: `Creates a new file with ${lines} line(s).`,
			].join("\n"),
			summary: `${exists ? "replacing" : "creating"} ${path}`,
		};
	}
	if (toolName === "edit") {
		const path = text("path");
		const edits = Array.isArray(input.edits) ? (input.edits as { oldText?: unknown; newText?: unknown }[]) : [];
		const lines = [path, "", `Changes ${edits.length} place(s) in this file:`];
		for (const edit of edits.slice(0, 3)) {
			lines.push(`  - ${clip(String(edit.oldText ?? ""), 120)}`, `  + ${clip(String(edit.newText ?? ""), 120)}`);
		}
		if (edits.length > 3) lines.push(`  and ${edits.length - 3} more`);
		return { title: "Pi wants to change a file", description: lines.join("\n"), summary: `changing ${path}` };
	}
	const args = clip(safeJson(input), 400);
	return {
		title: `Pi wants to use the ${toolName} tool`,
		description: [args, "", "Pi cannot tell what this tool changes. Say yes only if you know what it does."].join(
			"\n",
		),
		summary: `the ${toolName} tool`,
	};
}

/** What the agent is told after each answer. `reason` is the text typed for "tell it what to do instead". */
export function answerToResult(
	action: ApprovalAction | undefined,
	question: ApprovalQuestion,
	toolName: string,
	reason?: string,
): ToolCallEventResult | undefined {
	const what = question.summary;
	switch (action) {
		case "yes":
			return undefined;
		case "no-reason":
			return {
				block: true,
				reason: `The user said no to ${what}.${reason ? ` They said: ${reason}` : ""} Do not retry the same ${toolName} call; follow what they said.`,
			};
		case "chat":
			return {
				block: true,
				terminate: true,
				reason: `The user wants to talk before ${what}. It was not done and the turn has ended. When they reply, explain what you wanted to do and why, and continue only after they agree.`,
			};
		case "no":
			return {
				block: true,
				reason: `The user said no to ${what}. Do not retry it; choose a different approach or ask them.`,
			};
		case undefined:
			return {
				block: true,
				reason: `The approval question for ${what} was closed without an answer. Do not retry it on your own; ask the user how to continue.`,
			};
	}
}

/** Ask the user about one tool call. Without a UI the call is blocked, since nobody can approve it. */
export async function askApproval(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
	ui: Pick<ExtensionUIContext, "select" | "input"> | undefined,
	signal?: AbortSignal,
): Promise<ToolCallEventResult | undefined> {
	const question = describeCall(toolName, input, cwd);
	if (!ui) {
		return {
			block: true,
			reason: `Careful level 3 needs the user's approval for ${question.summary}, and no interactive UI is available to ask.`,
		};
	}
	const label = await ui.select(
		`${question.title}\n\n${question.description}`,
		APPROVAL_OPTIONS.map((o) => o.label),
		signal ? { signal } : undefined,
	);
	const action = APPROVAL_OPTIONS.find((o) => o.label === label)?.action;
	const reason =
		action === "no-reason"
			? await ui.input("What should it do instead?", "e.g. save the result as a new file")
			: undefined;
	return answerToResult(action, question, toolName, reason);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Cut long text for a dialog; `oneLine` folds whitespace so a summary stays on one line. */
function clip(text: string, max: number, oneLine = true): string {
	const shown = oneLine ? text.replace(/\s+/g, " ").trim() : text.trim();
	return shown.length > max ? `${shown.slice(0, max - 3)}...` : shown;
}
