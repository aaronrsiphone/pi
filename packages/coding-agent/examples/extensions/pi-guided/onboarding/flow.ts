/**
 * The onboarding steps and how answers move between them.
 *
 * Pure and deterministic: pi decides what comes next from the saved state and the user's answer,
 * never from the model. The UI for each step lives in connect.ts, measure.ts, walkthrough.ts, and
 * benchmark.ts.
 *
 *   connect ──► experience ──► levels ──► practice ──► probe ──► benchmark ──► expectations ──► first-task ──► done
 *      │                         └─(experienced)─────┘                │          ▲           └─(experienced)─┘
 *      └─► waiting-for-login (until /login selects a model)            └─► waiting-for-benchmark (until /bench ends)
 *
 * The user picks the careful level from their own experience before the model is measured, so
 * setup recommends a level once. The probe then only reports the highest level the model handles,
 * and offers to lower the chosen level when the model cannot handle it.
 */

export type Step =
	| "connect"
	| "waiting-for-login"
	| "experience"
	| "levels"
	| "practice"
	| "probe"
	| "benchmark"
	| "waiting-for-benchmark"
	| "expectations"
	| "first-task"
	| "done"
	| "skipped";

const STEPS: readonly Step[] = [
	"connect",
	"waiting-for-login",
	"experience",
	"levels",
	"practice",
	"probe",
	"benchmark",
	"waiting-for-benchmark",
	"expectations",
	"first-task",
	"done",
	"skipped",
];

export interface OnboardingState {
	version: 2;
	step: Step;
	/** Answer to "Have you used an AI agent before?". */
	experienced: boolean | undefined;
	/** `provider/model` the connection check last succeeded with. */
	connectedModel: string | undefined;
	updatedAt: number;
}

export type FlowEvent =
	| { type: "connected"; model: string }
	| { type: "login-started" }
	| { type: "probed" }
	| { type: "answered-experience"; experienced: boolean }
	| { type: "chose-level" }
	| { type: "practiced" }
	| { type: "benchmark-started" }
	| { type: "benchmark-done" }
	| { type: "saw-expectations" }
	| { type: "suggested-task" }
	| { type: "skip" }
	| { type: "restart" };

export const INITIAL_STATE: OnboardingState = {
	version: 2,
	step: "connect",
	experienced: undefined,
	connectedModel: undefined,
	updatedAt: 0,
};

/** Whether the flow has nothing left to show. */
export function isFinished(state: OnboardingState): boolean {
	return state.step === "done" || state.step === "skipped";
}

/** Apply one answer. Events that do not fit the current step leave the state unchanged. */
export function advance(state: OnboardingState, event: FlowEvent, now: number): OnboardingState {
	const next = (patch: Partial<OnboardingState>): OnboardingState => ({ ...state, ...patch, updatedAt: now });
	switch (event.type) {
		case "skip":
			return next({ step: "skipped" });
		case "restart":
			return { ...INITIAL_STATE, updatedAt: now };
		case "connected":
			if (state.step !== "connect" && state.step !== "waiting-for-login") return state;
			return next({ step: "experience", connectedModel: event.model });
		case "login-started":
			return state.step === "connect" ? next({ step: "waiting-for-login" }) : state;
		case "probed":
			return state.step === "probe" ? next({ step: "benchmark" }) : state;
		case "answered-experience":
			return state.step === "experience" ? next({ step: "levels", experienced: event.experienced }) : state;
		case "chose-level":
			if (state.step !== "levels") return state;
			// Experienced users get the levels and settings briefly, without the practice round.
			return next({ step: state.experienced ? "probe" : "practice" });
		case "practiced":
			return state.step === "practice" ? next({ step: "probe" }) : state;
		case "benchmark-started":
			return state.step === "benchmark" ? next({ step: "waiting-for-benchmark" }) : state;
		case "benchmark-done":
			if (state.step !== "benchmark" && state.step !== "waiting-for-benchmark") return state;
			return next({ step: "expectations" });
		case "saw-expectations":
			if (state.step !== "expectations") return state;
			return next({ step: state.experienced ? "done" : "first-task" });
		case "suggested-task":
			return state.step === "first-task" ? next({ step: "done" }) : state;
	}
}

/** Validate a state read from disk; anything unreadable starts over. */
export function parseState(raw: unknown): OnboardingState {
	if (typeof raw !== "object" || raw === null) return INITIAL_STATE;
	const r = raw as Record<string, unknown>;
	if (r.version !== 2 || !STEPS.includes(r.step as Step)) return INITIAL_STATE;
	return {
		version: 2,
		step: r.step as Step,
		experienced: typeof r.experienced === "boolean" ? r.experienced : undefined,
		connectedModel: typeof r.connectedModel === "string" ? r.connectedModel : undefined,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
	};
}
