/**
 * The harder tier: probes that separate good models from each other, each a single request.
 *
 * They run only for models that pass every basic probe, so weak and local models keep the short
 * suite. Like the basic probes, each sends a fixed request and pi checks the reply in code:
 *
 *   - long retrieval: three facts in a lab log of about 30k tokens, one of them superseded later
 *   - finding a bug: two short analysis scripts, each with one subtle bug, named by line number
 *   - engineering reasoning: a turning-fight dynamics problem, six numbers checked within 1%
 */

import { ask, type ProbeClient } from "./client.ts";
import { buildHaystack, type ScoreResult, userOnly } from "./probes.ts";

/** The three harder measurements; undefined fields were not run. */
export interface HardMeasurements {
	longRetrieval: (ScoreResult & { approxTokens: number }) | undefined;
	bugFinding: ScoreResult;
	reasoning: ScoreResult;
}

// Reasoning and a long prompt both take a while; a stall is still caught well before a user gives up.
const TIMEOUT_MS = 180_000;

/** Run the harder tier. Long retrieval is skipped when the context window cannot hold the log. */
export async function probeHard(client: ProbeClient, onStep: (index: number) => void): Promise<HardMeasurements> {
	onStep(0);
	const longRetrieval = await probeLongRetrieval(client, client.model.contextWindow);
	onStep(1);
	const bugFinding = await probeBugFinding(client);
	onStep(2);
	const reasoning = await probeReasoning(client);
	return { longRetrieval, bugFinding, reasoning };
}

/** Steps of the harder tier, in run order, for progress display. */
export const HARD_STEPS = ["Facts in a very long text", "Finding a bug", "An engineering calculation"] as const;

const LONG_TOKENS = 30_000;

/** Three facts in ~30k tokens; one code is replaced later in the log, so the model must read to the end. */
export async function probeLongRetrieval(
	client: ProbeClient,
	contextWindow: number,
): Promise<(ScoreResult & { approxTokens: number }) | undefined> {
	// The log, the question, and the answer must fit with room to spare.
	if (contextWindow < LONG_TOKENS * 1.5) return undefined;
	const log = buildHaystack(LONG_TOKENS, [
		{ at: 0.3, line: "Note: the calibration code for sensor K3 is 5821." },
		{ at: 0.72, line: "Note: sensor K3 was recalibrated today; its calibration code is now 6033." },
		{ at: 0.9, line: "Note: the relief valve on rig C is set to 312 kPa." },
	]);
	const reply = await ask(
		client,
		userOnly(
			`${log}\n\nUsing only the log above, answer three questions, one per line:\n1. What is the current calibration code for sensor K3?\n2. What was its calibration code before that?\n3. What pressure is the relief valve on rig C set to?`,
		),
		TIMEOUT_MS,
	);
	const lines = reply.text.split("\n").filter((l) => l.trim() !== "");
	const notes: string[] = [];
	if (!lines[0]?.includes("6033")) notes.push("did not give the current code for K3 (6033) first");
	if (!lines[1]?.includes("5821")) notes.push("did not give the earlier code for K3 (5821) second");
	if (!/\b312\b/.test(reply.text)) notes.push("did not find the relief valve setting (312 kPa)");
	return { passed: 3 - notes.length, total: 3, notes, approxTokens: LONG_TOKENS };
}

interface BugCase {
	name: string;
	code: string;
	/** The 1-based line with the bug. */
	line: number;
}

// Each script runs without errors and looks plausible; the bug only shows in the numbers.
const BUG_CASES: BugCase[] = [
	{
		name: "flow totals",
		line: 12,
		code: [
			"import numpy as np",
			"",
			"def load_flow(path):",
			"    data = np.loadtxt(path, delimiter=',', skiprows=1)",
			"    return data[:, 0], data[:, 1]  # time in s, flow in L/s",
			"",
			"def total_volume(t, q):",
			'    """Total volume in litres by the trapezoidal rule."""',
			"    total = 0.0",
			"    for i in range(1, len(t)):",
			"        dt = t[i] - t[i - 1]",
			"        total += (q[i] + q[i - 1]) * dt",
			"    return total",
			"",
			"t, q = load_flow('flow.csv')",
			"print(f'Total: {total_volume(t, q):.1f} L')",
		].join("\n"),
	},
	{
		name: "pressure report",
		line: 17,
		code: [
			"import csv",
			"",
			"PSI_TO_KPA = 6.895",
			"",
			"def read_pressures(path):",
			"    with open(path) as f:",
			"        rows = list(csv.DictReader(f))",
			"    return [float(r['pressure_psi']) * PSI_TO_KPA for r in rows]",
			"",
			"def mean(values):",
			"    return sum(values) / len(values)",
			"",
			"def report(path):",
			"    kpa = read_pressures(path)",
			"    print(f'Mean pressure: {mean(kpa):.1f} kPa')",
			"    limit = 300.0  # kPa",
			"    over = [p for p in kpa if p * PSI_TO_KPA > limit]",
			"    print(f'{len(over)} readings over {limit} kPa')",
			"",
			"report('rig_b.csv')",
		].join("\n"),
	},
];

/** Can the model find a subtle bug in a short script and name its line? */
export async function probeBugFinding(client: ProbeClient): Promise<ScoreResult> {
	const notes: string[] = [];
	for (const c of BUG_CASES) {
		const numbered = c.code
			.split("\n")
			.map((line, i) => `${String(i + 1).padStart(2)}  ${line}`)
			.join("\n");
		const reply = await ask(
			client,
			userOnly(
				`This Python script runs without errors, but one line gives wrong results.\n\n${numbered}\n\nWhich line has the bug? Reply with "LINE: <number>" on the first line, then one sentence saying what is wrong.`,
			),
			TIMEOUT_MS,
		);
		const named = Number(reply.text.match(/LINE:\s*(\d+)/i)?.[1]);
		if (named !== c.line) notes.push(`${c.name}: named line ${Number.isNaN(named) ? "none" : named}, not ${c.line}`);
	}
	return { passed: BUG_CASES.length - notes.length, total: BUG_CASES.length, notes };
}

/** A level coordinated turn with a decelerating fighter, a crossing bandit, and a missile launch. */
const REASONING_PROBLEM = `An F-16-class fighter A (mass 15,000 kg) is in a level, coordinated left turn at a constant load factor n = 6. Thrust is 120 kN and drag 150 kN, both constant. Use g = 9.81 m/s^2.
A bandit B flies straight and level at a constant 200 m/s.
At t = 0, in a horizontal frame fixed to A's position at that instant: A is at the origin with velocity (250, 0) m/s, turning toward +y. B is at (2400, 1800) m with velocity (-200, 0) m/s.
Let R be the range from A to B and lambda the line-of-sight angle, counterclockwise from +x.

Find:
1. bank_angle_deg: A's bank angle in degrees.
2. turn_rate_rad_s: A's turn rate at t = 0 in rad/s.
3. t180_s: the time for A to complete a 180 degree heading reversal, accounting for A's changing speed (assume it stays above stall speed).
4. range_accel_m_s2: d^2R/dt^2 at t = 0, accounting for both A's centripetal and tangential acceleration (sign matters).
5. missile_accel_m_s2: the commanded lateral acceleration a_c = N' * Vc * dlambda/dt at t = 0 for a missile launched from A with N' = 4, where Vc = -dR/dt.
6. turn_rate_change_rad_s2: d(omega)/dt at t = 0 at constant n (sign matters).

Reply with only a JSON object with those six keys and numeric values.`;

/** Reference answers, checked with a numerical solution and a simulation of the engagement. */
const REASONING_ANSWERS: Record<string, number> = {
	bank_angle_deg: 80.41,
	turn_rate_rad_s: 0.2321,
	t180_s: 12.83,
	range_accel_m_s2: -8.92,
	missile_accel_m_s2: 129.6,
	turn_rate_change_rad_s2: 1.857e-3,
};

// Rounding in intermediate steps moves answers by a few tenths of a percent; a wrong method by far more.
const TOLERANCE = 0.01;

/** Can the model work through a multi-part engineering calculation? Six numbers, each within 1%. */
export async function probeReasoning(client: ProbeClient): Promise<ScoreResult> {
	const reply = await ask(client, userOnly(REASONING_PROBLEM), TIMEOUT_MS);
	const total = Object.keys(REASONING_ANSWERS).length;
	let answers: Record<string, unknown>;
	try {
		const body = reply.text.match(/\{[\s\S]*\}/)?.[0] ?? reply.text;
		answers = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return { passed: 0, total, notes: ["did not reply with a JSON object"] };
	}
	const notes: string[] = [];
	for (const [key, expected] of Object.entries(REASONING_ANSWERS)) {
		const value = Number(answers[key]);
		if (!(Math.abs(value - expected) <= Math.abs(expected) * TOLERANCE)) {
			notes.push(`${key}: ${answers[key] ?? "missing"}, expected ${expected}`);
		}
	}
	return { passed: total - notes.length, total, notes };
}
