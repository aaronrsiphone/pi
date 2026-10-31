/**
 * Adaptive rules: the advanced permission mode for experienced users.
 *
 *   - Read-only commands run without asking. Everything else is ranked safe/low/medium/high/critical
 *     by program, arguments, and every path it touches (resolved through `cd` and symlinks).
 *   - Rules carry a risk ceiling: allowing `git push` never allows `git push --force`.
 *   - Learns from your answers: repeated approvals become broader suggestions, then (for low risk,
 *     or anything you keep allowing per session) learned rules. Removing a learned rule vetoes it.
 *   - Critical actions (sudo, deleting the project or home, curl | sh, writing the gate's own rules)
 *     always ask; no rule can approve them.
 *   - Rules live in ~/.pi/agent/permissions, outside the repo, so a cloned project cannot pre-approve
 *     itself and the agent cannot edit its own whitelist.
 *
 * Manage with /permissions (rules, stats, settings, explain a command, import the old whitelist).
 * The same runtime (store, path environment) serves the careful levels in index.ts.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";
import { analyzeBash, analyzeFileAccess, type CommandAnalysis } from "./classify.ts";
import { type Candidate, candidatesFor, evaluate, type Insight } from "./learner.ts";
import { type PathEnv, pathRisk, resolvePath, toPosix } from "./paths.ts";
import {
	type Decision,
	decide,
	describeRule,
	type GateRequest,
	newRuleId,
	type Rule,
	type RuleScope,
	validateRule,
} from "./policy.ts";
import { buildPrompt, type PromptAction } from "./prompt.ts";
import { buildRequest } from "./request.ts";
import { maxRisk, parseRisk, RISK_NAMES, Risk } from "./risk.ts";
import { type Choice, type Config, type CounterKey, Store } from "./store.ts";

const GRANT_ENTRY = "adaptive-permissions:grant";
const REVOKE_ENTRY = "adaptive-permissions:revoke";
const STATUS_KEY = "permissions";
export const REPO_RULES_FILE = join(".pi", "permissions.json");
const LEGACY_FILE = join(".pi", "permission-whitelist.json");

export interface PermissionsOptions {
	/** Where rules, config, and the decision log live. Defaults to ~/.pi/agent/permissions. */
	stateDir?: string;
	home?: string;
	tempDirs?: string[];
}

/** Per-session state shared by every permission mode. */
export interface Runtime {
	root: string;
	sessionId: string;
	store: Store;
	env: PathEnv;
	sessionRules: Rule[];
	/** Serializes prompts so parallel tool calls ask one at a time and see each other's answers. */
	queue: Promise<unknown>;
	asked: number;
	auto: number;
	repoCache: { mtimeMs: number; rules: Rule[] } | undefined;
}

/** Where rules, config, and the decision log live unless options say otherwise. */
export function defaultStateDir(): string {
	return join(getAgentDir(), "permissions");
}

/** The adaptive gate plus the runtime the careful levels reuse. */
export interface AdaptiveGate {
	/** State for the session in `ctx`: store, path environment, session grants. */
	runtime(ctx: ExtensionContext): Runtime;
	/** Decide a tool call with rules and learning, asking the user when needed. */
	handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined>;
}

/** Register the adaptive gate's lifecycle handlers and commands; the caller routes `tool_call`. */
export function createAdaptiveGate(pi: ExtensionAPI, options: PermissionsOptions = {}): AdaptiveGate {
	const stateDir = options.stateDir ?? defaultStateDir();
	const home = options.home ?? homedir();
	const tempDirs = options.tempDirs ?? [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/tmp"])];
	let runtime: Runtime | undefined;

	function getRuntime(ctx: ExtensionContext): Runtime {
		const sessionId = ctx.sessionManager.getSessionId();
		if (runtime && runtime.root === ctx.cwd && runtime.sessionId === sessionId) return runtime;
		const root = ctx.cwd;
		const env: PathEnv = {
			root,
			home,
			tempDirs,
			protectedPaths: [stateDir, join(root, REPO_RULES_FILE), join(root, LEGACY_FILE)],
			platform: process.platform,
		};
		runtime = {
			root,
			sessionId,
			store: new Store(stateDir, root),
			env,
			sessionRules: restoreSessionGrants(ctx),
			queue: Promise.resolve(),
			asked: 0,
			auto: 0,
			repoCache: undefined,
		};
		return runtime;
	}

	function restoreSessionGrants(ctx: ExtensionContext): Rule[] {
		const rules = new Map<string, Rule>();
		try {
			for (const entry of ctx.sessionManager.getBranch()) {
				if (entry.type !== "custom") continue;
				if (entry.customType === GRANT_ENTRY) {
					const rule = validateRule(entry.data);
					if (rule) rules.set(rule.id, { ...rule, scope: "session", source: "user" });
				} else if (entry.customType === REVOKE_ENTRY) {
					const id = (entry.data as { id?: unknown } | undefined)?.id;
					if (typeof id === "string") rules.delete(id);
					if (id === "*") rules.clear();
				}
			}
		} catch (error) {
			console.error("[permissions] could not restore session grants:", error);
		}
		return [...rules.values()];
	}

	/** Rules from the repo's .pi/permissions.json. Deny rules always apply; allow rules only in trusted projects. */
	function repoRules(rt: Runtime, ctx: ExtensionContext, config: Config): Rule[] {
		const file = join(rt.root, REPO_RULES_FILE);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return [];
		}
		if (!rt.repoCache || rt.repoCache.mtimeMs !== mtimeMs) {
			const rules: Rule[] = [];
			try {
				const raw = JSON.parse(readFileSync(file, "utf-8")) as { rules?: unknown[] };
				for (const item of raw.rules ?? []) {
					const rule = validateRule(item);
					if (rule)
						rules.push({
							...rule,
							scope: "project",
							source: "repo",
							maxRisk: rule.maxRisk > Risk.medium ? Risk.medium : rule.maxRisk,
						});
				}
			} catch (error) {
				console.error(`[permissions] ignoring invalid ${file}:`, error);
			}
			rt.repoCache = { mtimeMs, rules };
		}
		const trusted = config.repoAllowRules && ctx.isProjectTrusted();
		return rt.repoCache.rules.filter((r) => r.effect === "deny" || trusted);
	}

	function allRules(rt: Runtime, ctx: ExtensionContext, config: Config): Rule[] {
		return [
			...rt.sessionRules,
			...rt.store.project().rules,
			...rt.store.global().rules,
			...repoRules(rt, ctx, config),
		];
	}

	const annotationsOf = (toolName: string) => pi.getAllTools().find((t) => t.name === toolName)?.annotations;
	const requestFor = (event: ToolCallEvent, rt: Runtime, config: Config) =>
		buildRequest(event, rt.env, config, annotationsOf);

	// -------------------------------------------------------------------------
	// Decision handling
	// -------------------------------------------------------------------------

	function logChoice(rt: Runtime, request: GateRequest, analyses: CommandAnalysis[], choice: Choice): void {
		for (const a of analyses) {
			rt.store.appendDecision({
				t: Date.now(),
				session: rt.sessionId,
				tool: request.tool,
				key: a.key,
				family: a.family,
				risk: a.risk,
				paths: a.paths.filter((p) => p.access !== "read" || p.risk > Risk.safe).map((p) => p.display),
				choice,
			});
		}
	}

	function setStatus(rt: Runtime, ctx: ExtensionContext, text: string | undefined): void {
		if (!ctx.hasUI) return;
		const tally = `perm: ${rt.auto} auto, ${rt.asked} asked`;
		ctx.ui.setStatus(STATUS_KEY, text ? `${tally} | ${text}` : tally);
	}

	function recordAllow(rt: Runtime, ctx: ExtensionContext, decision: Extract<Decision, { action: "allow" }>): void {
		rt.auto++;
		const ruleIds: string[] = [];
		let counter: CounterKey = "autoSafe";
		for (const m of decision.matches) {
			if (m.by === "safe") continue;
			if (m.by.scope !== "session" && m.by.source !== "repo") ruleIds.push(m.by.id);
			m.by.hits++;
			m.by.lastUsedAt = Date.now();
			counter = m.by.source === "learned" ? "autoLearned" : "autoRule";
		}
		rt.store.recordUse(ruleIds, counter);
		const first = decision.matches.find((m) => m.by !== "safe");
		setStatus(
			rt,
			ctx,
			first && first.by !== "safe" ? `${first.analysis.key} via ${first.by.source} rule` : undefined,
		);
	}

	function makeRule(
		candidate: Candidate,
		effect: "allow" | "deny",
		scope: RuleScope,
		source: Rule["source"],
		ceiling: Risk,
		note?: string,
	): Rule {
		return {
			id: newRuleId(),
			effect,
			tool: candidate.tool,
			command: candidate.command,
			paths: candidate.paths,
			maxRisk: ceiling > Risk.high ? Risk.high : ceiling,
			scope,
			source,
			note,
			createdAt: Date.now(),
			hits: 0,
		};
	}

	function grantSession(rt: Runtime, rule: Rule): void {
		rt.sessionRules.push(rule);
		try {
			pi.appendEntry(GRANT_ENTRY, rule);
		} catch (error) {
			console.error("[permissions] could not persist session grant:", error);
		}
	}

	async function handle(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const rt = getRuntime(ctx);
		const config = rt.store.config();
		const request = requestFor(event, rt, config);
		if (!request || (request.analyses.length === 0 && request.issues.length === 0)) return undefined;

		const first = decide(request, allRules(rt, ctx, config), config.autoAllowRisk);
		if (first.action === "allow") {
			recordAllow(rt, ctx, first);
			return undefined;
		}
		if (first.action === "deny") return blockByRule(rt, ctx, first);

		// Ask path: serialize, then decide again (an earlier prompt may have granted this).
		const run = rt.queue.then(() => askExclusive(rt, event, ctx));
		rt.queue = run.catch(() => undefined);
		return run;
	}

	function blockByRule(
		rt: Runtime,
		ctx: ExtensionContext,
		decision: Extract<Decision, { action: "deny" }>,
	): ToolCallEventResult {
		rt.store.recordUse([], "denied");
		setStatus(rt, ctx, `blocked ${decision.analysis.key}`);
		const note = decision.rule.note ? ` Note: ${decision.rule.note}` : "";
		return {
			block: true,
			reason: `Blocked by a ${decision.rule.scope} permission rule (${describeRule(decision.rule)}) for: ${decision.analysis.key}.${note} Do not retry this or work around it; choose a different approach or ask the user.`,
		};
	}

	async function askExclusive(
		rt: Runtime,
		event: ToolCallEvent,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> {
		const config = rt.store.config();
		const request = requestFor(event, rt, config);
		if (!request) return undefined;
		const rules = allRules(rt, ctx, config);
		const decision = decide(request, rules, config.autoAllowRisk);
		if (decision.action === "allow") {
			recordAllow(rt, ctx, decision);
			return undefined;
		}
		if (decision.action === "deny") return blockByRule(rt, ctx, decision);

		const projectFile = rt.store.project();
		const vetoes = [...projectFile.vetoes, ...rt.store.global().vetoes];
		const events = config.learning.enabled ? rt.store.decisions() : [];
		const insights: Insight[] = decision.pending.map((a) =>
			evaluate(request.tool, a, events, vetoes, rules, config.learning),
		);

		// Self-improvement: promote when every pending command has enough evidence.
		if (request.issues.length === 0 && insights.length > 0 && insights.every((i) => i.promote)) {
			const learned: string[] = [];
			for (const insight of insights) {
				const candidate = insight.promote!;
				rt.store.addRule(
					makeRule(candidate, "allow", "project", "learned", candidate.ceiling, insight.promote!.why),
				);
				learned.push(`${candidate.label} (up to ${RISK_NAMES[candidate.ceiling]}): ${candidate.why}`);
			}
			logChoice(rt, request, decision.pending, "auto");
			rt.auto++;
			rt.store.recordUse([], "autoLearned");
			if (ctx.hasUI) ctx.ui.notify(`Learned permission: ${learned.join("; ")}. Manage with /permissions.`, "info");
			setStatus(rt, ctx, `learned ${insights.map((i) => i.promote!.label).join(", ")}`);
			return undefined;
		}

		if (!ctx.hasUI) {
			if (config.headless === "allow") return undefined;
			rt.store.recordUse([], "denied");
			return {
				block: true,
				reason: `Permission required for ${decision.pending.map((a) => a.key).join(", ")} (${decision.reason}), and no interactive UI is available to ask. Run pi interactively, or add a rule with /permissions.`,
			};
		}

		rt.asked++;
		rt.store.recordUse([], "prompted");
		const prompt = buildPrompt(request, decision.pending, decision.matches, insights, { allowGlobal: true });
		setStatus(rt, ctx, `asking: ${decision.pending[0].key}`);
		const timeout = config.promptTimeoutSeconds > 0 ? config.promptTimeoutSeconds * 1000 : undefined;
		// select() has a single title; the details go in it (it renders multi-line text).
		const choiceLabel = await ctx.ui.select(
			`${prompt.title}\n\n${prompt.description}`,
			prompt.options.map((o) => o.label),
			{
				...(timeout ? { timeout } : {}),
				...(ctx.signal ? { signal: ctx.signal } : {}),
			},
		);
		const option = prompt.options.find((o) => o.label === choiceLabel);
		const action: PromptAction = option?.action ?? "deny";
		return applyChoice(rt, ctx, request, decision.pending, action, option?.candidates, choiceLabel === undefined);
	}

	async function applyChoice(
		rt: Runtime,
		ctx: ExtensionContext,
		request: GateRequest,
		pending: CommandAnalysis[],
		action: PromptAction,
		candidates: Candidate[] | undefined,
		dismissed: boolean,
	): Promise<ToolCallEventResult | undefined> {
		const keys = pending.map((a) => a.key).join(", ");
		switch (action) {
			case "once":
				logChoice(rt, request, pending, "once");
				setStatus(rt, ctx, `allowed once: ${keys}`);
				return undefined;
			case "session":
				pending.forEach((a, i) => {
					grantSession(rt, makeRule(candidates![i], "allow", "session", "user", a.risk));
				});
				logChoice(rt, request, pending, "session");
				setStatus(rt, ctx, `allowed for session: ${keys}`);
				return undefined;
			case "project":
			case "global": {
				pending.forEach((a, i) => {
					const candidate = candidates![i];
					rt.store.addRule(makeRule(candidate, "allow", action, "user", maxRisk(a.risk, candidate.ceiling)));
				});
				logChoice(rt, request, pending, action);
				setStatus(rt, ctx, `always allowed: ${keys}`);
				return undefined;
			}
			case "deny-always":
				for (const a of pending) {
					const candidate =
						candidatesFor(request.tool, a).find((c) => c.command === a.key && !c.paths) ??
						candidatesFor(request.tool, a)[0];
					rt.store.addRule(makeRule(candidate, "deny", "project", "user", Risk.safe, "denied by the user"));
				}
				logChoice(rt, request, pending, "deny-always");
				return {
					block: true,
					reason: `The user permanently denied ${keys} in this project. Do not retry it or work around it; choose a different approach.`,
				};
			case "chat":
				logChoice(rt, request, pending, "chat");
				setStatus(rt, ctx, `chat requested: ${keys}`);
				return {
					block: true,
					terminate: true,
					reason:
						`The user chose "Let's chat about this" instead of approving: ${keys}. ` +
						"The call was not executed and the turn has ended. Do not retry it on your own. " +
						"When the user replies, explain what you were about to do and why, and proceed only after they approve.",
				};
			case "deny-reason": {
				const why = await ctx.ui.input("Tell the agent why (optional)", "e.g. use pnpm instead of npm");
				logChoice(rt, request, pending, "deny");
				rt.store.recordUse([], "denied");
				return {
					block: true,
					reason: `The user denied ${keys}.${why ? ` Their reason: ${why}` : ""} Do not retry the same call; adjust your approach accordingly.`,
				};
			}
			default:
				logChoice(rt, request, pending, "deny");
				rt.store.recordUse([], "denied");
				setStatus(rt, ctx, `denied: ${keys}`);
				return {
					block: true,
					reason: dismissed
						? `The permission prompt for ${keys} was dismissed without approval. Do not retry it automatically; ask the user how to proceed.`
						: `The user denied ${keys}. Do not retry the same call; choose a different approach or ask the user.`,
				};
		}
	}

	// -------------------------------------------------------------------------
	// Events
	// -------------------------------------------------------------------------

	pi.on("session_start", (_event, ctx) => {
		runtime = undefined;
		const rt = getRuntime(ctx);
		const config = rt.store.config();
		let expired = 0;
		try {
			expired = rt.store.expireLearned(config.learning.expireUnusedDays);
		} catch (error) {
			console.error("[permissions] expiry failed:", error);
		}
		if (!ctx.hasUI) return;
		const project = rt.store.project().rules;
		const learned = project.filter((r) => r.source === "learned").length;
		const parts = [`${project.length + rt.store.global().rules.length} rules`];
		if (learned > 0) parts.push(`${learned} learned`);
		if (rt.sessionRules.length > 0) parts.push(`${rt.sessionRules.length} session grants restored`);
		if (expired > 0) parts.push(`${expired} unused learned rules expired`);
		setStatus(rt, ctx, undefined);
		if (existsSync(join(rt.root, LEGACY_FILE)) && !project.some((r) => r.source === "legacy")) {
			ctx.ui.notify(`Adaptive permissions: found ${LEGACY_FILE}. Run "/permissions import" to import it.`, "info");
		} else if (expired > 0) {
			ctx.ui.notify(`Adaptive permissions: ${parts.join(", ")}.`, "info");
		}
	});

	pi.on("turn_end", () => {
		runtime?.store.flush();
	});
	pi.on("agent_settled", () => {
		runtime?.store.flush();
	});
	pi.on("session_shutdown", () => {
		runtime?.store.flush();
		runtime = undefined;
	});

	// -------------------------------------------------------------------------
	// Commands
	// -------------------------------------------------------------------------

	pi.registerCommand("permissions", {
		description: "Manage adaptive permissions: rules, explain, stats, settings, import",
		getArgumentCompletions: (prefix) =>
			[
				"list",
				"explain ",
				"stats",
				"allow ",
				"deny ",
				"remove ",
				"learning on",
				"learning off",
				"auto-allow safe",
				"auto-allow low",
				"import",
				"forget-session",
				"reset-learned",
			]
				.filter((c) => c.startsWith(prefix))
				.map((c) => ({ value: c, label: c.trim() })),
		handler: async (args, ctx) => {
			const rt = getRuntime(ctx);
			const text = args.trim();
			if (text === "") return menu(rt, ctx);
			const [sub, ...restParts] = text.split(/\s+/);
			const rest = text.slice(sub.length).trim();
			switch (sub) {
				case "list":
					return void ctx.ui.notify(listRules(rt, ctx), "info");
				case "explain":
					return void ctx.ui.notify(explain(rt, ctx, rest), "info");
				case "stats":
					return void ctx.ui.notify(stats(rt), "info");
				case "allow":
				case "deny":
					return void ctx.ui.notify(addRuleFromText(rt, sub, rest), "info");
				case "remove":
					return void ctx.ui.notify(removeRule(rt, restParts[0] ?? "", true), "info");
				case "learning":
					rt.store.saveConfig((c) => {
						c.learning.enabled = restParts[0] !== "off";
					});
					return void ctx.ui.notify(`Learning ${restParts[0] === "off" ? "disabled" : "enabled"}.`, "info");
				case "auto-allow":
					rt.store.saveConfig((c) => {
						c.autoAllowRisk =
							parseRisk(restParts[0], Risk.safe) > Risk.low ? Risk.low : parseRisk(restParts[0], Risk.safe);
					});
					return void ctx.ui.notify(
						`Auto-allow threshold: ${RISK_NAMES[rt.store.config().autoAllowRisk]}.`,
						"info",
					);
				case "import":
					return void ctx.ui.notify(importLegacy(rt), "info");
				case "forget-session":
					rt.sessionRules = [];
					pi.appendEntry(REVOKE_ENTRY, { id: "*" });
					return void ctx.ui.notify("Session grants cleared.", "info");
				case "reset-learned": {
					let n = 0;
					rt.store.update("project", (f) => {
						n = f.rules.filter((r) => r.source === "learned").length;
						f.rules = f.rules.filter((r) => r.source !== "learned");
					});
					return void ctx.ui.notify(`Removed ${n} learned rules.`, "info");
				}
				default:
					return void ctx.ui.notify(HELP, "info");
			}
		},
	});

	pi.registerCommand("whitelist", {
		description: "List permission rules (alias for /permissions list)",
		handler: async (_args, ctx) => {
			ctx.ui.notify(listRules(getRuntime(ctx), ctx), "info");
		},
	});

	async function menu(rt: Runtime, ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return void ctx.ui.notify(HELP, "info");
		const config = rt.store.config();
		const rules = allRules(rt, ctx, config);
		const items = [
			`Rules (${rules.length}) - view or remove`,
			"Explain a command or path...",
			"Add a rule...",
			"Stats",
			`Settings (learning ${config.learning.enabled ? "on" : "off"}, auto-allow ${RISK_NAMES[config.autoAllowRisk]})`,
			`Clear session grants (${rt.sessionRules.length})`,
			...(existsSync(join(rt.root, LEGACY_FILE)) ? [`Import ${LEGACY_FILE}`] : []),
		];
		const choice = await ctx.ui.select("Adaptive permissions", items);
		if (!choice) return;
		if (choice.startsWith("Rules")) return manageRules(rt, ctx);
		if (choice.startsWith("Explain")) {
			const input = await ctx.ui.input("Command or path to explain", "git push --force");
			if (input) ctx.ui.notify(explain(rt, ctx, input), "info");
			return;
		}
		if (choice.startsWith("Add")) {
			const input = await ctx.ui.input(
				"allow|deny <command prefix> | allow write <glob> | allow tool <name> [max=low|medium|high]",
				"allow npm run",
			);
			if (input) {
				const [effect, ...rest] = input.trim().split(/\s+/);
				ctx.ui.notify(
					effect === "allow" || effect === "deny" ? addRuleFromText(rt, effect, rest.join(" ")) : HELP,
					"info",
				);
			}
			return;
		}
		if (choice === "Stats") return void ctx.ui.notify(stats(rt), "info");
		if (choice.startsWith("Settings")) return settings(rt, ctx);
		if (choice.startsWith("Clear session")) {
			rt.sessionRules = [];
			pi.appendEntry(REVOKE_ENTRY, { id: "*" });
			return void ctx.ui.notify("Session grants cleared.", "info");
		}
		if (choice.startsWith("Import")) ctx.ui.notify(importLegacy(rt), "info");
	}

	async function manageRules(rt: Runtime, ctx: ExtensionContext): Promise<void> {
		const config = rt.store.config();
		const rules = allRules(rt, ctx, config);
		if (rules.length === 0)
			return void ctx.ui.notify(
				'No rules yet. Approve something with "Always allow" or let the learner find patterns.',
				"info",
			);
		const labels = rules.map((r, i) => `${i + 1}. [${r.scope}/${r.source}] ${describeRule(r)}  hits:${r.hits}`);
		const picked = await ctx.ui.select("Rules (select to remove)", labels);
		if (!picked) return;
		const rule = rules[labels.indexOf(picked)];
		if (rule.source === "repo")
			return void ctx.ui.notify(`This rule comes from ${REPO_RULES_FILE}; edit that file to change it.`, "info");
		const actions =
			rule.source === "learned" ? ["Remove and never learn it again", "Remove", "Cancel"] : ["Remove", "Cancel"];
		const action = await ctx.ui.select(describeRule(rule), actions);
		if (!action || action === "Cancel") return;
		ctx.ui.notify(removeRule(rt, rule.id, action.startsWith("Remove and never")), "info");
	}

	async function settings(rt: Runtime, ctx: ExtensionContext): Promise<void> {
		const c = rt.store.config();
		const items = [
			`Learning: ${c.learning.enabled ? "on" : "off"} (toggle)`,
			`Auto-allow without asking: ${RISK_NAMES[c.autoAllowRisk]} (toggle safe/low)`,
			`Auto-learn up to: ${c.learning.autoPromoteAfter === 0 ? "off" : RISK_NAMES[c.learning.autoPromoteMaxRisk]} after ${c.learning.autoPromoteAfter} approvals (cycle)`,
			`Read gating for secrets: ${c.gateSecretReads ? "on" : "off"} (toggle)`,
			`Headless mode: ${c.headless} (cycle)`,
			`Other tools: ${c.customTools} (cycle)`,
		];
		const choice = await ctx.ui.select("Settings", items);
		if (!choice) return;
		const next = rt.store.saveConfig((cfg) => {
			if (choice.startsWith("Learning")) cfg.learning.enabled = !cfg.learning.enabled;
			else if (choice.startsWith("Auto-allow"))
				cfg.autoAllowRisk = cfg.autoAllowRisk === Risk.safe ? Risk.low : Risk.safe;
			else if (choice.startsWith("Auto-learn")) {
				if (cfg.learning.autoPromoteAfter === 0) {
					cfg.learning.autoPromoteAfter = 3;
					cfg.learning.autoPromoteMaxRisk = Risk.low;
				} else if (cfg.learning.autoPromoteMaxRisk === Risk.low) {
					cfg.learning.autoPromoteMaxRisk = Risk.medium;
				} else {
					cfg.learning.autoPromoteAfter = 0;
				}
			} else if (choice.startsWith("Read gating")) cfg.gateSecretReads = !cfg.gateSecretReads;
			else if (choice.startsWith("Headless"))
				cfg.headless = cfg.headless === "rules" ? "deny" : cfg.headless === "deny" ? "allow" : "rules";
			else if (choice.startsWith("Other tools"))
				cfg.customTools =
					cfg.customTools === "annotations" ? "all" : cfg.customTools === "all" ? "off" : "annotations";
		});
		ctx.ui.notify(
			`Saved. Learning ${next.learning.enabled ? "on" : "off"}, auto-allow ${RISK_NAMES[next.autoAllowRisk]}, headless ${next.headless}.`,
			"info",
		);
	}

	function listRules(rt: Runtime, ctx: ExtensionContext): string {
		const rules = allRules(rt, ctx, rt.store.config());
		if (rules.length === 0) return "No permission rules yet.";
		const lines = ["Permission rules:"];
		for (const scope of ["session", "project", "global"] as const) {
			const group = rules.filter((r) => r.scope === scope);
			if (group.length === 0) continue;
			lines.push(`${scope}:`);
			for (const r of group)
				lines.push(`  ${r.id}  [${r.source}] ${describeRule(r)}  hits:${r.hits}${r.note ? `  (${r.note})` : ""}`);
		}
		return lines.join("\n");
	}

	function removeRule(rt: Runtime, id: string, veto: boolean): string {
		const sessionIndex = rt.sessionRules.findIndex((r) => r.id === id);
		if (sessionIndex !== -1) {
			const [rule] = rt.sessionRules.splice(sessionIndex, 1);
			pi.appendEntry(REVOKE_ENTRY, { id });
			return `Removed session grant: ${describeRule(rule)}`;
		}
		const removed = rt.store.removeRule(id, veto);
		if (!removed) return `No rule with id ${id}. Use /permissions list.`;
		return `Removed: ${describeRule(removed)}${veto && removed.source === "learned" ? " (will not be re-learned)" : ""}`;
	}

	function addRuleFromText(rt: Runtime, effect: "allow" | "deny", text: string): string {
		let body = text;
		let ceiling: Risk = Risk.medium;
		const max = body.match(/\s*\bmax=(\w+)\s*$/);
		if (max) {
			ceiling = parseRisk(max[1], Risk.medium);
			if (ceiling > Risk.high) ceiling = Risk.high;
			body = body.slice(0, max.index).trim();
		}
		const [kind, ...rest] = body.split(/\s+/);
		let rule: Rule;
		const base = {
			id: newRuleId(),
			effect,
			maxRisk: ceiling,
			scope: "project" as const,
			source: "user" as const,
			createdAt: Date.now(),
			hits: 0,
		};
		if ((kind === "write" || kind === "read") && rest.length > 0) {
			rule = { ...base, tool: `file:${kind}`, paths: rest.map((p) => normalizeGlob(p, rt)) };
		} else if (kind === "tool" && rest[0]) {
			rule = { ...base, tool: rest[0] };
		} else if (body.length > 0) {
			const command = kind === "bash" ? rest.join(" ") : body;
			if (!command) return HELP;
			rule = { ...base, tool: "bash", command };
		} else {
			return HELP;
		}
		rt.store.addRule(rule);
		return `Added project rule: ${describeRule(rule)}`;
	}

	function normalizeGlob(glob: string, rt: Runtime): string {
		if (!isAbsolute(glob)) return toPosix(glob.replace(/^\.\//, ""));
		const rel = relative(rt.root, glob);
		return rel.startsWith("..") ? toPosix(glob) : toPosix(rel);
	}

	function explain(rt: Runtime, ctx: ExtensionContext, input: string): string {
		if (!input) return "Usage: /permissions explain <command>   or   /permissions explain write <path>";
		const config = rt.store.config();
		const rules = allRules(rt, ctx, config);
		let request: GateRequest;
		const fileMatch = input.match(/^(write|edit|read)\s+(.+)$/);
		if (fileMatch) {
			const access = fileMatch[1] === "read" ? "read" : "write";
			const a = analyzeFileAccess(fileMatch[1], fileMatch[2], access, rt.env, rt.root);
			request = {
				tool: access === "read" ? "file:read" : "file:write",
				toolName: fileMatch[1],
				analyses: [a],
				issues: [],
				summary: input,
			};
		} else {
			const analysis = analyzeBash(input, rt.env, rt.root);
			request = {
				tool: "bash",
				toolName: "bash",
				analyses: analysis.commands,
				issues: analysis.issues,
				summary: input,
			};
		}
		const decision = decide(request, rules, config.autoAllowRisk);
		const lines = [`Explain: ${input}`, ""];
		for (const a of request.analyses) {
			lines.push(
				`[${RISK_NAMES[a.risk]}] ${a.key}   (family: ${a.family}${a.learnable ? "" : ", never auto-approved"})`,
			);
			for (const r of a.reasons) lines.push(`    ${r}`);
			for (const p of a.paths) lines.push(`    ${p.access} ${p.display} [${RISK_NAMES[p.risk]}]`);
		}
		if (request.issues.length > 0) lines.push(`Parser issues: ${request.issues.join("; ")}`);
		lines.push("");
		if (decision.action === "allow") {
			lines.push("Decision: ALLOW without asking");
			for (const m of decision.matches)
				lines.push(
					`    ${m.analysis.key}: ${m.by === "safe" ? `within auto-allow (${RISK_NAMES[config.autoAllowRisk]})` : `${m.by.scope} rule "${describeRule(m.by)}"`}`,
				);
		} else if (decision.action === "deny") {
			lines.push(`Decision: DENY by rule "${describeRule(decision.rule)}"`);
		} else {
			lines.push(`Decision: ASK - ${decision.reason}`);
			const vetoes = [...rt.store.project().vetoes, ...rt.store.global().vetoes];
			for (const a of decision.pending) {
				const insight = evaluate(request.tool, a, rt.store.decisions(), vetoes, rules, config.learning);
				if (insight.promote) lines.push(`    would learn now: ${insight.promote.label} (${insight.promote.why})`);
				for (const s of insight.suggestions) lines.push(`    would suggest: ${s.label} (${s.support} approvals)`);
				const ladder = candidatesFor(request.tool, a).map((c) => c.label);
				if (ladder.length > 0) lines.push(`    rule options: ${ladder.join("  |  ")}`);
			}
		}
		return lines.join("\n");
	}

	function stats(rt: Runtime): string {
		const c = rt.store.counters();
		const project = rt.store.project();
		const total = c.autoSafe + c.autoRule + c.autoLearned + c.prompted;
		const pct = total > 0 ? Math.round(((total - c.prompted) / total) * 100) : 0;
		const learned = project.rules.filter((r) => r.source === "learned");
		const top = [...project.rules].sort((a, b) => b.hits - a.hits).slice(0, 5);
		return [
			`Since ${new Date(c.since).toISOString().slice(0, 10)} in this project:`,
			`  ${total} gated calls, ${pct}% ran without asking`,
			`  auto: ${c.autoSafe} safe, ${c.autoRule} by rule, ${c.autoLearned} by learned rule`,
			`  asked ${c.prompted}, denied ${c.denied}, learned ${c.promoted} rules (${learned.length} active)`,
			`  this session: ${rt.auto} auto, ${rt.asked} asked`,
			...(top.length > 0
				? ["Most used rules:", ...top.map((r) => `  ${r.hits}x ${describeRule(r)} [${r.source}]`)]
				: []),
			`State: ${rt.store.projectDir}`,
		].join("\n");
	}

	function importLegacy(rt: Runtime): string {
		const file = join(rt.root, LEGACY_FILE);
		if (!existsSync(file)) return `No ${LEGACY_FILE} found.`;
		let raw: { approvedBashCommands?: unknown; approvedWritePaths?: unknown };
		try {
			raw = JSON.parse(readFileSync(file, "utf-8"));
		} catch (error) {
			return `Could not read ${LEGACY_FILE}: ${String(error)}`;
		}
		const now = Date.now();
		let count = 0;
		for (const command of Array.isArray(raw.approvedBashCommands) ? raw.approvedBashCommands : []) {
			if (typeof command !== "string" || !command.trim()) continue;
			// Old entries had no risk awareness; cap them at medium so high-risk forms still ask.
			rt.store.addRule({
				id: newRuleId(),
				effect: "allow",
				tool: "bash",
				command: command.trim(),
				maxRisk: Risk.medium,
				scope: "project",
				source: "legacy",
				createdAt: now,
				hits: 0,
			});
			count++;
		}
		for (const path of Array.isArray(raw.approvedWritePaths) ? raw.approvedWritePaths : []) {
			if (typeof path !== "string" || !path.trim()) continue;
			const resolved = resolvePath(path, rt.root, rt.env);
			const display = resolved.rel ?? toPosix(resolved.abs);
			if (pathRisk(resolved, "write", rt.env).risk >= Risk.critical) continue;
			rt.store.addRule({
				id: newRuleId(),
				effect: "allow",
				tool: "file:write",
				paths: [display],
				maxRisk: Risk.low,
				scope: "project",
				source: "legacy",
				createdAt: now,
				hits: 0,
			});
			count++;
		}
		return `Imported ${count} rules from ${LEGACY_FILE} (bash capped at medium risk, writes at low). The old file is no longer read; you can delete it.`;
	}

	return { runtime: getRuntime, handle };
}

const HELP = [
	"/permissions                     open the menu",
	"/permissions list                list rules with ids",
	"/permissions explain <command>   show how a command is classified and decided",
	"/permissions explain write <path>",
	"/permissions allow <command prefix> [max=low|medium|high]",
	"/permissions allow write <glob>  e.g. allow write src/**",
	"/permissions deny <command prefix>",
	"/permissions remove <id>         remove (and veto, if learned)",
	"/permissions stats               prompts saved, most used rules",
	"/permissions learning on|off",
	"/permissions auto-allow safe|low",
	"/permissions import              import .pi/permission-whitelist.json",
	"/permissions forget-session      clear this session's grants",
	"/permissions reset-learned       remove all learned rules in this project",
].join("\n");
