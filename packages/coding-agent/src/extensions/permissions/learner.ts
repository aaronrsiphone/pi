/**
 * The learner: turns the decision log into fewer prompts.
 *
 * For each call that needs approval it builds a ladder of candidate rules, from exactly this call to
 * progressively broader patterns:
 *
 *   rm on node_modules  ->  rm in node_modules/**  ->  rm (project paths)  ->  (family)
 *   write src/a/b.ts    ->  src/a/**  ->  src/**  ->  **\/*.ts  ->  ** (ordinary project files)
 *   npm run test        ->  npm run (any script)
 *
 * It then counts evidence in the log: how many distinct calls the user approved that each candidate
 * would also cover, how many it would have covered that the user denied, and in how many distinct
 * sessions the user granted it "for this session".
 *
 *  - Suggest: a broader candidate with enough approvals and no denials is offered as an extra
 *    "always allow" choice in the prompt.
 *  - Promote: with more evidence, low risk (configurable), and no veto, it becomes a learned rule
 *    and the call runs without a prompt. The user is notified and can remove it; removal is a veto
 *    the learner never overrides.
 *  - Session habit: granting the same thing for a session in several sessions promotes it to a
 *    project rule (up to medium risk by default).
 *
 * Every candidate keeps a risk ceiling equal to the highest risk among the approvals it learned
 * from, so learning `git` from `git add`/`git commit` never covers `git push --force`.
 */

import { dirname, extname } from "node:path";
import type { CommandAnalysis } from "./classify.ts";
import { commandCovers, pathCovered, type Rule, ruleSignature, type ToolKind } from "./policy.ts";
import { maxRisk, RISK_NAMES, Risk } from "./risk.ts";
import type { Choice, DecisionEvent, LearningConfig } from "./store.ts";

export interface Candidate {
	tool: ToolKind;
	command: string | undefined;
	paths: string[] | undefined;
	label: string;
	/** 0 = exactly this call; higher = broader. */
	breadth: number;
	/** Broad enough that auto-promotion is never allowed for it, only an explicit choice. */
	explicitOnly: boolean;
	/** Covers calls other than this exact one (other paths or subcommands). Needs varied evidence. */
	generalizes: boolean;
	/** Filled in by `evaluate`. */
	ceiling: Risk;
	/** Approvals this candidate would have covered. */
	support: number;
	/** Distinct approved calls (key + paths) among them. */
	diversity: number;
	denials: number;
	sessions: number;
}

export interface Insight {
	/** Broader candidates with enough evidence, best first. */
	suggestions: Candidate[];
	/** Candidate to promote now, if any. */
	promote: (Candidate & { why: string }) | undefined;
	/** The user denied this exact thing repeatedly; offer "always deny". */
	suggestDeny: boolean;
	/** Distinct prior approvals of exactly this key. */
	priorApprovals: number;
}

const APPROVALS = new Set<Choice>(["once", "session", "project", "global"]);
const DENIALS = new Set<Choice>(["deny", "deny-always", "chat"]);

function isOutside(display: string): boolean {
	return display.startsWith("/") || display.startsWith("~") || display.startsWith("$") || /^[a-zA-Z]:\\/.test(display);
}

function relevantPaths(analysis: CommandAnalysis): string[] {
	return analysis.paths.filter((p) => p.access !== "read" || p.risk > Risk.safe).map((p) => p.display);
}

/** Directory glob for a display path: `src/a.ts` -> `src/**`; `node_modules` -> `node_modules/**`. */
function dirGlob(display: string): string {
	const dir = dirname(display);
	if (dir === "." || dir === "") return `${display}/**`;
	if (dir === "/" || dir === "~") return display;
	return `${dir}/**`;
}

function topGlob(display: string): string | undefined {
	if (isOutside(display)) return undefined;
	const first = display.split("/")[0];
	return display.includes("/") ? `${first}/**` : undefined;
}

function uniq<T>(items: T[], key: (item: T) => string): T[] {
	const seen = new Set<string>();
	return items.filter((item) => {
		const k = key(item);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function blank(
	tool: ToolKind,
	command: string | undefined,
	paths: string[] | undefined,
	label: string,
	breadth: number,
	options: { explicitOnly?: boolean; generalizes?: boolean } = {},
): Candidate {
	return {
		tool,
		command,
		paths,
		label,
		breadth,
		explicitOnly: options.explicitOnly ?? false,
		generalizes: options.generalizes ?? breadth > 0,
		ceiling: Risk.safe,
		support: 0,
		diversity: 0,
		denials: 0,
		sessions: 0,
	};
}

/** Candidate rules covering this call, most specific first. */
export function candidatesFor(tool: ToolKind, analysis: CommandAnalysis): Candidate[] {
	const paths = relevantPaths(analysis);
	const out: Candidate[] = [];
	const anyDynamic = analysis.paths.some((p) => p.path.dynamic && (p.access !== "read" || p.risk > Risk.safe));

	if (tool === "bash") {
		const key = analysis.key;
		const family = analysis.family;
		if (paths.length > 0 && !anyDynamic) {
			out.push(
				blank(
					tool,
					key,
					uniq(paths, (p) => p),
					`${key} on ${paths.join(", ")}`,
					0,
				),
			);
			const dirs = uniq(paths.map(dirGlob), (p) => p);
			out.push(blank(tool, key, dirs, `${key} in ${dirs.join(", ")}`, 1));
		}
		// Path-free rules would cover any path up to the ceiling; never offer them for outside paths.
		if (!paths.some(isOutside) && !anyDynamic) {
			out.push(
				blank(tool, key, undefined, paths.length > 0 ? `${key} (any project path)` : key, 2, {
					generalizes: paths.length > 0,
				}),
			);
			if (family !== key && commandCovers(family, key))
				out.push(blank(tool, family, undefined, `${family} (any subcommand)`, 3));
		} else if (anyDynamic) {
			out.push(blank(tool, key, undefined, key, 2, { explicitOnly: true }));
		}
	} else if (tool === "file:write" || tool === "file:read") {
		const verb = tool === "file:write" ? "write" : "read";
		const p = paths[0];
		if (p !== undefined && !anyDynamic) {
			out.push(blank(tool, undefined, [p], `${verb} ${p}`, 0));
			if (p.includes("/")) out.push(blank(tool, undefined, [dirGlob(p)], `${verb} ${dirGlob(p)}`, 1));
			const top = topGlob(p);
			if (top && top !== dirGlob(p)) out.push(blank(tool, undefined, [top], `${verb} ${top}`, 2));
			const ext = extname(p);
			if (!isOutside(p) && ext && ext.length <= 8)
				out.push(blank(tool, undefined, [`**/*${ext}`], `${verb} any *${ext} file`, 3, { explicitOnly: true }));
			if (!isOutside(p) && tool === "file:write")
				out.push(blank(tool, undefined, ["**"], `${verb} any ordinary project file`, 4, { explicitOnly: true }));
		}
	} else {
		out.push(blank(tool, undefined, undefined, tool, 0));
	}
	return uniq(out, (c) => `${c.command ?? ""}|${(c.paths ?? []).join(",")}`);
}

function eventCovered(candidate: Candidate, event: DecisionEvent): boolean {
	if (event.tool !== candidate.tool) return false;
	if (candidate.command !== undefined && !commandCovers(candidate.command, event.key)) return false;
	if (candidate.paths) {
		if (event.paths.length === 0) return false;
		return event.paths.every((p) => pathCovered(candidate.paths!, p));
	}
	return true;
}

export function candidateSignature(candidate: Pick<Candidate, "tool" | "command" | "paths">): string {
	return ruleSignature({ effect: "allow", tool: candidate.tool, command: candidate.command, paths: candidate.paths });
}

/** Fill evidence counts for each candidate. */
export function scoreCandidates(
	candidates: Candidate[],
	events: DecisionEvent[],
	current: CommandAnalysis,
): Candidate[] {
	return candidates.map((candidate) => {
		const instances = new Set<string>();
		const sessions = new Set<string>();
		let support = 0;
		let denials = 0;
		let ceiling: Risk = current.risk;
		for (const event of events) {
			if (!eventCovered(candidate, event)) continue;
			if (APPROVALS.has(event.choice)) {
				support++;
				instances.add(`${event.key}\u0000${event.paths.join("\u0000")}`);
				ceiling = maxRisk(ceiling, event.risk);
				if (event.choice === "session") sessions.add(event.session);
			} else if (DENIALS.has(event.choice)) {
				denials++;
			}
		}
		return {
			...candidate,
			support,
			diversity: instances.size,
			denials,
			sessions: sessions.size,
			ceiling: ceiling > Risk.high ? Risk.high : ceiling,
		};
	});
}

export function evaluate(
	tool: ToolKind,
	analysis: CommandAnalysis,
	events: DecisionEvent[],
	vetoes: string[],
	existingRules: Rule[],
	config: LearningConfig,
): Insight {
	const insight: Insight = { suggestions: [], promote: undefined, suggestDeny: false, priorApprovals: 0 };
	if (!analysis.learnable || analysis.risk >= Risk.critical) return insight;

	const relevant = events.filter((e) => e.tool === tool);
	const scored = scoreCandidates(candidatesFor(tool, analysis), relevant, analysis);
	const vetoed = new Set(vetoes);
	const existing = new Set(existingRules.map(ruleSignature));

	insight.priorApprovals = relevant.filter((e) => e.key === analysis.key && APPROVALS.has(e.choice)).length;
	const exactDenials = relevant.filter((e) => e.key === analysis.key && DENIALS.has(e.choice)).length;
	insight.suggestDeny = exactDenials >= 2 && insight.priorApprovals === 0;

	if (!config.enabled) return insight;

	const usable = scored.filter(
		(c) => c.denials === 0 && !vetoed.has(candidateSignature(c)) && !existing.has(candidateSignature(c)),
	);

	// The current call counts as one more instance when the user approves it now.
	insight.suggestions = usable
		.filter(
			(c) =>
				c.breadth > 0 &&
				c.support + 1 >= config.suggestAfter &&
				c.support >= 1 &&
				(!c.generalizes || c.diversity >= 1),
		)
		.sort((a, b) => b.breadth - a.breadth || b.support - a.support)
		.slice(0, 2);

	const promotable = usable
		.filter((c) => !c.explicitOnly && (!c.generalizes || c.diversity >= 2))
		.map((c) => {
			if (
				config.autoPromoteAfter > 0 &&
				c.support >= config.autoPromoteAfter &&
				c.ceiling <= config.autoPromoteMaxRisk
			) {
				return {
					...c,
					why: `approved ${c.support} similar ${c.support === 1 ? "call" : "calls"} (up to ${RISK_NAMES[c.ceiling]} risk)`,
				};
			}
			if (
				config.sessionPromoteAfter > 0 &&
				c.sessions >= config.sessionPromoteAfter &&
				c.ceiling <= config.sessionPromoteMaxRisk
			) {
				return { ...c, why: `allowed for the whole session in ${c.sessions} sessions` };
			}
			return undefined;
		})
		.filter((c): c is Candidate & { why: string } => c !== undefined)
		// Prefer the broadest candidate the evidence supports.
		.sort((a, b) => b.breadth - a.breadth);
	insight.promote = promotable[0];
	return insight;
}

/** Candidate used for "allow for this session": broad within the project, exact-ish outside it. */
export function sessionCandidate(tool: ToolKind, analysis: CommandAnalysis): Candidate {
	const candidates = candidatesFor(tool, analysis);
	if (tool === "bash")
		return candidates.find((c) => c.breadth === 2) ?? candidates.find((c) => c.breadth === 1) ?? candidates[0];
	if (tool === "file:write" || tool === "file:read") return candidates.find((c) => c.breadth === 1) ?? candidates[0];
	return candidates[0];
}

/** Default "always allow" candidate when the learner has nothing better: the call's key, path-scoped if needed. */
export function defaultAlwaysCandidate(tool: ToolKind, analysis: CommandAnalysis): Candidate {
	const candidates = candidatesFor(tool, analysis);
	if (tool === "bash") {
		const hasPaths = relevantPaths(analysis).length > 0;
		// Deletes and writes get path-scoped rules by default; pure commands get the key.
		return (
			(hasPaths ? candidates.find((c) => c.breadth === 1) : candidates.find((c) => c.breadth === 2)) ?? candidates[0]
		);
	}
	if (tool === "file:write" || tool === "file:read") return candidates.find((c) => c.breadth === 1) ?? candidates[0];
	return candidates[0];
}
