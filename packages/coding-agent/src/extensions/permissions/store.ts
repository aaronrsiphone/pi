/**
 * Persistent state, kept outside the repository.
 *
 *   <stateDir>/config.json                    settings (see Config)
 *   <stateDir>/global.json                    rules for all projects
 *   <stateDir>/projects/<name>-<hash>/rules.json      project rules, vetoes, counters
 *   <stateDir>/projects/<name>-<hash>/decisions.jsonl decision log the learner reads
 *
 * Why not `.pi/` in the repo: a cloned repository could ship a file that pre-approves `rm`, and the
 * agent could edit its own whitelist with a normal write. Rules live in the user's home, and the
 * whole state directory is a protected path the gate never lets the agent write.
 *
 * Several pi sessions can share a project. Writes take a lock file, re-read the current file, apply
 * the change, and rename a temp file into place, so concurrent sessions never lose each other's rules.
 */

import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { type PermissionMode, parseMode } from "./levels.ts";
import { type Rule, ruleSignature, validateRule } from "./policy.ts";
import { parseRisk, Risk } from "./risk.ts";

export interface LearningConfig {
	enabled: boolean;
	/** Offer an "always allow" generalization after this many matching approvals. */
	suggestAfter: number;
	/** Create a learned rule without asking after this many approvals (0 disables). */
	autoPromoteAfter: number;
	/** Highest risk auto-promotion may cover. */
	autoPromoteMaxRisk: Risk;
	/** Session grants of the same thing in this many distinct sessions become a project rule. */
	sessionPromoteAfter: number;
	sessionPromoteMaxRisk: Risk;
	/** Learned rules unused for this many days are removed (0 keeps them forever). */
	expireUnusedDays: number;
}

export interface Config {
	/** Careful level or adaptive rules. Undefined until the user picks one; `DEFAULT_MODE` applies. */
	mode: PermissionMode | undefined;
	/** Calls at or below this risk run without asking. "safe" by default; "low" asks much less. */
	autoAllowRisk: Risk;
	learning: LearningConfig;
	/** No dialog UI (print/json mode): "rules" allows what rules and autoAllowRisk allow and blocks the rest. */
	headless: "rules" | "deny" | "allow";
	/** Ask before the read tool reads credentials or secrets files. */
	gateSecretReads: boolean;
	/** Other tools: gate by MCP-style annotations, gate all, or ignore. */
	customTools: "annotations" | "all" | "off";
	/** Honor allow rules from the repo's .pi/permissions.json when the project is trusted. */
	repoAllowRules: boolean;
	/** Auto-dismiss prompts (deny) after this many seconds; 0 waits forever. */
	promptTimeoutSeconds: number;
}

export const DEFAULT_CONFIG: Config = {
	mode: undefined,
	autoAllowRisk: Risk.safe,
	learning: {
		enabled: true,
		suggestAfter: 2,
		autoPromoteAfter: 3,
		autoPromoteMaxRisk: Risk.low,
		sessionPromoteAfter: 2,
		sessionPromoteMaxRisk: Risk.medium,
		expireUnusedDays: 60,
	},
	headless: "rules",
	gateSecretReads: true,
	customTools: "annotations",
	repoAllowRules: true,
	promptTimeoutSeconds: 0,
};

export interface Counters {
	autoSafe: number;
	autoRule: number;
	autoLearned: number;
	prompted: number;
	denied: number;
	promoted: number;
	since: number;
}

export type CounterKey = keyof Omit<Counters, "since">;

export interface RuleFile {
	version: 1;
	rules: Rule[];
	/** Signatures of rules the user removed; the learner never re-creates them. */
	vetoes: string[];
	counters: Counters;
}

export type Choice = "once" | "session" | "project" | "global" | "deny" | "deny-always" | "chat" | "auto";

export interface DecisionEvent {
	t: number;
	session: string;
	tool: string;
	key: string;
	family: string;
	risk: Risk;
	/** Display paths written/deleted (and risky reads). */
	paths: string[];
	choice: Choice;
}

const emptyCounters = (): Counters => ({
	autoSafe: 0,
	autoRule: 0,
	autoLearned: 0,
	prompted: 0,
	denied: 0,
	promoted: 0,
	since: Date.now(),
});
const emptyRuleFile = (): RuleFile => ({ version: 1, rules: [], vetoes: [], counters: emptyCounters() });

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` while holding `${file}.lock`. Stale locks (older than 10 s) are broken. */
export function withLock<T>(file: string, fn: () => T): T {
	const lock = `${file}.lock`;
	const deadline = Date.now() + 3000;
	for (;;) {
		try {
			closeSync(openSync(lock, "wx"));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
			} catch {
				// Lock vanished between checks.
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
			sleepSync(15);
		}
	}
	try {
		return fn();
	} finally {
		try {
			unlinkSync(lock);
		} catch {
			// Already gone.
		}
	}
}

function atomicWrite(file: string, content: string): void {
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o600 });
	renameSync(tmp, file);
}

function readJson(file: string): unknown {
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf-8"));
}

function parseRuleFile(raw: unknown, scope: "project" | "global"): RuleFile {
	const out = emptyRuleFile();
	if (typeof raw !== "object" || raw === null) return out;
	const r = raw as Record<string, unknown>;
	if (Array.isArray(r.rules)) {
		for (const item of r.rules) {
			const rule = validateRule(item);
			if (rule && rule.scope !== "session") out.rules.push({ ...rule, scope });
		}
	}
	if (Array.isArray(r.vetoes)) out.vetoes = r.vetoes.filter((x): x is string => typeof x === "string");
	if (typeof r.counters === "object" && r.counters !== null)
		out.counters = { ...out.counters, ...(r.counters as Partial<Counters>) };
	return out;
}

export function parseConfig(raw: unknown): Config {
	const base: Config = structuredClone(DEFAULT_CONFIG);
	if (typeof raw !== "object" || raw === null) return base;
	const r = raw as Record<string, unknown>;
	base.mode = parseMode(r.mode);
	base.autoAllowRisk = parseRisk(r.autoAllowRisk, base.autoAllowRisk);
	// Never auto-allow above low without a rule: medium+ must be learned or approved.
	if (base.autoAllowRisk > Risk.low) base.autoAllowRisk = Risk.low;
	if (r.headless === "rules" || r.headless === "deny" || r.headless === "allow") base.headless = r.headless;
	if (typeof r.gateSecretReads === "boolean") base.gateSecretReads = r.gateSecretReads;
	if (r.customTools === "annotations" || r.customTools === "all" || r.customTools === "off")
		base.customTools = r.customTools;
	if (typeof r.repoAllowRules === "boolean") base.repoAllowRules = r.repoAllowRules;
	if (typeof r.promptTimeoutSeconds === "number" && r.promptTimeoutSeconds >= 0)
		base.promptTimeoutSeconds = r.promptTimeoutSeconds;
	const l = r.learning;
	if (typeof l === "object" && l !== null) {
		const lr = l as Record<string, unknown>;
		const num = (x: unknown, fallback: number) =>
			typeof x === "number" && x >= 0 && Number.isFinite(x) ? Math.floor(x) : fallback;
		if (typeof lr.enabled === "boolean") base.learning.enabled = lr.enabled;
		base.learning.suggestAfter = num(lr.suggestAfter, base.learning.suggestAfter);
		base.learning.autoPromoteAfter = num(lr.autoPromoteAfter, base.learning.autoPromoteAfter);
		base.learning.sessionPromoteAfter = num(lr.sessionPromoteAfter, base.learning.sessionPromoteAfter);
		base.learning.expireUnusedDays = num(lr.expireUnusedDays, base.learning.expireUnusedDays);
		const capped = (x: unknown, fallback: Risk) => {
			const risk = parseRisk(x, fallback);
			return risk > Risk.medium ? Risk.medium : risk;
		};
		base.learning.autoPromoteMaxRisk = capped(lr.autoPromoteMaxRisk, base.learning.autoPromoteMaxRisk);
		base.learning.sessionPromoteMaxRisk = capped(lr.sessionPromoteMaxRisk, base.learning.sessionPromoteMaxRisk);
	}
	return base;
}

export function projectId(root: string): string {
	const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
	const name =
		basename(root)
			.replace(/[^A-Za-z0-9._-]/g, "_")
			.slice(0, 40) || "root";
	return `${name}-${hash}`;
}

interface Cached<T> {
	mtimeMs: number;
	size: number;
	value: T;
}

const MAX_LOG_LINES = 4000;
const KEEP_LOG_LINES = 2000;

export class Store {
	readonly stateDir: string;
	readonly projectDir: string;
	readonly globalFile: string;
	readonly projectFile: string;
	readonly configFile: string;
	readonly logFile: string;
	private cache = new Map<string, Cached<unknown>>();
	private logCache: { size: number; events: DecisionEvent[] } | undefined;
	private pendingHits = new Map<string, number>();
	private pendingCounters: Partial<Record<CounterKey, number>> = {};

	constructor(stateDir: string, root: string) {
		this.stateDir = stateDir;
		this.projectDir = join(stateDir, "projects", projectId(root));
		this.globalFile = join(stateDir, "global.json");
		this.projectFile = join(this.projectDir, "rules.json");
		this.configFile = join(stateDir, "config.json");
		this.logFile = join(this.projectDir, "decisions.jsonl");
	}

	private ensureDirs(): void {
		mkdirSync(this.projectDir, { recursive: true, mode: 0o700 });
	}

	/** Read a file through an mtime/size cache so every tool call sees other sessions' writes cheaply. */
	private cachedRead<T>(file: string, parse: (raw: unknown) => T, fallback: () => T): T {
		let stat: { mtimeMs: number; size: number };
		try {
			stat = statSync(file);
		} catch {
			this.cache.delete(file);
			return fallback();
		}
		const hit = this.cache.get(file);
		if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value as T;
		let value: T;
		try {
			value = parse(readJson(file));
		} catch (error) {
			console.error(`[permissions] ignoring unreadable ${file}:`, error);
			value = fallback();
		}
		this.cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value });
		return value;
	}

	config(): Config {
		return this.cachedRead(this.configFile, parseConfig, () => structuredClone(DEFAULT_CONFIG));
	}

	saveConfig(mutate: (config: Config) => void): Config {
		const config = updateConfig(this.stateDir, mutate);
		this.cache.delete(this.configFile);
		return config;
	}

	project(): RuleFile {
		return this.cachedRead(this.projectFile, (raw) => parseRuleFile(raw, "project"), emptyRuleFile);
	}

	global(): RuleFile {
		return this.cachedRead(this.globalFile, (raw) => parseRuleFile(raw, "global"), emptyRuleFile);
	}

	/** Locked read-modify-write of a rule file. */
	update(scope: "project" | "global", mutate: (file: RuleFile) => void): RuleFile {
		this.ensureDirs();
		const file = scope === "project" ? this.projectFile : this.globalFile;
		return withLock(file, () => {
			const current = parseRuleFile(readJsonSafe(file), scope);
			mutate(current);
			atomicWrite(file, `${JSON.stringify(current, null, "\t")}\n`);
			this.cache.delete(file);
			return current;
		});
	}

	addRule(rule: Rule): void {
		if (rule.scope === "session") throw new Error("session rules are not persisted here");
		this.update(rule.scope, (file) => {
			const signature = ruleSignature(rule);
			const existing = file.rules.find((r) => ruleSignature(r) === signature);
			if (existing) {
				existing.maxRisk = Math.max(existing.maxRisk, rule.maxRisk) as Risk;
				if (rule.source === "user") existing.source = "user";
			} else {
				file.rules.push(rule);
			}
			file.vetoes = file.vetoes.filter((v) => v !== signature);
			if (rule.source === "learned") file.counters.promoted++;
		});
	}

	removeRule(id: string, veto: boolean): Rule | undefined {
		let removed: Rule | undefined;
		for (const scope of ["project", "global"] as const) {
			this.update(scope, (file) => {
				const index = file.rules.findIndex((r) => r.id === id);
				if (index === -1) return;
				[removed] = file.rules.splice(index, 1);
				if (veto && removed && !file.vetoes.includes(ruleSignature(removed)))
					file.vetoes.push(ruleSignature(removed));
			});
			if (removed) break;
		}
		return removed;
	}

	/**
	 * Record rule hits and counters. Buffered in memory and written by `flush()` (called at turn end
	 * and shutdown), so an auto-approved `ls` does not cost a locked file write.
	 */
	recordUse(ruleIds: string[], counter: CounterKey | undefined): void {
		for (const id of ruleIds) this.pendingHits.set(id, (this.pendingHits.get(id) ?? 0) + 1);
		if (counter) this.pendingCounters[counter] = (this.pendingCounters[counter] ?? 0) + 1;
	}

	flush(): void {
		if (this.pendingHits.size === 0 && Object.keys(this.pendingCounters).length === 0) return;
		const hits = this.pendingHits;
		const counters = this.pendingCounters;
		this.pendingHits = new Map();
		this.pendingCounters = {};
		const now = Date.now();
		try {
			const globalIds = new Set(this.global().rules.map((r) => r.id));
			const hasGlobal = [...hits.keys()].some((id) => globalIds.has(id));
			for (const scope of hasGlobal ? (["project", "global"] as const) : (["project"] as const)) {
				this.update(scope, (file) => {
					for (const rule of file.rules) {
						const n = hits.get(rule.id);
						if (n) {
							rule.hits += n;
							rule.lastUsedAt = now;
						}
					}
					if (scope === "project") {
						for (const [key, n] of Object.entries(counters) as [CounterKey, number][]) file.counters[key] += n;
					}
				});
			}
		} catch (error) {
			console.error("[permissions] failed to record rule use:", error);
		}
	}

	/** Project counters including unflushed ones. */
	counters(): Counters {
		const out = { ...this.project().counters };
		for (const [key, n] of Object.entries(this.pendingCounters) as [CounterKey, number][]) out[key] += n;
		return out;
	}

	appendDecision(event: DecisionEvent): void {
		try {
			this.ensureDirs();
			appendFileSync(this.logFile, `${JSON.stringify(event)}\n`, { encoding: "utf-8", mode: 0o600 });
			this.compactLogIfNeeded();
		} catch (error) {
			console.error("[permissions] failed to log decision:", error);
		}
	}

	private compactLogIfNeeded(): void {
		const size = statSync(this.logFile).size;
		if (size < 512 * 1024) return;
		withLock(this.logFile, () => {
			const lines = readFileSync(this.logFile, "utf-8").split("\n").filter(Boolean);
			if (lines.length <= MAX_LOG_LINES) return;
			atomicWrite(this.logFile, `${lines.slice(-KEEP_LOG_LINES).join("\n")}\n`);
			this.logCache = undefined;
		});
	}

	decisions(): DecisionEvent[] {
		let size: number;
		try {
			size = statSync(this.logFile).size;
		} catch {
			return [];
		}
		if (this.logCache && this.logCache.size === size) return this.logCache.events;
		const events: DecisionEvent[] = [];
		for (const line of readFileSync(this.logFile, "utf-8").split("\n")) {
			if (!line) continue;
			try {
				const e = JSON.parse(line) as DecisionEvent;
				if (typeof e.key === "string" && typeof e.choice === "string" && Array.isArray(e.paths)) events.push(e);
			} catch {
				// Skip a torn line from a concurrent append.
			}
		}
		this.logCache = { size, events };
		return events;
	}

	/** Remove learned rules unused for `days`. Returns how many were removed. */
	expireLearned(days: number): number {
		if (days <= 0) return 0;
		const cutoff = Date.now() - days * 86_400_000;
		let removed = 0;
		for (const scope of ["project", "global"] as const) {
			const stale = (scope === "project" ? this.project() : this.global()).rules.some(
				(r) => r.source === "learned" && (r.lastUsedAt ?? r.createdAt) < cutoff,
			);
			if (!stale) continue;
			this.update(scope, (file) => {
				const before = file.rules.length;
				file.rules = file.rules.filter((r) => !(r.source === "learned" && (r.lastUsedAt ?? r.createdAt) < cutoff));
				removed += before - file.rules.length;
			});
		}
		return removed;
	}
}

/** Read `<stateDir>/config.json` without a project. */
export function readConfig(stateDir: string): Config {
	return parseConfig(readJsonSafe(join(stateDir, "config.json")));
}

/** Locked read-modify-write of `<stateDir>/config.json`. */
export function updateConfig(stateDir: string, mutate: (config: Config) => void): Config {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const file = join(stateDir, "config.json");
	return withLock(file, () => {
		const config = parseConfig(readJsonSafe(file));
		mutate(config);
		atomicWrite(file, `${JSON.stringify(config, null, "\t")}\n`);
		return config;
	});
}

function readJsonSafe(file: string): unknown {
	try {
		return readJson(file);
	} catch {
		return undefined;
	}
}
