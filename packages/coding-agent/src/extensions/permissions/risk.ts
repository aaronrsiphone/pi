/**
 * Risk tiers.
 *
 * safe      Runs without asking (read-only inspection).
 * low       Asks until learned; may be learned for all projects.
 * medium    Asks until learned; learned per project.
 * high      Asks until learned; only explicit user approval creates a rule, never auto-learning.
 * critical  Always asks. No rule, session grant, or learned pattern can approve it.
 *
 * Every rule records the highest risk it was approved at (its ceiling). A rule for `git push`
 * approved at medium does not cover `git push --force`, which classifies as high.
 */
export const Risk = {
	safe: 0,
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
} as const;

export type Risk = (typeof Risk)[keyof typeof Risk];

export const RISK_NAMES: Record<Risk, string> = {
	0: "safe",
	1: "low",
	2: "medium",
	3: "high",
	4: "critical",
};

export function maxRisk(...values: Risk[]): Risk {
	let out: Risk = Risk.safe;
	for (const v of values) if (v > out) out = v;
	return out;
}

export function parseRisk(value: unknown, fallback: Risk): Risk {
	if (typeof value === "number" && value >= 0 && value <= 4 && Number.isInteger(value)) return value as Risk;
	if (typeof value === "string") {
		const entry = Object.entries(RISK_NAMES).find(([, name]) => name === value.toLowerCase());
		if (entry) return Number(entry[0]) as Risk;
	}
	return fallback;
}
