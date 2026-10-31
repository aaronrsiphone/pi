/**
 * Permissions: careful levels for newcomers, adaptive rules for experienced users.
 *
 * The mode in effect is, in order: the `--careful` flag for this session, the mode saved in
 * ~/.pi/agent/permissions/config.json (by `/careful` or onboarding), then level 2. A project's
 * `.pi/permissions.json` may set `maxLevel` to lower it, never to raise it.
 *
 * Every mode gates tool calls from the same classified request (request.ts). Levels 1 and 2 also
 * remove the tools they forbid from the model request, so the model does not keep trying them.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../../core/extensions/types.ts";
import {
	createAdaptiveGate,
	defaultStateDir,
	type PermissionsOptions,
	REPO_RULES_FILE,
	type Runtime,
} from "./adaptive.ts";
import { findMentions, readMentions } from "./attach.ts";
import {
	allowedTools,
	type CarefulLevel,
	capMode,
	DEFAULT_MODE,
	decideForLevel,
	LEVELS,
	levelInfo,
	modeLabel,
	type PermissionMode,
	parseMode,
	promptSection,
} from "./levels.ts";
import { buildPlainPrompt } from "./plain-prompt.ts";
import type { GateRequest } from "./policy.ts";
import { buildRequest } from "./request.ts";
import { readConfig, updateConfig } from "./store.ts";

export type { PermissionsOptions } from "./adaptive.ts";

/** Event-bus channel: another extension saved a mode with `saveMode()`; re-apply it now. */
export const MODE_CHANGED_EVENT = "permissions:mode-changed";

/** Save the mode for future sessions. Emit `MODE_CHANGED_EVENT` afterwards to apply it to this one. */
export function saveMode(mode: PermissionMode, stateDir: string = defaultStateDir()): void {
	updateConfig(stateDir, (config) => {
		config.mode = mode;
	});
}

/** The saved mode, or undefined when the user has not picked one yet. */
export function savedMode(stateDir: string = defaultStateDir()): PermissionMode | undefined {
	return readConfig(stateDir).mode;
}

const LOADOUT_ENTRY = "permissions:loadout";
const STATUS_KEY = "permissions";
const PROMPT_SECTION = "careful";

/** Tools active before a careful level capped them, kept in the session so a resume can restore them. */
interface Loadout {
	capped: boolean;
	base: string[];
}

/** Register careful levels, adaptive rules, `/careful`, `/permissions`, and the `--careful` flag. */
export function createPermissionsExtension(pi: ExtensionAPI, options: PermissionsOptions = {}): void {
	const adaptive = createAdaptiveGate(pi, options);
	let loadout: Loadout | undefined;
	let sessionMode: PermissionMode | undefined;
	let capCache: { file: string; mtimeMs: number; cap: CarefulLevel | undefined } | undefined;
	// Context of the current session, for mode changes announced on the event bus.
	let sessionCtx: ExtensionContext | undefined;

	pi.registerFlag("careful", {
		type: "string",
		description: "Careful level for this session: 1 (only what I share) to 4 (it's yours), or adaptive",
	});

	const annotationsOf = (toolName: string) => pi.getAllTools().find((t) => t.name === toolName)?.annotations;

	/** The `maxLevel` a project's .pi/permissions.json sets, if any. */
	function projectCap(rt: Runtime): CarefulLevel | undefined {
		const file = join(rt.root, REPO_RULES_FILE);
		let mtimeMs: number;
		try {
			mtimeMs = statSync(file).mtimeMs;
		} catch {
			return undefined;
		}
		if (capCache?.file !== file || capCache.mtimeMs !== mtimeMs) {
			let cap: CarefulLevel | undefined;
			try {
				const raw = JSON.parse(readFileSync(file, "utf-8")) as { maxLevel?: unknown };
				const parsed = parseMode(raw.maxLevel);
				cap = parsed === "adaptive" ? undefined : parsed;
			} catch (error) {
				console.error(`[permissions] ignoring invalid ${file}:`, error);
			}
			capCache = { file, mtimeMs, cap };
		}
		return capCache.cap;
	}

	function currentMode(ctx: ExtensionContext): PermissionMode {
		const rt = adaptive.runtime(ctx);
		const chosen = sessionMode ?? rt.store.config().mode ?? DEFAULT_MODE;
		return capMode(chosen, projectCap(rt));
	}

	function restoreLoadout(ctx: ExtensionContext): Loadout | undefined {
		let found: Loadout | undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== LOADOUT_ENTRY) continue;
			const data = entry.data as Partial<Loadout> | undefined;
			if (typeof data?.capped === "boolean" && Array.isArray(data.base)) {
				found = { capped: data.capped, base: data.base.filter((t): t is string => typeof t === "string") };
			}
		}
		return found;
	}

	function saveLoadout(next: Loadout): void {
		loadout = next;
		pi.appendEntry(LOADOUT_ENTRY, next);
	}

	/** Declare only the tools the mode allows; restore the user's tools when a cap is lifted. */
	function applyLoadout(mode: PermissionMode): void {
		const allowed = allowedTools(mode);
		const active = pi.getActiveTools();
		if (allowed) {
			if (!loadout?.capped) saveLoadout({ capped: true, base: active });
			const registered = new Set(pi.getAllTools().map((t) => t.name));
			const desired = allowed.filter((name) => registered.has(name));
			if (desired.length !== active.length || desired.some((name) => !active.includes(name))) {
				pi.setActiveTools(desired);
			}
		} else if (loadout?.capped) {
			pi.setActiveTools(loadout.base);
			saveLoadout({ capped: false, base: loadout.base });
		}
	}

	function showStatus(ctx: ExtensionContext, mode: PermissionMode): void {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `careful: ${modeLabel(mode)}`);
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		sessionMode = parseMode(pi.getFlag("careful"));
		loadout = restoreLoadout(ctx);
		const mode = currentMode(ctx);
		applyLoadout(mode);
		showStatus(ctx, mode);
	});

	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
	});

	pi.events.on(MODE_CHANGED_EVENT, () => {
		if (!sessionCtx) return;
		sessionMode = undefined;
		const mode = currentMode(sessionCtx);
		applyLoadout(mode);
		showStatus(sessionCtx, mode);
	});

	pi.on("before_agent_start", (event, ctx) => {
		const mode = currentMode(ctx);
		applyLoadout(mode);
		showStatus(ctx, mode);
		const section = promptSection(mode);
		if (section) event.systemPromptOptions.sections[PROMPT_SECTION] = section;
		else delete event.systemPromptOptions.sections[PROMPT_SECTION];
	});

	pi.on("tool_call", async (event, ctx) => {
		const mode = currentMode(ctx);
		if (mode === "adaptive") return adaptive.handle(event, ctx);
		const rt = adaptive.runtime(ctx);
		const request = buildRequest(event, rt.env, rt.store.config(), annotationsOf);
		const decision = decideForLevel(mode, event.toolName, request);
		if (decision.action === "allow") return undefined;
		if (decision.action === "block") return { block: true, reason: decision.reason };
		// Serialize with other prompts so parallel tool calls ask one at a time.
		const run = rt.queue.then(() => askPlain(event, request!, mode, ctx));
		rt.queue = run.catch(() => undefined);
		return run;
	});

	async function askPlain(
		event: ToolCallEvent,
		request: GateRequest,
		level: CarefulLevel,
		ctx: ExtensionContext,
	): Promise<ToolCallEventResult | undefined> {
		const what = request.summary;
		if (!ctx.hasUI) {
			return {
				block: true,
				reason: `Careful level ${level} needs the user's approval for ${what}, and no interactive UI is available to ask.`,
			};
		}
		const prompt = buildPlainPrompt(request);
		const label = await ctx.ui.select(
			`${prompt.title}\n\n${prompt.description}`,
			prompt.options.map((o) => o.label),
			ctx.signal ? { signal: ctx.signal } : undefined,
		);
		const action = prompt.options.find((o) => o.label === label)?.action;
		switch (action) {
			case "yes":
				return undefined;
			case "no-reason": {
				const why = await ctx.ui.input("What should it do instead?", "e.g. save the result as a new file");
				return {
					block: true,
					reason: `The user said no to ${what}.${why ? ` They said: ${why}` : ""} Do not retry the same ${event.toolName} call; follow what they said.`,
				};
			}
			case "chat":
				return {
					block: true,
					terminate: true,
					reason: `The user wants to talk before you ${what}. It was not run and the turn has ended. When they reply, explain what you wanted to do and why, and continue only after they agree.`,
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

	pi.on("input", async (event, ctx) => {
		if (currentMode(ctx) !== 1) return undefined;
		const mentions = findMentions(event.text);
		if (mentions.length === 0) return undefined;
		const attached = await readMentions(mentions, ctx.cwd);
		if (attached.problems.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Could not attach: ${attached.problems.join("; ")}`, "warning");
		}
		if (!attached.text) return undefined;
		return {
			action: "transform",
			text: `${event.text}\n\n${attached.text}`,
			images: [...(event.images ?? []), ...attached.images],
		};
	});

	pi.registerCommand("careful", {
		description: "How careful should pi be? Pick what it may do to your files (levels 1-4)",
		getArgumentCompletions: (prefix) =>
			[
				...LEVELS.map((l) => ({ value: String(l.level), label: `${l.level} ${l.label}` })),
				{ value: "adaptive", label: "adaptive" },
			]
				.filter((item) => item.value.startsWith(prefix.trim()))
				.map((item) => ({ value: item.value, label: item.label })),
		handler: async (args, ctx) => {
			const requested = args.trim() ? parseMode(args) : await pickLevel(ctx);
			if (args.trim() && requested === undefined) {
				ctx.ui.notify("Usage: /careful [1|2|3|4|adaptive]", "warning");
				return;
			}
			if (requested === undefined) return;
			setMode(requested, ctx);
		},
	});

	async function pickLevel(ctx: ExtensionCommandContext): Promise<PermissionMode | undefined> {
		if (!ctx.hasUI) return undefined;
		const current = currentMode(ctx);
		const labels = LEVELS.map(
			(l) => `${l.level}. ${l.label}${l.level === current ? " (current)" : ""}: ${l.summary}`,
		);
		const choice = await ctx.ui.select(
			`How careful should pi be?\n\nNow: ${modeLabel(current)}. Change it any time with /careful.`,
			labels,
		);
		return choice === undefined ? undefined : LEVELS[labels.indexOf(choice)].level;
	}

	function setMode(requested: PermissionMode, ctx: ExtensionContext): void {
		adaptive.runtime(ctx).store.saveConfig((config) => {
			config.mode = requested;
		});
		sessionMode = undefined;
		const mode = currentMode(ctx);
		applyLoadout(mode);
		showStatus(ctx, mode);
		if (mode !== requested) {
			ctx.ui.notify(
				`Saved ${modeLabel(requested)}, but this project's ${REPO_RULES_FILE} allows at most ${modeLabel(mode)}.`,
				"warning",
			);
		} else if (mode === "adaptive") {
			ctx.ui.notify("Careful: adaptive rules. Manage them with /permissions.", "info");
		} else {
			ctx.ui.notify(
				`Careful level ${mode}: ${levelInfo(mode).label}.\n${levelInfo(mode).details.join("\n")}`,
				"info",
			);
		}
	}
}

export default function permissionsExtension(pi: ExtensionAPI): void {
	createPermissionsExtension(pi);
}
