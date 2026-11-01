/**
 * The expectations card: what to expect from the connected model, in plain words.
 *
 * It brings together the latest probe result (class, ranges, where to check), what other
 * extensions add (the user's benchmark results), and the recommended against the current settings.
 * Built on demand, so it always reflects the latest probe and benchmark runs.
 */

import { type CarefulLevel, levelLabel } from "../careful/levels.ts";
import { CLASS_DESCRIPTIONS, DIMENSION_NAMES, shownDimensions } from "./ranges.ts";
import type { SuiteResult } from "./suite.ts";

/** Event-bus channel: the card is being built; add a section. Payload: `ExpectationsCollectEvent`. */
export const EXPECTATIONS_COLLECT_EVENT = "expectations:collect";

export interface ExpectationsSection {
	title: string;
	lines: string[];
}

/**
 * Handlers push their sections synchronously: the card is built right after the event is emitted.
 * `model` is `provider/model`.
 */
export interface ExpectationsCollectEvent {
	model: string;
	sections: ExpectationsSection[];
}

export interface CardInput {
	modelName: string;
	/** The latest probe result for this model, if it was measured. */
	result: SuiteResult | undefined;
	/** Sections from other extensions. */
	sections: ExpectationsSection[];
	/** The careful level in effect; undefined when careful levels are turned off. */
	currentLevel: CarefulLevel | undefined;
	/** The thinking effort in effect. */
	currentEffort: string;
}

/** The card as titled sections of text lines. */
export function buildCard(input: CardInput): ExpectationsSection[] {
	const { result } = input;
	if (!result) {
		return [
			{
				title: `What to expect from ${input.modelName}`,
				lines: ["Not measured yet. Run /probe (about a minute) to see what this model can do."],
			},
			...input.sections,
			settingsSection(input),
		];
	}
	const { ranges, modelClass, recommendations } = result.placement;
	const dimensions = shownDimensions(result.placement);
	const cls = CLASS_DESCRIPTIONS[modelClass];
	const strong = dimensions.filter((d) => ranges[d].tier === "high").map((d) => DIMENSION_NAMES[d].toLowerCase());
	return [
		{
			title: `What to expect from ${input.modelName}: ${cls.label}`,
			lines: [
				cls.summary,
				...dimensions.map((d) => {
					const range = ranges[d];
					return `  ${DIMENSION_NAMES[d]}: ${range.label}${range.detail ? ` (${range.detail})` : ""}`;
				}),
				`Measured ${new Date(result.at).toLocaleDateString()} at effort ${result.thinkingLevel}.`,
			],
		},
		{
			title: "On the probes",
			lines: [
				strong.length > 0 ? `Did well: ${strong.join(", ")}.` : "It did not do well on any probe.",
				`Good task size: ${recommendations.taskSize}.`,
			],
		},
		...input.sections,
		{ title: "Check its work on", lines: recommendations.doubleCheck.map((item) => `  - ${item}`) },
		settingsSection(input),
	];
}

function settingsSection(input: CardInput): ExpectationsSection {
	const rec = input.result?.placement.recommendations;
	const level = (l: CarefulLevel | undefined) => (l === undefined ? "careful levels off" : levelLabel(l));
	const lines = [
		`Careful level: now ${level(input.currentLevel)}${rec ? `, recommended ${levelLabel(rec.carefulLevel)}` : ""}.`,
		`Thinking effort: now ${input.currentEffort}${rec?.effort ? `, recommended ${rec.effort}` : ""}.`,
		"Change them with /careful and /thinking. New to agents? Stay at level 2 or lower until the answers are right.",
	];
	return { title: "Settings", lines };
}
