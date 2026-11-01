import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
	type FauxProviderRegistration,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentTools,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProbeClient } from "../examples/extensions/pi-guided/capability/client.ts";
import { buildCard } from "../examples/extensions/pi-guided/capability/expectations.ts";
import { probeReasoning } from "../examples/extensions/pi-guided/capability/hard-probes.ts";
import { probeMultiStep } from "../examples/extensions/pi-guided/capability/multistep.ts";
import { buildHaystack, probeRetrieval, probeToolCalls } from "../examples/extensions/pi-guided/capability/probes.ts";
import { type Measurements, place, SUITE_VERSION } from "../examples/extensions/pi-guided/capability/ranges.ts";
import { loadResults, saveResult } from "../examples/extensions/pi-guided/capability/store.ts";
import { estimateCost, runSuite, type SuiteResult } from "../examples/extensions/pi-guided/capability/suite.ts";
import { describeResult } from "../examples/extensions/pi-guided/capability/summary.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { fauxAgentDir } from "./pi-guided-faux.ts";

let faux: FauxProviderRegistration;
let base: string;

beforeEach(() => {
	faux = registerFauxProvider();
	base = mkdtempSync(join(tmpdir(), "capability-"));
});

afterEach(() => {
	faux.unregister();
	rmSync(base, { recursive: true, force: true });
});

function client(contextWindow = 200_000): ProbeClient {
	return {
		model: { ...faux.getModel(), contextWindow, reasoning: true },
		thinkingLevel: "off",
		// The faux provider is reached through pi-ai's dispatcher, as a real provider would be.
		registry: { streamSimple } as unknown as ModelRegistry,
		agentDir: fauxAgentDir(faux, base),
	};
}

/** Last user prompt text in a request, to script answers per probe. */
const lastUserText = (context: Parameters<FauxResponseFactory>[0]): string => {
	const user = context.messages.filter((m) => m.role === "user").at(-1);
	return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
};

const countToolResults = (context: Parameters<FauxResponseFactory>[0]) =>
	context.messages.filter((m) => m.role === "toolResult").length;

/** A model that answers every probe correctly, the harder tier included. */
const advancedModel: FauxResponseFactory = (context) => {
	const text = lastUserText(context);
	const hard = hardAnswers(text);
	if (hard) return hard;
	if (getCurrentTools(context.messages).some((t) => t.name === "convert_units")) {
		if (text.includes("psi to kPa")) return toolUse("convert_units", { value: 30, from: "psi", to: "kPa" });
		if (text.includes("Plot")) return toolUse("plot", { x_column: "time", y_column: "temperature", title: "Run 7" });
		return toolUse("read_file", { path: "data/run_07.csv" });
	}
	if (text.includes("Switch its pressure settings")) {
		const step = [
			() => toolUse("ls", { path: "config" }),
			() => toolUse("read", { path: "config/settings.txt" }),
			() =>
				toolUse("edit", {
					path: "config/settings.txt",
					edits: [
						{
							oldText: "pressure_units = psi\nthreshold = 40",
							newText: "pressure_units = kPa\nthreshold = 275.8",
						},
					],
				}),
			() => toolUse("read", { path: "config/settings.txt" }),
			() => fauxAssistantMessage("Done: units are kPa and the threshold is 275.8."),
		][countToolResults(context)];
		return step();
	}
	if (text.includes("Count from 1 to 60"))
		return fauxAssistantMessage(Array.from({ length: 60 }, (_, i) => i + 1).join(" "));
	if (text.includes("JSON object")) return fauxAssistantMessage('{"sample_rate": 48000, "channels": 2}');
	if (text.includes("three lines")) return fauxAssistantMessage("- Check seals\n- Check gauge\n- Check relief valve");
	if (text.includes("YES or NO")) return fauxAssistantMessage("NO");
	if (text.includes("calibration code for sensor B7")) return fauxAssistantMessage("1. 4197\n2. Cabinet 41");
	return fauxAssistantMessage("OK");
};

/** Right answers to the harder tier. */
function hardAnswers(text: string) {
	if (text.includes("sensor K3")) return fauxAssistantMessage("1. 6033\n2. 5821\n3. 312 kPa");
	if (text.includes("trapezoidal")) return fauxAssistantMessage("LINE: 12\nThe trapezoid is not halved.");
	if (text.includes("PSI_TO_KPA")) return fauxAssistantMessage("LINE: 17\nThe values are already in kPa.");
	if (text.includes("bank_angle_deg")) {
		return fauxAssistantMessage(
			'{"bank_angle_deg": 80.4, "turn_rate_rad_s": 0.232, "t180_s": 12.83, "range_accel_m_s2": -8.9, "missile_accel_m_s2": 129.6, "turn_rate_change_rad_s2": 0.00186}',
		);
	}
	return undefined;
}

/** Passes every basic probe but stumbles on the harder tier: misses the bugs, uses constant speed. */
const strongModel: FauxResponseFactory = (...args) => {
	const text = lastUserText(args[0]);
	if (text.includes("sensor K3")) return fauxAssistantMessage("1. 5821\n2. 5821\n3. 312 kPa");
	if (text.includes("LINE:")) return fauxAssistantMessage("LINE: 4\nThe header row is skipped.");
	if (text.includes("bank_angle_deg")) {
		return fauxAssistantMessage(
			'{"bank_angle_deg": 80.4, "turn_rate_rad_s": 0.232, "t180_s": 13.53, "range_accel_m_s2": 24.3, "missile_accel_m_s2": 129.6, "turn_rate_change_rad_s2": 0}',
		);
	}
	return advancedModel(...args);
};

/** A small model: chats fine, answers tool requests in text, and does not finish the task. */
const weakModel: FauxResponseFactory = (context) => {
	const text = lastUserText(context);
	if (text.includes("Count from 1 to 60")) return fauxAssistantMessage("1 2 3 4 5 6 7 8 9 10");
	if (getCurrentTools(context.messages).some((t) => t.name === "convert_units")) {
		return fauxAssistantMessage("30 psi is about 206.8 kPa.");
	}
	if (text.includes("JSON object")) return fauxAssistantMessage('Sure! ```json\n{"sample_rate": 48}\n```');
	if (text.includes("calibration code")) return fauxAssistantMessage("1. 5521\n2. Cabinet 12");
	return fauxAssistantMessage("I would edit the settings file to use kPa.");
};

function toolUse(name: string, args: JsonObject) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function script(model: FauxResponseFactory, count = 60) {
	faux.setResponses(Array.from({ length: count }, () => model));
}

describe("probes", () => {
	it("checks tool calls in code and explains each failure", async () => {
		faux.setResponses([
			toolUse("convert_units", { value: 30, from: "psi", to: "kPa" }),
			fauxAssistantMessage("I opened it."),
			toolUse("plot", { x_column: "temperature", y_column: "time", title: "Run 7" }),
		]);
		const result = await probeToolCalls(client());
		expect(result.passed).toBe(1);
		expect(result.notes).toEqual([
			'"Open the file data/run_07.csv.": answered in text instead of calling a tool',
			expect.stringContaining("wrong arguments"),
		]);
	});

	it("hides two facts among similar ones and sizes the text to the context window", async () => {
		const text = buildHaystack(8000);
		expect(text.match(/4197/g)).toHaveLength(1);
		expect(text.match(/cabinet 41\b/g)).toHaveLength(1);
		expect(text.length).toBeGreaterThan(30_000);
		script(strongModel, 1);
		expect(await probeRetrieval(client(8000), 8000)).toMatchObject({ passed: 2, approxTokens: 4000 });
	});

	it("scores the multi-step task from the files and tool calls, not from the model's claims", async () => {
		script(strongModel, 5);
		expect(await probeMultiStep(client())).toMatchObject({ passed: 3, total: 3, toolCalls: 4 });

		// Claims success without reading back, and edits the example file too.
		faux.setResponses([
			toolUse("edit", {
				path: "config/settings.txt",
				edits: [{ oldText: "psi\nthreshold = 40", newText: "kPa\nthreshold = 275.8" }],
			}),
			toolUse("edit", { path: "config/settings.example.txt", edits: [{ oldText: "psi", newText: "kPa" }] }),
			fauxAssistantMessage("Done and verified."),
		]);
		const sloppy = await probeMultiStep(client());
		expect(sloppy.passed).toBe(1);
		expect(sloppy.notes).toEqual([
			"changed files it should have left alone: config/settings.example.txt",
			"did not read the file back after changing it",
		]);
	});
});

describe("suite", () => {
	it("places a model that passes the harder tier in the top class and recommends level 3", async () => {
		script(advancedModel);
		const outcome = await runSuite(client(), () => undefined);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) return;
		const { placement } = outcome.result;
		expect(placement.modelClass).toBe("advanced");
		expect(placement.recommendations).toMatchObject({
			carefulLevel: 3,
			taskSize: "larger changes across several files",
			doubleCheck: ["numbers, units, and calculations"],
		});
		expect(outcome.result.suiteVersion).toBe(SUITE_VERSION);
	});

	it("tells a model that passes the basics but not the harder tier apart, and says what to check", async () => {
		script(strongModel);
		const outcome = await runSuite(client(), () => undefined);
		if (!outcome.ok) throw new Error(outcome.error);
		const { placement, measurements } = outcome.result;
		expect(placement.modelClass).toBe("strong");
		expect(measurements.hard?.reasoning).toEqual({
			passed: 3,
			total: 6,
			notes: [
				"t180_s: 13.53, expected 12.83",
				"range_accel_m_s2: 24.3, expected -8.92",
				"turn_rate_change_rad_s2: 0, expected 0.001857",
			],
		});
		expect(placement.ranges.bugFinding).toMatchObject({ tier: "low", detail: "0 of 2" });
		expect(placement.recommendations.doubleCheck).toEqual([
			"numbers, units, and calculations",
			"every step of multi-part calculations",
			"code it reviews: it can miss subtle bugs",
			"facts from very long files, and whether a later note replaced them",
		]);
	});

	it("runs the harder tier only for models that pass every basic probe", async () => {
		script(weakModel);
		const outcome = await runSuite(client(), () => undefined);
		if (!outcome.ok) throw new Error(outcome.error);
		expect(outcome.result.measurements.hard).toBeUndefined();
		expect(outcome.result.placement.hardRun).toBe(false);
		expect(describeResult(outcome.result).join("\n")).not.toContain("Finding a bug");
	});

	it("skips the very long text when the context window cannot hold it", async () => {
		script(advancedModel);
		const outcome = await runSuite(client(32_000), () => undefined);
		if (!outcome.ok) throw new Error(outcome.error);
		expect(outcome.result.measurements.hard?.longRetrieval).toBeUndefined();
		expect(outcome.result.placement.ranges.longRetrieval).toMatchObject({
			label: "Not run",
			detail: "the context window is too short",
		});
		// A skipped probe does not cost the class.
		expect(outcome.result.placement.modelClass).toBe("advanced");
	});

	it("gives the same verdict when re-run on the same model", async () => {
		const verdicts: string[] = [];
		for (let i = 0; i < 2; i++) {
			script(weakModel);
			const outcome = await runSuite(client(), () => undefined);
			if (outcome.ok) verdicts.push(JSON.stringify(outcome.result.placement));
		}
		expect(verdicts).toHaveLength(2);
		expect(verdicts[0]).toBe(verdicts[1]);
	});

	it("places a model that cannot call tools as chat-only, and says where to check its work", async () => {
		script(weakModel);
		const outcome = await runSuite(client(), () => undefined);
		if (!outcome.ok) throw new Error(outcome.error);
		const { placement } = outcome.result;
		expect(placement.modelClass).toBe("chat-only");
		expect(placement.recommendations.carefulLevel).toBe(1);
		expect(placement.recommendations.doubleCheck).toContain("facts it quotes from long files");
		expect(placement.ranges.tools).toMatchObject({ tier: "low", label: "Unreliable", detail: "0 of 3" });
	});

	it("stops without scoring when the server keeps failing", { timeout: 20_000 }, async () => {
		const failure = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" });
		faux.setResponses([failure, failure, failure]);
		const outcome = await runSuite(client(), () => undefined);
		expect(outcome).toMatchObject({ ok: false });
		if (!outcome.ok) expect(outcome.error).toContain("server kept failing (503 overloaded)");
	});

	// Calibration on hosted models: an overloaded server once cost a model a point and its class.
	it("retries a server failure instead of scoring the model down", { timeout: 20_000 }, async () => {
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "503 overloaded" }),
			toolUse("convert_units", { value: 30, from: "psi", to: "kPa" }),
			toolUse("read_file", { path: "data/run_07.csv" }),
			toolUse("plot", { x_column: "time", y_column: "temperature", title: "Run 7" }),
		]);
		expect(await probeToolCalls(client())).toEqual({ passed: 3, total: 3, notes: [] });
	});

	// Calibration: reasoning models that thought for minutes were retried as "server failures".
	it("scores an answer that runs out of time as missed, without retrying it", async () => {
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" }),
			fauxAssistantMessage("never asked"),
		]);
		expect(await probeReasoning(client())).toEqual({ passed: 0, total: 6, notes: ["no answer within 180 s"] });
		expect(faux.getPendingResponseCount()).toBe(1);
	});

	it("reports progress for every step", async () => {
		script(advancedModel);
		const steps: number[] = [];
		await runSuite(client(), (i) => steps.push(i));
		expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	});

	it("estimates the cost of a run from model prices", () => {
		expect(estimateCost({ input: 3, output: 15 })).toBeCloseTo(0.33);
	});
});

describe("ranges", () => {
	const measured = (overrides: Partial<Measurements> = {}): Measurements => ({
		contextWindow: 128_000,
		speed: { firstTokenMs: 400, tokensPerSecond: 60 },
		tools: { passed: 3, total: 3, notes: [] },
		instructions: { passed: 3, total: 3, notes: [] },
		retrieval: { passed: 2, total: 2, notes: [], approxTokens: 8000 },
		multiStep: { passed: 3, total: 3, notes: [], toolCalls: 4 },
		hard: undefined,
		...overrides,
	});

	it("names speed tiers in plain words", () => {
		const tier = (tokensPerSecond: number, firstTokenMs = 500) =>
			place(measured({ speed: { firstTokenMs, tokensPerSecond } }), true).ranges.speed.label;
		expect([tier(5), tier(20), tier(80), tier(80, 15_000)]).toEqual(["Slow", "Usable", "Fast", "Usable"]);
	});

	it("starts slow models at low effort and leaves effort out for models without reasoning", () => {
		expect(place(measured({ speed: { firstTokenMs: 900, tokensPerSecond: 8 } }), true).recommendations.effort).toBe(
			"low",
		);
		expect(place(measured(), true).recommendations.effort).toBe("medium");
		expect(place(measured(), false).recommendations.effort).toBeUndefined();
	});

	it("needs the multi-step task for the capable class", () => {
		const partly = measured({ multiStep: { passed: 2, total: 3, notes: [], toolCalls: 3 } });
		expect(place(partly, true).modelClass).toBe("capable");
		expect(place(partly, true).ranges.multiStep.label).toBe("Partly done");
		const failed = measured({ multiStep: { passed: 1, total: 3, notes: [], toolCalls: 1 } });
		expect(place(failed, true).modelClass).toBe("basic");
		expect(place(failed, true).recommendations).toMatchObject({ carefulLevel: 2, taskSize: "one file at a time" });
	});

	it("flags a short context window", () => {
		const short = place(measured({ contextWindow: 8192 }), true);
		expect(short.ranges.context.label).toBe("Short: a few pages at a time");
		expect(short.recommendations.doubleCheck).toContain("that it saw the whole of a long file");
	});
});

describe("results", () => {
	it("keeps a short history per model and ignores results of other suite versions", async () => {
		script(strongModel);
		const outcome = await runSuite(client(), () => undefined);
		if (!outcome.ok) throw new Error(outcome.error);
		const old: SuiteResult = { ...outcome.result, suiteVersion: SUITE_VERSION - 1 };
		saveResult(base, old);
		for (let i = 0; i < 12; i++) saveResult(base, { ...outcome.result, at: i });
		const results = loadResults(base, outcome.result.model);
		expect(results).toHaveLength(10);
		expect(results[0].at).toBe(11);
	});

	it("describes a run in plain words", async () => {
		script(advancedModel);
		const outcome = await runSuite(client(), () => undefined);
		if (!outcome.ok) throw new Error(outcome.error);
		const text = describeResult(outcome.result).join("\n");
		expect(text).toContain(": Advanced. Passed the basic and the harder checks");
		expect(text).toContain("Using tools: Reliable (3 of 3)");
		expect(text).toContain("Small multi-step task: Done right (3 of 3 checks)");
		expect(text).toContain("Facts in a very long text: Reliable (3 of 3 in ~30k tokens)");
		expect(text).toContain("An engineering calculation: Reliable (6 of 6)");
		expect(text).toContain(
			"Recommended: careful level 3 (Ask before changing), larger changes across several files, thinking effort medium.",
		);
	});
});

describe("expectations card", () => {
	const measurements: Measurements = {
		contextWindow: 128_000,
		speed: { firstTokenMs: 400, tokensPerSecond: 60 },
		tools: { passed: 3, total: 3, notes: [] },
		instructions: { passed: 2, total: 3, notes: [] },
		retrieval: { passed: 2, total: 2, notes: [], approxTokens: 8000 },
		multiStep: { passed: 1, total: 3, notes: [], toolCalls: 2 },
		hard: undefined,
	};
	const basic: SuiteResult = {
		suiteVersion: SUITE_VERSION,
		model: "p/m",
		modelName: "Model",
		thinkingLevel: "medium",
		at: 0,
		durationMs: 1000,
		measurements,
		placement: place(measurements, true),
	};
	const text = (sections: ReturnType<typeof buildCard>) =>
		sections.map((s) => `${s.title}\n${s.lines.join("\n")}`).join("\n\n");

	it("shows the class, what went well, where to check, and recommended against current settings", () => {
		const card = text(
			buildCard({
				modelName: "Model",
				result: basic,
				sections: [{ title: "Your benchmarks", lines: ["3 of 4 task(s) passed"] }],
				currentLevel: 3,
				currentEffort: "high",
			}),
		);
		expect(card).toContain("What to expect from Model: Basic");
		expect(card).toContain("Did well: speed, context, using tools, finding facts in long text.");
		expect(card).toContain("Your benchmarks\n3 of 4 task(s) passed");
		expect(card).toContain("  - every file it changed");
		expect(card).toContain("Careful level: now 3 Ask before changing, recommended 2 Look, don't touch.");
		expect(card).toContain("Thinking effort: now high, recommended medium.");
	});

	it("asks for a probe when the model was not measured, and works without careful levels", () => {
		const card = text(
			buildCard({
				modelName: "Model",
				result: undefined,
				sections: [],
				currentLevel: undefined,
				currentEffort: "off",
			}),
		);
		expect(card).toContain("Not measured yet. Run /probe");
		expect(card).toContain("Careful level: now careful levels off.");
	});
});
