/**
 * The approval question at careful levels, in plain language.
 *
 * Pure: builds the dialog text and choices from a gate request, so the wording can be tested
 * without a UI. Newcomers get four choices and no rules: at level 3 every change asks, every time.
 */

import type { CommandAnalysis, PathAccess } from "./classify.ts";
import type { GateRequest } from "./policy.ts";
import { Risk } from "./risk.ts";

export type PlainAction = "yes" | "no" | "no-reason" | "chat";

export interface PlainOption {
	label: string;
	action: PlainAction;
}

export interface PlainPrompt {
	/** First line of the dialog. */
	title: string;
	/** What the call does, one item per line. */
	description: string;
	options: PlainOption[];
}

export const PLAIN_OPTIONS: readonly PlainOption[] = [
	{ label: "Yes, do it", action: "yes" },
	{ label: "No", action: "no" },
	{ label: "No, and tell it what to do instead...", action: "no-reason" },
	{ label: "Let's talk about it first", action: "chat" },
];

const RISK_WORDS: Record<Risk, string> = {
	[Risk.safe]: "Safe: it only looks.",
	[Risk.low]: "Low risk: a small change inside this project.",
	[Risk.medium]: "Medium risk: check what it changes before you say yes.",
	[Risk.high]: "High risk: read it carefully. It could lose work or reach outside this project.",
	[Risk.critical]: "Dangerous: this can damage your computer or leak private data.",
};

/** Build the approval question for `request`. */
export function buildPlainPrompt(request: GateRequest): PlainPrompt {
	const top = request.analyses.reduce<Risk>((risk, a) => (a.risk > risk ? a.risk : risk), Risk.safe);
	const lines: string[] = [clip(request.summary, 400), ""];
	const effects = [...new Set(request.analyses.flatMap(describeEffects))];
	if (effects.length > 0) {
		lines.push("What this does:");
		for (const effect of effects.slice(0, 8)) lines.push(`  - ${effect}`);
		if (effects.length > 8) lines.push(`  - and ${effects.length - 8} more`);
		lines.push("");
	}
	if (request.issues.length > 0) {
		lines.push("Pi could not fully work out what this command does, so it asks to be safe.", "");
	}
	lines.push(RISK_WORDS[top]);
	return { title: titleFor(request), description: lines.join("\n"), options: [...PLAIN_OPTIONS] };
}

function titleFor(request: GateRequest): string {
	if (request.tool === "bash" || request.tool === "powershell") return "Pi wants to run a command";
	if (request.tool === "file:write") return "Pi wants to change a file";
	if (request.tool === "file:read") return "Pi wants to read a private file";
	return `Pi wants to use the ${request.toolName} tool`;
}

/** Plain sentences for what one command touches, falling back to the classifier's reasons. */
function describeEffects(analysis: CommandAnalysis): string[] {
	const out = analysis.paths.filter((p) => p.access !== "read" || p.risk > Risk.safe).map(describePath);
	for (const reason of analysis.reasons) out.push(reason);
	if (out.length === 0 && analysis.risk > Risk.safe) out.push(`runs ${analysis.key}`);
	return out;
}

function describePath(path: PathAccess): string {
	const where = path.display === "." ? "this whole project folder" : path.display;
	if (path.access === "delete") return `deletes ${where}`;
	if (path.access === "write") return `creates or changes ${where}`;
	return `reads ${where}`;
}

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}
