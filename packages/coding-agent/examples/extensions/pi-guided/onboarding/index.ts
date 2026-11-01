/**
 * Guided onboarding: connect a model, measure it, learn the careful levels, run a first benchmark,
 * see what to expect, and try a first task. Afterwards it suggests moving up a level when the
 * benchmark tasks at the current level pass.
 *
 * Pi drives every step in code (flow.ts); the model only answers the connection check, the
 * capability probes, and the benchmark tasks, which pi or the user grade. Setup starts once on the
 * first interactive start, can be paused with Escape, resumes where it stopped, and runs again with
 * /onboarding. One answer ("I have used an agent") takes the short path.
 *
 * Onboarding only guides; the careful, capability, and benchmark extensions do the work and run
 * without it. A step whose extension is turned off is skipped. Onboarding reaches them only through
 * their commands and event-bus channels, never their files.
 */

import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { BENCHMARK_FINISHED_EVENT, type BenchmarkFinishedEvent } from "../benchmark/events.ts";
import { measureModel, type SuiteOutcome } from "../capability/index.ts";
import {
	CAREFUL_CHANGED_EVENT,
	CAREFUL_SET_EVENT,
	type CarefulChangedEvent,
	type CarefulLevel,
	type CarefulSetEvent,
} from "../careful/levels.ts";
import { moveUpSuggestion, runBenchmarkStep, runExpectationsStep, runWaitingForBenchmark } from "./benchmark.ts";
import { runConnect, runWaitingForLogin } from "./connect.ts";
import { advance, type FlowEvent, isFinished, type OnboardingState } from "./flow.ts";
import { runProbe } from "./measure.ts";
import { defaultOnboardingDir, loadState, saveState } from "./state.ts";
import { runExperience, runFirstTask, runLevels, runPractice } from "./walkthrough.ts";

export interface OnboardingOptions {
	/** Where progress is saved. Defaults to ~/.pi/agent/onboarding. */
	dir?: string;
	/** models.json for endpoints added during setup. */
	modelsPath?: string;
	/** Where probe results are saved. Defaults to ~/.pi/agent/capability. */
	capabilityDir?: string;
	/** Measures the connected model. Defaults to the capability probes (`measureModel`). */
	measure?: (ctx: ExtensionContext) => Promise<SuiteOutcome | undefined>;
}

/** Register /onboarding and start setup on the first interactive start. */
export function createOnboardingExtension(pi: ExtensionAPI, options: OnboardingOptions = {}): void {
	const dir = options.dir ?? defaultOnboardingDir();
	let running: Promise<void> | undefined;
	// The level the careful extension last reported; undefined while it is turned off.
	let level: CarefulLevel | undefined;

	let sessionCtx: ExtensionContext | undefined;

	pi.events.on(CAREFUL_CHANGED_EVENT, (data) => {
		level = (data as CarefulChangedEvent).level;
	});

	pi.events.on(BENCHMARK_FINISHED_EVENT, (data) => {
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		const state = loadState(dir);
		if (state.experienced !== true) {
			const suggestion = moveUpSuggestion(data as BenchmarkFinishedEvent, level);
			if (suggestion) ctx.ui.notify(suggestion, "info");
		}
		if (state.step === "waiting-for-benchmark") {
			saveState(dir, advance(state, { type: "benchmark-done" }, Date.now()));
			void run(ctx);
		}
	});

	const hasCommand = (name: string) => pi.getCommands().some((c) => c.name === name);
	// Commands of other extensions are started the way a user types them.
	const startCommand = (text: string) => pi.sendUserMessage(text, { expandPromptTemplates: true });

	function run(ctx: ExtensionContext): Promise<void> {
		running ??= runSteps(ctx).finally(() => {
			running = undefined;
		});
		return running;
	}

	async function runSteps(ctx: ExtensionContext): Promise<void> {
		let state = loadState(dir);
		while (!isFinished(state)) {
			const event = await runStep(state, ctx);
			if (!event) {
				ctx.ui.notify("Setup paused. Type /onboarding to continue where you stopped.", "info");
				return;
			}
			state = advance(state, event, Date.now());
			saveState(dir, state);
			// /login and /bench run in their own screens; model_select and benchmark:finished bring the flow back.
			if (state.step === "waiting-for-login" || state.step === "waiting-for-benchmark") return;
		}
	}

	function runStep(state: OnboardingState, ctx: ExtensionContext): Promise<FlowEvent | undefined> {
		const connectDeps = {
			modelsPath: options.modelsPath ?? join(getAgentDir(), "models.json"),
			setModel: (model: Model<Api>) => pi.setModel(model),
		};
		const carefulOn = hasCommand("careful");
		switch (state.step) {
			case "connect":
				return runConnect(ctx, connectDeps);
			case "waiting-for-login":
				return runWaitingForLogin(ctx, connectDeps);
			case "probe":
				if (!options.measure && !hasCommand("probe")) return Promise.resolve({ type: "probed" });
				return runProbe(ctx, options.measure ?? ((c) => measureModel(c, pi, options.capabilityDir)));
			case "experience":
				return runExperience(ctx);
			case "levels":
				if (!carefulOn) return Promise.resolve({ type: "chose-level" });
				return runLevels(ctx, state.experienced ?? false, {
					chooseLevel: (chosen) => pi.events.emit(CAREFUL_SET_EVENT, { level: chosen } satisfies CarefulSetEvent),
					modelLevel: state.recommendedLevel,
				});
			case "practice":
				return carefulOn ? runPractice(ctx) : Promise.resolve({ type: "practiced" });
			case "benchmark":
				if (!hasCommand("bench")) return Promise.resolve({ type: "benchmark-done" });
				return runBenchmarkStep(ctx, state.experienced ?? false, (args) => startCommand(`/bench ${args}`));
			case "waiting-for-benchmark":
				if (!hasCommand("bench")) return Promise.resolve({ type: "benchmark-done" });
				return runWaitingForBenchmark(ctx, (args) => startCommand(`/bench ${args}`));
			case "expectations":
				if (!hasCommand("expectations")) return Promise.resolve({ type: "saw-expectations" });
				return Promise.resolve(runExpectationsStep(ctx, () => startCommand("/expectations")));
			case "first-task":
				return runFirstTask(ctx, level);
			case "done":
			case "skipped":
				return Promise.resolve(undefined);
		}
	}

	pi.on("session_start", (event, ctx) => {
		sessionCtx = ctx;
		if (event.reason !== "startup" || ctx.mode !== "tui" || !ctx.hasUI) return;
		const state = loadState(dir);
		if (isFinished(state) || state.step === "waiting-for-login") return;
		// Not awaited: startup finishes while the first dialog waits for the user.
		void run(ctx);
	});

	pi.on("session_shutdown", () => {
		sessionCtx = undefined;
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ctx.hasUI || loadState(dir).step !== "waiting-for-login") return;
		void run(ctx);
	});

	pi.registerCommand("onboarding", {
		description:
			"Set up pi step by step: connect a model, measure it, pick how careful it should be, try a benchmark",
		getArgumentCompletions: (prefix) =>
			["restart", "skip"].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "skip") {
				saveState(dir, advance(loadState(dir), { type: "skip" }, Date.now()));
				ctx.ui.notify("Setup skipped. Run /onboarding to start it again.", "info");
				return;
			}
			// Running it again after it finished, or asking for it, starts from the beginning.
			const state = loadState(dir);
			if (arg === "restart" || isFinished(state)) saveState(dir, advance(state, { type: "restart" }, Date.now()));
			await run(ctx);
		},
	});
}

export default function onboardingExtension(pi: ExtensionAPI): void {
	createOnboardingExtension(pi);
}
