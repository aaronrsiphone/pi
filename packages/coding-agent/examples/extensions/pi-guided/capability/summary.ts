/**
 * A probe run in plain words: the class, each range, and the recommended settings.
 */

import { levelLabel } from "../careful/levels.ts";
import { CLASS_DESCRIPTIONS, DIMENSION_NAMES, shownDimensions } from "./ranges.ts";
import type { SuiteResult } from "./suite.ts";

/** Lines describing a run, for a notification or dialog. */
export function describeResult(result: SuiteResult): string[] {
	const { ranges, modelClass, recommendations: rec } = result.placement;
	const cls = CLASS_DESCRIPTIONS[modelClass];
	const lines = [`${result.modelName}: ${cls.label}. ${cls.summary}`, ""];
	for (const dimension of shownDimensions(result.placement)) {
		const range = ranges[dimension];
		lines.push(`  ${DIMENSION_NAMES[dimension]}: ${range.label}${range.detail ? ` (${range.detail})` : ""}`);
	}
	lines.push(
		"",
		`This model can handle up to careful level ${levelLabel(rec.highestLevel)}. Good task size: ${rec.taskSize}.` +
			(rec.effort ? ` Suggested thinking effort: ${rec.effort}.` : ""),
		`Double-check: ${rec.doubleCheck.join("; ")}.`,
	);
	return lines;
}
