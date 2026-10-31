/**
 * Prompt construction. Pure: builds the dialog text and options from a decision and the learner's
 * insights, so the option set can be tested without a UI.
 */

import type { CommandAnalysis } from "./classify.ts";
import { type Candidate, defaultAlwaysCandidate, type Insight, sessionCandidate } from "./learner.ts";
import { describeRule, type GateRequest, type Match } from "./policy.ts";
import { RISK_NAMES, Risk } from "./risk.ts";

export type PromptAction = "once" | "session" | "project" | "global" | "deny" | "deny-reason" | "deny-always" | "chat";

export interface PromptOption {
	label: string;
	action: PromptAction;
	/** One candidate per pending analysis (same order) for rule-creating actions. */
	candidates?: Candidate[];
}

export interface Prompt {
	title: string;
	description: string;
	options: PromptOption[];
}

const MAX_LABEL = 110;

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function joinLabels(candidates: Candidate[]): string {
	return clip([...new Set(candidates.map((c) => c.label))].join(" + "), MAX_LABEL);
}

function sameRules(a: Candidate[], b: Candidate[]): boolean {
	const sig = (c: Candidate) => `${c.command ?? ""}|${(c.paths ?? []).join(",")}`;
	return a.length === b.length && a.every((c, i) => sig(c) === sig(b[i]));
}

function formatAnalysis(a: CommandAnalysis, marker: string): string[] {
	const lines = [
		`  ${marker} [${RISK_NAMES[a.risk]}] ${clip(a.key === a.text ? a.key : `${a.key}  —  ${a.text}`, 140)}`,
	];
	for (const reason of a.reasons.slice(0, 3)) lines.push(`      ${reason}`);
	const touched = a.paths.filter((p) => p.access !== "read" || p.risk > Risk.safe);
	if (touched.length > 0) {
		const shown = touched.slice(0, 6).map((p) => `${p.access} ${p.display}`);
		if (touched.length > 6) shown.push(`+${touched.length - 6} more`);
		lines.push(`      ${shown.join(", ")}`);
	}
	return lines;
}

function formatMatch(m: Match): string {
	const by = m.by === "safe" ? "auto" : `${m.by.scope} rule: ${describeRule(m.by)}`;
	return `  ok [${RISK_NAMES[m.analysis.risk]}] ${clip(m.analysis.key, 80)}  (${by})`;
}

export function buildPrompt(
	request: GateRequest,
	pending: CommandAnalysis[],
	matches: Match[],
	insights: Insight[],
	options: { allowGlobal: boolean },
): Prompt {
	const top: Risk = pending.reduce<Risk>((r, a) => (a.risk > r ? a.risk : r), Risk.safe);
	const critical = top >= Risk.critical || pending.some((a) => !a.learnable);
	const title = `${request.toolName} needs approval (${RISK_NAMES[top]} risk)`;

	const lines: string[] = [clip(request.summary, 600), ""];
	lines.push("Needs approval:");
	for (const a of pending) lines.push(...formatAnalysis(a, "?"));
	if (matches.length > 0) {
		lines.push("", "Already allowed:");
		for (const m of matches.slice(0, 8)) lines.push(formatMatch(m));
		if (matches.length > 8) lines.push(`  +${matches.length - 8} more`);
	}
	if (request.issues.length > 0) lines.push("", `Could not fully analyze: ${request.issues.join("; ")}`);
	const prior = insights.reduce((n, i) => n + i.priorApprovals, 0);
	if (prior > 0) lines.push("", `You approved ${prior === 1 ? "this once" : `this ${prior} times`} before.`);
	const learnedFrom = insights.flatMap((i) => i.suggestions).find((s) => s.support > 0);
	if (learnedFrom)
		lines.push(
			`Suggested from ${learnedFrom.support} past approval${learnedFrom.support === 1 ? "" : "s"}: ${learnedFrom.label}`,
		);

	const out: PromptOption[] = [{ label: "Allow once", action: "once" }];
	if (!critical) {
		const session = pending.map((a) => sessionCandidate(request.tool, a));
		out.push({ label: `Allow for this session: ${joinLabels(session)}`, action: "session", candidates: session });

		const defaults = pending.map((a) => defaultAlwaysCandidate(request.tool, a));
		const suggested = defaults.map((d, i) => insights[i]?.suggestions[0] ?? d);
		const hasSuggestion = !sameRules(suggested, defaults);
		out.push({
			label: `Always allow in this project: ${joinLabels(defaults)}`,
			action: "project",
			candidates: defaults,
		});
		if (hasSuggestion) {
			out.push({
				label: `Always allow in this project: ${joinLabels(suggested)} (learned)`,
				action: "project",
				candidates: suggested,
			});
		}
		const globalOk =
			options.allowGlobal &&
			request.tool === "bash" &&
			top <= Risk.low &&
			defaults.every((c) => c.paths === undefined);
		if (globalOk)
			out.push({
				label: `Always allow in all projects: ${joinLabels(defaults)}`,
				action: "global",
				candidates: defaults,
			});
	}
	out.push({ label: "Deny", action: "deny" });
	out.push({ label: "Deny and tell the agent why...", action: "deny-reason" });
	if (insights.some((i) => i.suggestDeny)) {
		out.push({
			label: `Always deny in this project: ${clip(pending.map((a) => a.key).join(" + "), MAX_LABEL)}`,
			action: "deny-always",
		});
	}
	out.push({ label: "Let's chat about this", action: "chat" });

	// select() returns the label; make labels unique.
	const seen = new Set<string>();
	for (const option of out) {
		let label = option.label;
		for (let n = 2; seen.has(label); n++) label = `${option.label} (${n})`;
		option.label = label;
		seen.add(label);
	}
	return { title, description: lines.join("\n"), options: out };
}
