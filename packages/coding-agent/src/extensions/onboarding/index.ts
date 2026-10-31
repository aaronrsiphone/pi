/**
 * Guided onboarding: connect a model, measure it, then learn the careful levels and try a first task.
 *
 * Pi drives every step in code (flow.ts); the model only answers the connection check and the
 * capability probes, which pi grades. Setup starts once on the first interactive start, can be
 * paused with Escape, resumes where it stopped, and runs again with /onboarding. One answer
 * ("I have used an agent") takes the short path.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getModelsPath } from "../../config.ts";
import type { ExtensionAPI, ExtensionContext } from "../../core/extensions/types.ts";
import { measureModel, type SuiteOutcome } from "../capability/index.ts";
import { defaultCapabilityDir, loadResults } from "../capability/store.ts";
import { MODE_CHANGED_EVENT, savedMode, saveMode } from "../permissions/index.ts";
import { DEFAULT_MODE } from "../permissions/levels.ts";
import { runConnect, runWaitingForLogin } from "./connect.ts";
import { advance, type FlowEvent, isFinished, type OnboardingState } from "./flow.ts";
import { runProbe } from "./measure.ts";
import { defaultOnboardingDir, loadState, saveState } from "./state.ts";
import { runExperience, runFirstTask, runLevels, runPractice } from "./walkthrough.ts";

export interface OnboardingOptions {
	/** Where progress is saved. Defaults to ~/.pi/agent/onboarding. */
	dir?: string;
	/** The permissions extension's state directory, for saving the chosen level. */
	permissionsStateDir?: string;
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
			// /login runs in pi's own screen; model_select brings the flow back.
			if (state.step === "waiting-for-login") return;
		}
	}

	function runStep(state: OnboardingState, ctx: ExtensionContext): Promise<FlowEvent | undefined> {
		const connectDeps = {
			modelsPath: options.modelsPath ?? getModelsPath(),
			setModel: (model: Model<Api>) => pi.setModel(model),
		};
		const currentMode = () => savedMode(options.permissionsStateDir) ?? DEFAULT_MODE;
		switch (state.step) {
			case "connect":
				return runConnect(ctx, connectDeps);
			case "waiting-for-login":
				return runWaitingForLogin(ctx, connectDeps);
			case "probe":
				return runProbe(ctx, options.measure ?? ((c) => measureModel(c, pi, options.capabilityDir)));
			case "experience":
				return runExperience(ctx);
			case "levels":
				return runLevels(ctx, state.experienced ?? false, {
					levelsAvailable: pi.getCommands().some((c) => c.name === "careful"),
					chooseMode: (mode) => {
						saveMode(mode, options.permissionsStateDir);
						pi.events.emit(MODE_CHANGED_EVENT, undefined);
					},
					modelLevel: state.connectedModel
						? loadResults(options.capabilityDir ?? defaultCapabilityDir(), state.connectedModel)[0]?.placement
								.recommendations.carefulLevel
						: undefined,
				});
			case "practice":
				return runPractice(ctx);
			case "first-task":
				return runFirstTask(ctx, currentMode());
			case "done":
			case "skipped":
				return Promise.resolve(undefined);
		}
	}

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup" || ctx.mode !== "tui" || !ctx.hasUI) return;
		const state = loadState(dir);
		if (isFinished(state) || state.step === "waiting-for-login") return;
		// Not awaited: startup finishes while the first dialog waits for the user.
		void run(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (!ctx.hasUI || loadState(dir).step !== "waiting-for-login") return;
		void run(ctx);
	});

	pi.registerCommand("onboarding", {
		description: "Set up pi step by step: connect a model, pick how careful it should be (restart, skip)",
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
