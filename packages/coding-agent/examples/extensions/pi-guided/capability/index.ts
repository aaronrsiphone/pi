/**
 * Capability probes: measure the connected model in about a minute, or two to three minutes for a
 * model good enough for the harder tier, and place it in ranges.
 *
 * `/probe` runs the suite on the current model; `/expectations` shows what to expect from it.
 * Results are saved per model (store.ts). The card is built when it is shown, from the latest probe
 * and benchmark results, and shown after every probe. Works on its own; the careful and benchmark
 * extensions add the current level and benchmark results over the event bus when they are on.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CAREFUL_CHANGED_EVENT, type CarefulChangedEvent, type CarefulLevel } from "../careful/levels.ts";
import {
	buildCard,
	EXPECTATIONS_COLLECT_EVENT,
	type ExpectationsCollectEvent,
	type ExpectationsSection,
} from "./expectations.ts";
import { defaultCapabilityDir, loadResults, savedResult, saveResult } from "./store.ts";
import { estimateCost, runSuite, SUITE_STEPS, type SuiteOutcome } from "./suite.ts";

export type { SuiteOutcome, SuiteResult } from "./suite.ts";

const WIDGET_KEY = "capability";
const CARD_ENTRY = "capability:expectations";

/**
 * Measure the current model, showing progress, and save the result. Asks first when the model
 * charges per token. Returns undefined when there is no model or the user declined.
 */
export async function measureModel(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	dir: string = defaultCapabilityDir(),
): Promise<SuiteOutcome | undefined> {
	const model = ctx.model;
	if (!model) return undefined;
	const name = model.name || model.id;
	if (model.cost.input > 0 || model.cost.output > 0) {
		const dollars = estimateCost(model.cost);
		const ok = await ctx.ui.confirm(
			"Measure this model?",
			`Pi sends about 20 to 25 requests to ${name} to see what it can do. At its prices that costs at most about $${dollars < 0.01 ? "0.01" : dollars.toFixed(2)}.`,
		);
		if (!ok) return undefined;
	}
	const show = (current: number) =>
		ctx.ui.setWidget(WIDGET_KEY, [
			`Checking what ${name} can do. This takes about a minute, and a few more if it passes every basic check.`,
			...SUITE_STEPS.map((step, i) => `  ${i < current ? "done" : i === current ? " now" : "    "}  ${step}`),
		]);
	try {
		const outcome = await runSuite(
			{ model, thinkingLevel: pi.getThinkingLevel(), registry: ctx.modelRegistry },
			show,
		);
		if (outcome.ok) saveResult(dir, outcome.result);
		return outcome;
	} finally {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}
}

/** Register `/probe`, `/expectations`, and the card's renderer. */
export function createCapabilityExtension(pi: ExtensionAPI, options: { dir?: string } = {}): void {
	const dir = options.dir ?? defaultCapabilityDir();
	// The level the careful extension last reported; undefined while it is turned off.
	let level: CarefulLevel | undefined;

	pi.events.on(CAREFUL_CHANGED_EVENT, (data) => {
		level = (data as CarefulChangedEvent).level;
	});

	pi.registerEntryRenderer(CARD_ENTRY, (entry, _options, theme) => {
		const sections = (entry.data as { sections: ExpectationsSection[] }).sections;
		const text = sections.map((s) => `${theme.bold(theme.fg("accent", s.title))}\n${s.lines.join("\n")}`);
		return new Text(text.join("\n\n"), 1, 0);
	});

	/** Add the card for the current model to the chat. It is shown to the user, never sent to the model. */
	function showCard(ctx: ExtensionContext): void {
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("No model is connected. Run /onboarding or /login first.", "warning");
			return;
		}
		const key = `${model.provider}/${model.id}`;
		const collect: ExpectationsCollectEvent = { model: key, sections: [] };
		pi.events.emit(EXPECTATIONS_COLLECT_EVENT, collect);
		const sections = buildCard({
			modelName: model.name || model.id,
			result: loadResults(dir, key)[0],
			sections: collect.sections,
			currentLevel: level,
			currentEffort: pi.getThinkingLevel(),
		});
		pi.appendEntry(CARD_ENTRY, { sections });
	}

	pi.registerCommand("probe", {
		description: "Measure what the connected model can do (one to three minutes); `/probe again` measures anew",
		getArgumentCompletions: (prefix) =>
			"again".startsWith(prefix.trim()) ? [{ value: "again", label: "again" }] : null,
		handler: async (args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No model is connected. Run /onboarding or /login first.", "warning");
				return;
			}
			// A saved run for the same model and effort is reused unless the user asks to measure again.
			const saved = savedResult(dir, `${model.provider}/${model.id}`, pi.getThinkingLevel());
			if (saved && args.trim() !== "again") {
				const reuse = `Use the saved result from ${new Date(saved.at).toLocaleString()}`;
				const choice = await ctx.ui.select(
					`${model.name || model.id} was already measured at thinking effort ${saved.thinkingLevel}.`,
					[reuse, "Measure again (one to three minutes)"],
				);
				if (choice === undefined) return;
				if (choice === reuse) {
					showCard(ctx);
					return;
				}
			}
			const outcome = await measureModel(ctx, pi, dir);
			if (!outcome) return;
			if (!outcome.ok) {
				ctx.ui.notify(`Could not measure the model: ${outcome.error}`, "error");
				return;
			}
			showCard(ctx);
		},
	});

	pi.registerCommand("expectations", {
		description: "What to expect from the connected model: its class, where to check its work, and settings",
		handler: async (_args, ctx) => showCard(ctx),
	});
}

export default function capabilityExtension(pi: ExtensionAPI): void {
	createCapabilityExtension(pi);
}
