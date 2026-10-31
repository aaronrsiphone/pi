/**
 * Rules and the decision engine.
 *
 * A rule allows or denies calls by tool, command key prefix, and path globs, up to a risk ceiling.
 * The engine is pure: given analyzed calls and rules, it returns allow, deny, or ask, and which
 * commands still need approval. All I/O lives in store.ts and index.ts.
 */

import type { CommandAnalysis } from "./classify.ts";
import { matchGlob } from "./paths.ts";
import { RISK_NAMES, Risk } from "./risk.ts";

export type RuleScope = "session" | "project" | "global";
export type RuleEffect = "allow" | "deny";
/** user: chosen in a prompt or command; learned: promoted automatically; repo: from .pi/permissions.json; legacy: imported whitelist. */
export type RuleSource = "user" | "learned" | "repo" | "legacy";

/** Tool namespaces: "bash", "file:write" (write and edit), "file:read", or a custom tool name. */
export type ToolKind = string;

export interface Rule {
	id: string;
	effect: RuleEffect;
	tool: ToolKind;
	/** Token prefix of the command key ("npm run" matches "npm run test"); "*" or absent matches all. */
	command?: string;
	/** Every written, deleted, or risky-read path must match one of these globs. */
	paths?: string[];
	/** Highest risk an allow rule covers. Ignored for deny rules. */
	maxRisk: Risk;
	scope: RuleScope;
	source: RuleSource;
	note?: string;
	createdAt: number;
	lastUsedAt?: number;
	hits: number;
}

export interface GateRequest {
	tool: ToolKind;
	/** Original tool name, for messages. */
	toolName: string;
	analyses: CommandAnalysis[];
	/** Parser issues: constructs we could not analyze. Forces a prompt. */
	issues: string[];
	/** One-line description of the call for prompts and logs. */
	summary: string;
}

export interface Match {
	analysis: CommandAnalysis;
	/** The rule that allowed it, or "safe" when its risk is within the auto-allow threshold. */
	by: Rule | "safe";
}

export type Decision =
	| { action: "allow"; matches: Match[] }
	| { action: "deny"; rule: Rule; analysis: CommandAnalysis }
	| { action: "ask"; pending: CommandAnalysis[]; matches: Match[]; reason: string };

function tokens(text: string): string[] {
	return text.trim().split(/\s+/).filter(Boolean);
}

/** True if `prefix` is a whole-token prefix of `key`: "npm run" covers "npm run test", not "npm runner". */
export function commandCovers(prefix: string | undefined, key: string): boolean {
	if (prefix === undefined || prefix === "*" || prefix === "") return true;
	const p = tokens(prefix);
	const k = tokens(key);
	if (p.length > k.length) return false;
	return p.every((t, i) => t === k[i]);
}

/** Glob match for rule paths. `dir/**` also matches `dir` itself. */
export function pathCovered(globs: string[], display: string): boolean {
	return globs.some((glob) => {
		if (glob === "**")
			return (
				!display.startsWith("/") &&
				!display.startsWith("~") &&
				!display.startsWith("$") &&
				!display.startsWith("..")
			);
		if (glob.endsWith("/**") && display === glob.slice(0, -3)) return true;
		return matchGlob(glob, display);
	});
}

export function ruleMatches(rule: Rule, tool: ToolKind, analysis: CommandAnalysis): boolean {
	if (rule.tool !== tool && rule.tool !== "*") return false;
	if (!commandCovers(rule.command, analysis.key)) return false;
	if (rule.effect === "allow") {
		if (analysis.risk > rule.maxRisk) return false;
		if (!analysis.learnable) return false;
	}
	const relevant = analysis.paths.filter((p) => p.access !== "read" || p.risk > Risk.safe);
	if (rule.effect === "allow" && (!rule.paths || rule.paths.length === 0)) {
		// A rule without paths covers only project paths and low-risk ones (temp dirs). Touching
		// anything else outside the project needs a rule that names the path.
		if (relevant.some((p) => p.path.rel === undefined && p.risk > Risk.low)) return false;
	}
	if (rule.paths && rule.paths.length > 0) {
		if (rule.effect === "deny") return relevant.some((p) => pathCovered(rule.paths!, p.display));
		for (const p of relevant) {
			if (p.path.dynamic) return false;
			if (!pathCovered(rule.paths, p.display)) return false;
		}
	}
	return true;
}

const SCOPE_ORDER: Record<RuleScope, number> = { session: 0, project: 1, global: 2 };

/**
 * Decide one call.
 *
 * Order: any matching deny rule denies; otherwise each command must be within `autoAllowRisk` or
 * matched by an allow rule; critical commands and parser issues always ask.
 */
export function decide(request: GateRequest, rules: Rule[], autoAllowRisk: Risk): Decision {
	for (const analysis of request.analyses) {
		const deny = rules.find((r) => r.effect === "deny" && ruleMatches(r, request.tool, analysis));
		if (deny) return { action: "deny", rule: deny, analysis };
	}

	const allowRules = rules
		.filter((r) => r.effect === "allow")
		.sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
	const matches: Match[] = [];
	const pending: CommandAnalysis[] = [];
	for (const analysis of request.analyses) {
		if (analysis.risk >= Risk.critical) {
			pending.push(analysis);
			continue;
		}
		if (analysis.risk <= autoAllowRisk) {
			matches.push({ analysis, by: "safe" });
			continue;
		}
		const rule = allowRules.find((r) => ruleMatches(r, request.tool, analysis));
		if (rule) matches.push({ analysis, by: rule });
		else pending.push(analysis);
	}

	if (request.issues.length > 0) {
		return {
			action: "ask",
			pending: pending.length > 0 ? pending : request.analyses,
			matches,
			reason: `could not fully analyze the command (${request.issues.join("; ")})`,
		};
	}
	if (pending.length === 0) return { action: "allow", matches };
	const top = pending.reduce((a, b) => (b.risk > a.risk ? b : a));
	return {
		action: "ask",
		pending,
		matches,
		reason: `${top.key} is ${RISK_NAMES[top.risk]} risk${top.reasons[0] ? `: ${top.reasons[0]}` : ""}`,
	};
}

export function describeRule(rule: Rule): string {
	const what =
		rule.tool === "bash"
			? rule.command && rule.command !== "*"
				? rule.command
				: "any command"
			: rule.tool === "file:write"
				? "write"
				: rule.tool === "file:read"
					? "read"
					: rule.tool;
	const where = rule.paths && rule.paths.length > 0 ? ` in ${rule.paths.join(", ")}` : "";
	const ceiling = rule.effect === "allow" ? ` (up to ${RISK_NAMES[rule.maxRisk]})` : "";
	return `${rule.effect} ${what}${where}${ceiling}`;
}

let idCounter = 0;
export function newRuleId(): string {
	idCounter = (idCounter + 1) % 1_000_000;
	return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Stable identity of a rule's matching behavior, for dedupe and vetoes. */
export function ruleSignature(rule: Pick<Rule, "effect" | "tool" | "command" | "paths">): string {
	return [rule.effect, rule.tool, rule.command ?? "*", (rule.paths ?? []).slice().sort().join(",")].join("|");
}

export function validateRule(value: unknown): Rule | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const r = value as Record<string, unknown>;
	if (r.effect !== "allow" && r.effect !== "deny") return undefined;
	if (typeof r.tool !== "string" || r.tool.length === 0) return undefined;
	if (r.command !== undefined && typeof r.command !== "string") return undefined;
	if (r.paths !== undefined && (!Array.isArray(r.paths) || !r.paths.every((p) => typeof p === "string")))
		return undefined;
	const maxRisk =
		typeof r.maxRisk === "number" && r.maxRisk >= 0 && r.maxRisk <= 3 ? (Math.floor(r.maxRisk) as Risk) : Risk.medium;
	const scope = r.scope === "session" || r.scope === "global" ? r.scope : "project";
	const source = r.source === "learned" || r.source === "repo" || r.source === "legacy" ? r.source : "user";
	return {
		id: typeof r.id === "string" ? r.id : newRuleId(),
		effect: r.effect,
		tool: r.tool,
		command: r.command as string | undefined,
		paths: r.paths as string[] | undefined,
		// Critical is never allowable by rule; clamp.
		maxRisk: maxRisk > Risk.high ? Risk.high : maxRisk,
		scope,
		source,
		note: typeof r.note === "string" ? r.note : undefined,
		createdAt: typeof r.createdAt === "number" ? r.createdAt : Date.now(),
		lastUsedAt: typeof r.lastUsedAt === "number" ? r.lastUsedAt : undefined,
		hits: typeof r.hits === "number" ? r.hits : 0,
	};
}
