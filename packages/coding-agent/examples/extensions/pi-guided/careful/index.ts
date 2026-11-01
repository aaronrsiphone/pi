/**
 * Careful levels: limit what the agent can do to the user's files (levels.ts).
 *
 * The level in effect is, in order: the `--careful` flag for this session, the level saved by
 * `/careful` (config.ts), then level 2. A project's `.pi/careful.json` may lower it, never raise it.
 *
 * Levels 1 and 2 remove the tools they forbid from the model request, so the model does not keep
 * trying them, and block them if anything calls them anyway. Level 3 asks before every tool call
 * that is not a read. Level 4 leaves pi as it is.
 *
 * Other extensions talk to this one only over the event bus: `careful:set` asks for a level, and
 * `careful:changed` reports the level in effect.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { askApproval } from "./approval.ts";
import { findMentions, readMentions } from "./attach.ts";
import {
	createProjectCapReader,
	defaultCarefulDir,
	PROJECT_CAP_FILE,
	readSavedLevel,
	writeSavedLevel,
} from "./config.ts";
import {
	allowedTools,
	CAREFUL_CHANGED_EVENT,
	CAREFUL_SET_EVENT,
	type CarefulChangedEvent,
	type CarefulLevel,
	type CarefulSetEvent,
	capLevel,
	DEFAULT_LEVEL,
	decideForLevel,
	LEVELS,
	levelInfo,
	levelLabel,
	parseLevel,
	promptSection,
} from "./levels.ts";

export interface CarefulOptions {
	/** Where the chosen level is saved. Defaults to ~/.pi/agent/careful. */
	dir?: string;
}

const LOADOUT_ENTRY = "careful:loadout";
const STATUS_KEY = "careful";
const PROMPT_SECTION = "careful";

/** Tools active before a level capped them, kept in the session so a resume can restore them. */
interface Loadout {
	capped: boolean;
	base: string[];
}

/** Register careful levels, `/careful`, and the `--careful` flag. */
export function createCarefulExtension(pi: ExtensionAPI, options: CarefulOptions = {}): void {
	const dir = options.dir ?? defaultCarefulDir();
	const projectCap = createProjectCapReader();
	let loadout: Loadout | undefined;
	let sessionLevel: CarefulLevel | undefined;
	let sessionCtx: ExtensionContext | undefined;
	// Parallel tool calls ask one question at a time.
	let queue: Promise<unknown> = Promise.resolve();

	pi.registerFlag("careful", {
		type: "string",
		description: "Careful level for this session: 1 (only what I share) to 4 (it's yours)",
	});

	function currentLevel(ctx: ExtensionContext): CarefulLevel {
		return capLevel(sessionLevel ?? readSavedLevel(dir) ?? DEFAULT_LEVEL, projectCap(ctx.cwd));
	}

	/** Declare only the tools the level allows; restore the user's tools when a cap is lifted. */
	function applyLoadout(level: CarefulLevel): void {
		const allowed = allowedTools(level);
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

	function saveLoadout(next: Loadout): void {
		loadout = next;
		pi.appendEntry(LOADOUT_ENTRY, next);
	}

	/** Apply the level in effect to tools and the status line, and announce it. */
	function apply(ctx: ExtensionContext): CarefulLevel {
		const level = currentLevel(ctx);
		applyLoadout(level);
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `careful: ${levelLabel(level)}`);
		pi.events.emit(CAREFUL_CHANGED_EVENT, { level } satisfies CarefulChangedEvent);
		return level;
	}

	pi.on("session_start", (_event, ctx) => {
		sessionCtx = ctx;
		sessionLevel = parseLevel(pi.getFlag("careful"));
		loadout = restoreLoadout(ctx);
		apply(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
	});

	pi.events.on(CAREFUL_SET_EVENT, (data) => {
		const level = parseLevel((data as Partial<CarefulSetEvent> | undefined)?.level);
		if (level === undefined || !sessionCtx) return;
		writeSavedLevel(dir, level);
		sessionLevel = undefined;
		apply(sessionCtx);
	});

	// Other extensions may activate tools at any time; the cap is applied again before every run.
	pi.on("before_agent_start", (event, ctx) => {
		const level = currentLevel(ctx);
		applyLoadout(level);
		const section = promptSection(level);
		if (section) event.systemPromptOptions.sections[PROMPT_SECTION] = section;
		else delete event.systemPromptOptions.sections[PROMPT_SECTION];
	});

	pi.on("tool_call", async (event, ctx) => {
		const decision = decideForLevel(currentLevel(ctx), event.toolName);
		if (decision.action === "allow") return undefined;
		if (decision.action === "block") return { block: true, reason: decision.reason };
		const input = event.input as Record<string, unknown>;
		const run = queue.then(() =>
			askApproval(event.toolName, input, ctx.cwd, ctx.hasUI ? ctx.ui : undefined, ctx.signal),
		);
		queue = run.catch(() => undefined);
		return run;
	});

	pi.on("input", async (event, ctx) => {
		if (currentLevel(ctx) !== 1) return undefined;
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
			LEVELS.map((l) => ({ value: String(l.level), label: levelLabel(l.level) })).filter((item) =>
				item.value.startsWith(prefix.trim()),
			),
		handler: async (args, ctx) => {
			const requested = args.trim() ? parseLevel(args) : await pickLevel(ctx);
			if (args.trim() && requested === undefined) {
				ctx.ui.notify("Usage: /careful [1|2|3|4]", "warning");
				return;
			}
			if (requested === undefined) return;
			writeSavedLevel(dir, requested);
			sessionLevel = undefined;
			const level = apply(ctx);
			ctx.ui.notify(
				level === requested
					? `Careful level ${level}: ${levelInfo(level).label}.\n${levelInfo(level).details.join("\n")}`
					: `Saved level ${levelLabel(requested)}, but this project's ${PROJECT_CAP_FILE} allows at most ${levelLabel(level)}.`,
				level === requested ? "info" : "warning",
			);
		},
	});

	async function pickLevel(ctx: ExtensionCommandContext): Promise<CarefulLevel | undefined> {
		if (!ctx.hasUI) return undefined;
		const current = currentLevel(ctx);
		const labels = LEVELS.map(
			(l) => `${l.level}. ${l.label}${l.level === current ? " (current)" : ""}: ${l.summary}`,
		);
		const choice = await ctx.ui.select(
			`How careful should pi be?\n\nNow: ${levelLabel(current)}. Change it any time with /careful.`,
			labels,
		);
		return choice === undefined ? undefined : LEVELS[labels.indexOf(choice)].level;
	}
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

export default function carefulExtension(pi: ExtensionAPI): void {
	createCarefulExtension(pi);
}
