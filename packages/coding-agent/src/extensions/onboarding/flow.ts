/**
 * The onboarding steps and how answers move between them.
 *
 * Pure and deterministic: pi decides what comes next from the saved state and the user's answer,
 * never from the model. The UI for each step lives in connect.ts and walkthrough.ts.
 *
 *   connect ──► experience ──► levels ──► practice ──► first-task ──► done
 *      │                         ▲   └──(experienced)──────────────────┘
 *      └─► waiting-for-login ────┘ (after /login selects a model)
 */

export type Step =
	| "connect"
	| "waiting-for-login"
	| "experience"
	| "levels"
	| "practice"
	| "first-task"
	| "done"
	| "skipped";

export interface OnboardingState {
	version: 1;
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
	| { type: "answered-experience"; experienced: boolean }
	| { type: "chose-level" }
	| { type: "practiced" }
	| { type: "suggested-task" }
	| { type: "skip" }
	| { type: "restart" };

export const INITIAL_STATE: OnboardingState = {
	version: 1,
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
		case "answered-experience":
			return state.step === "experience" ? next({ step: "levels", experienced: event.experienced }) : state;
		case "chose-level":
			if (state.step !== "levels") return state;
			// Experienced users get the levels and settings briefly, without the practice round.
			return next({ step: state.experienced ? "done" : "practice" });
		case "practiced":
			return state.step === "practice" ? next({ step: "first-task" }) : state;
		case "suggested-task":
			return state.step === "first-task" ? next({ step: "done" }) : state;
	}
}

/** Validate a state read from disk; anything unreadable starts over. */
export function parseState(raw: unknown): OnboardingState {
	if (typeof raw !== "object" || raw === null) return INITIAL_STATE;
	const r = raw as Record<string, unknown>;
	const steps: readonly Step[] = [
		"connect",
		"waiting-for-login",
		"experience",
		"levels",
		"practice",
		"first-task",
		"done",
		"skipped",
	];
	if (r.version !== 1 || !steps.includes(r.step as Step)) return INITIAL_STATE;
	return {
		version: 1,
		step: r.step as Step,
		experienced: typeof r.experienced === "boolean" ? r.experienced : undefined,
		connectedModel: typeof r.connectedModel === "string" ? r.connectedModel : undefined,
		updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
	};
}
