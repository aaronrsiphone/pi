/**
 * A probe run in plain words: the class, each range, and the recommended settings.
 */

import { levelInfo } from "../careful/levels.ts";
import { CLASS_DESCRIPTIONS, DIMENSION_NAMES, type Dimension } from "./ranges.ts";
import type { SuiteResult } from "./suite.ts";

const ORDER: Dimension[] = ["speed", "context", "tools", "instructions", "retrieval", "multiStep"];

/** Lines describing a run, for a notification or dialog. */
export function describeResult(result: SuiteResult): string[] {
	const { ranges, modelClass, recommendations: rec } = result.placement;
	const cls = CLASS_DESCRIPTIONS[modelClass];
	const lines = [`${result.modelName}: ${cls.label}. ${cls.summary}`, ""];
	for (const dimension of ORDER) {
		const range = ranges[dimension];
		lines.push(`  ${DIMENSION_NAMES[dimension]}: ${range.label}${range.detail ? ` (${range.detail})` : ""}`);
	}
	lines.push(
		"",
		`Recommended: careful level ${rec.carefulLevel} (${levelInfo(rec.carefulLevel).label}), ${rec.taskSize}` +
			(rec.effort ? `, thinking effort ${rec.effort}.` : "."),
		`Double-check: ${rec.doubleCheck.join("; ")}.`,
	);
	return lines;
}
