import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_FINISHED_EVENT } from "../examples/extensions/pi-guided/benchmark/events.ts";
import type { RunRecord } from "../examples/extensions/pi-guided/benchmark/store.ts";
import type { SuiteOutcome, SuiteResult } from "../examples/extensions/pi-guided/capability/index.ts";
import { type Measurements, place, SUITE_VERSION } from "../examples/extensions/pi-guided/capability/ranges.ts";
import { saveResult } from "../examples/extensions/pi-guided/capability/store.ts";
import {
	CAREFUL_CHANGED_EVENT,
	CAREFUL_SET_EVENT,
	levelInfo,
} from "../examples/extensions/pi-guided/careful/levels.ts";
import { moveUpSuggestion } from "../examples/extensions/pi-guided/onboarding/benchmark.ts";
import {
	checkConnection,
	listModels,
	mergeProvider,
	normalizeBaseUrl,
} from "../examples/extensions/pi-guided/onboarding/endpoint.ts";
import {
	advance,
	INITIAL_STATE,
	type OnboardingState,
	parseState,
} from "../examples/extensions/pi-guided/onboarding/flow.ts";
import { createOnboardingExtension } from "../examples/extensions/pi-guided/onboarding/index.ts";
import { loadState } from "../examples/extensions/pi-guided/onboarding/state.ts";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";

let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "onboarding-"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("flow", () => {
	const run = (...events: Parameters<typeof advance>[1][]): OnboardingState =>
		events.reduce((state, event) => advance(state, event, 1), INITIAL_STATE);

	it("walks newcomers through every step", () => {
		const steps = [
			{ type: "connected", model: "p/m" },
			{ type: "answered-experience", experienced: false },
			{ type: "chose-level" },
			{ type: "practiced" },
			{ type: "probed" },
			{ type: "benchmark-started" },
			{ type: "benchmark-done" },
			{ type: "saw-expectations" },
			{ type: "suggested-task" },
		] as const;
		let state = INITIAL_STATE;
		const seen = [state.step];
		for (const event of steps) {
			state = advance(state, event, 1);
			seen.push(state.step);
		}
		expect(seen).toEqual([
			"connect",
			"experience",
			"levels",
			"practice",
			"probe",
			"benchmark",
			"waiting-for-benchmark",
			"expectations",
			"first-task",
			"done",
		]);
		expect(state.connectedModel).toBe("p/m");
	});

	it("gives experienced users the short path, with the benchmark optional", () => {
		const state = run(
			{ type: "connected", model: "p/m" },
			{ type: "answered-experience", experienced: true },
			{ type: "chose-level" },
			{ type: "probed" },
		);
		expect(state.step).toBe("benchmark");
		expect(advance(advance(state, { type: "benchmark-done" }, 1), { type: "saw-expectations" }, 1).step).toBe("done");
	});

	it("waits for /login and continues when it connects", () => {
		const waiting = run({ type: "login-started" });
		expect(waiting.step).toBe("waiting-for-login");
		expect(advance(waiting, { type: "connected", model: "p/m" }, 1).step).toBe("experience");
	});

	it("ignores answers that do not belong to the current step", () => {
		expect(run({ type: "practiced" }).step).toBe("connect");
		expect(run({ type: "chose-level" }).step).toBe("connect");
	});

	it("can be skipped and restarted", () => {
		const skipped = run({ type: "connected", model: "p/m" }, { type: "skip" });
		expect(skipped.step).toBe("skipped");
		expect(advance(skipped, { type: "restart" }, 1)).toMatchObject({ step: "connect", connectedModel: undefined });
	});

	it("starts over when the saved state is unreadable", () => {
		// Version 1 had the probe before the level; its saved steps do not fit the new order.
		expect(parseState({ version: 1, step: "levels" })).toEqual(INITIAL_STATE);
		expect(parseState({ version: 2, step: "nowhere" })).toEqual(INITIAL_STATE);
		expect(parseState({ version: 2, step: "levels", experienced: true }).experienced).toBe(true);
	});
});

describe("endpoint", () => {
	const endpoint = {
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions" as const,
		apiKey: undefined,
		modelId: "qwen",
	};

	it("adds a provider to models.json and keeps what is there", () => {
		const first = mergeProvider(undefined, "local", endpoint);
		expect(first.ok && JSON.parse(first.text).providers.local).toEqual({
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			apiKey: "none",
			models: [{ id: "qwen" }],
		});
		if (!first.ok) return;
		const second = mergeProvider(first.text, "local", { ...endpoint, modelId: "other" });
		expect(second.ok && second.providerId).toBe("local-2");
		expect(second.ok && Object.keys(JSON.parse(second.text).providers)).toEqual(["local", "local-2"]);
	});

	it("refuses to rewrite files with comments or broken JSON, and offers a snippet", () => {
		const commented = mergeProvider('{\n\t// mine\n\t"providers": {}\n}', "local", endpoint);
		expect(commented).toMatchObject({ ok: false });
		expect(!commented.ok && commented.snippet).toContain('"local"');
		expect(mergeProvider("{ nope", "local", endpoint)).toMatchObject({
			ok: false,
			reason: "models.json is not plain JSON (it may have comments), and rewriting it would lose them.",
		});
	});

	it("normalizes pasted addresses", () => {
		expect(normalizeBaseUrl(" localhost:11434/v1/ ")).toBe("http://localhost:11434/v1");
		expect(normalizeBaseUrl("https://ai.example.com/v1")).toBe("https://ai.example.com/v1");
		expect(normalizeBaseUrl("   ")).toBeUndefined();
	});

	it("lists models from an OpenAI-compatible server, and returns nothing when it cannot", async () => {
		const server = await serve((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "b" }, { id: "a" }] }));
		});
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
		expect(await listModels(url, "key", AbortSignal.timeout(5000))).toEqual(["a", "b"]);
		server.close();
		expect(await listModels("http://127.0.0.1:9/v1", undefined, AbortSignal.timeout(5000))).toBeUndefined();
	});

	it("decides from the response whether the connection works", async () => {
		const registry = (reply: Partial<AssistantMessage>) =>
			({ complete: async () => ({ stopReason: "stop", ...reply }) }) as unknown as ModelRegistry;
		expect(await checkConnection(registry({}), fakeModel)).toMatchObject({ ok: true });
		expect(await checkConnection(registry({ stopReason: "error", errorMessage: "401" }), fakeModel)).toEqual({
			ok: false,
			error: "401",
		});
	});
});

describe("onboarding extension", () => {
	it("guides a newcomer: level first, then the model, then a first task", async () => {
		const h = setup({ model: fakeModel, measured: "strong" });
		h.answers.push("Use this model", "No, this is new", "2.", "No", "Continue", "Continue", "Put the example");
		await h.startSession();
		await h.idle();
		expect(loadState(h.dir).step).toBe("done");
		expect(h.levelRequests).toEqual([2]);
		expect(h.prompts[1]).toContain("Have you used an AI agent before?");
		// The only recommendation comes from the user's experience, before the model is measured.
		expect(h.prompts[2]).toContain("Pi saves the level and uses it from now on");
		expect(h.select.mock.calls[2][1]).toContain("2. Look, don't touch (recommended to start)");
		expect(h.prompts[3]).toContain("Pi wants to run a command\n\nrm results/old-run.csv");
		// The probe reports what the model handles and changes nothing.
		expect(h.prompts[5]).toContain("This model can handle up to careful level 3 Ask before changing.");
		expect(h.prompts[5]).toContain("Nothing was changed: your careful level stays at 2 Look, don't touch.");
		expect(h.prompts[5]).not.toContain("Recommended");
		expect(h.setEditorText).toHaveBeenLastCalledWith(levelInfo(2).example);
	});

	it("reuses a saved probe run for the same model and effort instead of measuring again", async () => {
		const h = setup({ model: fakeModel, measured: "chat-only" });
		saveResult(h.capabilityDir, {
			...strongResult(),
			model: "office/m1",
			thinkingLevel: "off",
			at: Date.UTC(2026, 9, 1),
		});
		h.answers.push("Use this model", "Yes", "2.", "Continue");
		await h.startSession();
		await h.idle();
		expect(h.measured).toEqual([]);
		expect(h.prompts[3]).toContain("so it does not measure it again. Run /probe again to measure anew.");
		expect(h.prompts[3]).toContain("This model can handle up to careful level 3");
	});

	it("offers to lower the level when the model cannot handle it", async () => {
		const h = setup({ model: fakeModel, measured: "chat-only" });
		h.answers.push("Use this model", "No, this is new", "2.", "No", "Continue", "Lower", "Put the example");
		await h.startSession();
		await h.idle();
		expect(h.prompts[5]).toContain(
			"You picked level 2 Look, don't touch, but this model handles only up to level 1 Only what I share.",
		);
		expect(h.levelRequests).toEqual([2, 1]);
		expect(h.setEditorText).toHaveBeenLastCalledWith(levelInfo(1).example);
	});

	it("continues setup when the model cannot be measured", async () => {
		const h = setup({ model: fakeModel, measured: "error" });
		h.answers.push("Use this model", "Yes", "3.", "Continue");
		await h.startSession();
		await h.idle();
		expect(h.prompts[3]).toContain("could not measure the model (timeout)");
		expect(loadState(h.dir).step).toBe("done");
		expect(h.levelRequests).toEqual([3]);
	});

	it("shows experienced users the levels and settings, then stops", async () => {
		const h = setup({ model: fakeModel });
		h.answers.push("Use this model", "Yes", "4.");
		await h.startSession();
		await h.idle();
		expect(loadState(h.dir).step).toBe("done");
		expect(h.levelRequests).toEqual([4]);
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("/probe (measure the model)");
	});

	it("skips the level steps when careful levels are turned off", async () => {
		const h = setup({ model: fakeModel, careful: false });
		h.answers.push("Use this model", "No, this is new", "Put the example");
		await h.startSession();
		await h.idle();
		expect(loadState(h.dir).step).toBe("done");
		expect(h.levelRequests).toEqual([]);
		expect(h.prompts[2]).toContain("A good first task is:");
		expect(h.setEditorText).toHaveBeenLastCalledWith(levelInfo(4).example);
	});

	it("runs the first benchmark through /bench, waits for it, then shows the expectations card", async () => {
		const h = setup({ model: fakeModel, commands: ["careful", "bench", "expectations"] });
		h.answers.push("Use this model", "No, this is new", "2.", "No", "Continue", "Run the example");
		await h.startSession();
		await h.idle();
		expect(h.sent).toEqual(["/bench run example:lab-data"]);
		expect(loadState(h.dir).step).toBe("waiting-for-benchmark");

		h.answers.push("Put the example");
		h.emitBus(BENCHMARK_FINISHED_EVENT, { ladderName: "x", runs: [], stopped: false });
		await h.idle();
		expect(h.sent).toEqual(["/bench run example:lab-data", "/expectations"]);
		expect(loadState(h.dir).step).toBe("done");
	});

	it("suggests the next level when every benchmark task at the current level passed", () => {
		const passed = { level: 2, outcome: "pass" } as RunRecord;
		const event = (runs: RunRecord[]) => ({ ladderName: "x", runs, stopped: false });
		expect(moveUpSuggestion(event([passed, { ...passed, level: 1 }]), 2)).toContain(
			"/careful 3 (Ask before changing)",
		);
		expect(moveUpSuggestion(event([passed, { ...passed, outcome: "partial" }]), 2)).toBeUndefined();
		expect(moveUpSuggestion(event([{ ...passed, level: 3 }]), 2)).toBeUndefined();
		expect(moveUpSuggestion(event([{ ...passed, level: 3 }]), 3)).toContain("backup");
		expect(moveUpSuggestion(event([{ ...passed, level: 4 }]), 4)).toBeUndefined();
		expect(moveUpSuggestion(event([passed]), undefined)).toBeUndefined();
	});

	it("pauses on Escape and resumes where it stopped", async () => {
		const h = setup({ model: fakeModel });
		h.answers.push("Use this model", "<dismiss>");
		await h.startSession();
		await h.idle();
		expect(loadState(h.dir).step).toBe("experience");
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("/onboarding");

		h.answers.push("Yes", "2.");
		await h.command("onboarding", "");
		expect(loadState(h.dir).step).toBe("done");
		expect(h.prompts.at(-2)).toContain("Have you used an AI agent before?");
	});

	it("hands off to /login and continues when it selects a model", async () => {
		const h = setup({});
		h.answers.push("I have an account");
		await h.startSession();
		await h.idle();
		expect(h.setEditorText).toHaveBeenLastCalledWith("/login");
		expect(loadState(h.dir).step).toBe("waiting-for-login");

		h.setCurrentModel(fakeModel);
		h.answers.push("<dismiss>");
		await h.emit("model_select");
		await h.idle();
		expect(loadState(h.dir).step).toBe("experience");
	});

	it("adds an address from the office to models.json and selects its model", async () => {
		const server = await serve((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ data: [{ id: "office-model" }] }));
		});
		const port = (server.address() as AddressInfo).port;
		const h = setup({});
		h.answers.push("I have an address", "OpenAI-compatible", "office-model", "<dismiss>");
		h.inputs.push(`127.0.0.1:${port}/v1`, "secret");
		await h.startSession();
		await h.idle();
		server.close();
		const models = JSON.parse(readFileSync(h.modelsPath, "utf-8"));
		expect(models.providers.local).toMatchObject({
			baseUrl: `http://127.0.0.1:${port}/v1`,
			apiKey: "secret",
			models: [{ id: "office-model" }],
		});
		expect(h.setModel).toHaveBeenCalledTimes(1);
		expect(loadState(h.dir)).toMatchObject({ step: "experience", connectedModel: "local/office-model" });
	});

	it("runs only at an interactive startup and not again once done", async () => {
		const h = setup({ model: fakeModel, mode: "print" });
		await h.startSession();
		expect(h.select).not.toHaveBeenCalled();

		const done = setup({ model: fakeModel });
		mkdirSync(done.dir, { recursive: true });
		writeFileSync(join(done.dir, "state.json"), JSON.stringify({ version: 2, step: "done" }));
		await done.startSession();
		expect(done.select).not.toHaveBeenCalled();
	});
});

const fakeModel = { provider: "office", id: "m1", name: "Model One" } as Model<Api>;

/** A probe result for fakeModel from a model that answers tool requests in text: handles level 1 at most. */
function chatOnlyResult(): SuiteResult {
	return result({ tools: score(0, 3), instructions: score(2, 3), retrieval: { ...score(1, 2), approxTokens: 8000 } });
}

/** A probe result from a model that passed every basic probe: handles up to level 3. */
function strongResult(): SuiteResult {
	return result({ multiStep: { ...score(3, 3), toolCalls: 4 } });
}

function score(passed: number, total: number) {
	return { passed, total, notes: [] };
}

function result(overrides: Partial<Measurements>): SuiteResult {
	const measurements: Measurements = {
		contextWindow: 32_000,
		speed: { firstTokenMs: 800, tokensPerSecond: 25 },
		tools: score(3, 3),
		instructions: score(3, 3),
		retrieval: { ...score(2, 2), approxTokens: 8000 },
		multiStep: { ...score(0, 3), toolCalls: 0 },
		hard: undefined,
		...overrides,
	};
	return {
		suiteVersion: SUITE_VERSION,
		model: "office/m1",
		modelName: "Model One",
		thinkingLevel: "off",
		at: 0,
		durationMs: 1000,
		measurements,
		placement: place(measurements, false),
	};
}

function serve(handler: Parameters<typeof createServer>[1]): Promise<Server> {
	return new Promise((resolve) => {
		const server = createServer(handler);
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
}

function setup(options: {
	model?: Model<Api>;
	mode?: "tui" | "print";
	measured?: "chat-only" | "strong" | "error";
	careful?: boolean;
	/** Commands of other extensions that are on. Defaults to careful only. */
	commands?: string[];
}) {
	const dir = join(base, "onboarding");
	const modelsPath = join(base, "models.json");
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const answers: string[] = [];
	const inputs: string[] = [];
	const prompts: string[] = [];
	const levelRequests: number[] = [];
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const capabilityDir = join(base, "capability");
	const measured: string[] = [];
	const commandNames = options.commands ?? (options.careful === false ? [] : ["careful"]);
	const careful = commandNames.includes("careful");
	const sent: string[] = [];
	let model = options.model;
	const registered: Model<Api>[] = [];

	const setModel = vi.fn(async (next: Model<Api>) => {
		model = next;
		return true;
	});
	const api = {
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			commands.set(name, command.handler);
		},
		getCommands: () => commandNames.map((name) => ({ name })),
		getThinkingLevel: () => "off",
		sendUserMessage: (text: string) => sent.push(text),
		setModel,
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => undefined;
			},
			emit(channel: string, data: unknown) {
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;
	const measure = async (): Promise<SuiteOutcome | undefined> => {
		measured.push("measured");
		if (options.measured === undefined) return undefined;
		if (options.measured === "error") return { ok: false, error: "timeout" };
		return { ok: true, result: options.measured === "strong" ? strongResult() : chatOnlyResult() };
	};
	createOnboardingExtension(api, { dir, modelsPath, measure, capabilityDir });
	// Stands in for the careful extension: it applies a requested level and reports it.
	if (careful) {
		api.events.on(CAREFUL_SET_EVENT, (data) => {
			const { level } = data as { level: number };
			levelRequests.push(level);
			api.events.emit(CAREFUL_CHANGED_EVENT, { level });
		});
		api.events.emit(CAREFUL_CHANGED_EVENT, { level: 2 });
	}

	const select = vi.fn(async (title: string, opts: string[]) => {
		prompts.push(title);
		const want = answers.shift();
		if (want === undefined) throw new Error(`unexpected prompt: ${title.split("\n")[0]}`);
		if (want === "<dismiss>") return undefined;
		const match = opts.find((o) => o.startsWith(want));
		if (!match) throw new Error(`no option starting with "${want}" in ${JSON.stringify(opts)}`);
		return match;
	});
	const input = vi.fn(async () => inputs.shift());
	const notify = vi.fn();
	const setEditorText = vi.fn();
	const registry = {
		hasConfiguredAuth: () => true,
		complete: async () => ({ stopReason: "stop" }),
		refresh: async () => {
			const file = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
				providers: Record<string, { models: { id: string }[] }>;
			};
			for (const [provider, entry] of Object.entries(file.providers)) {
				for (const m of entry.models) registered.push({ provider, id: m.id, name: m.id } as Model<Api>);
			}
		},
		find: (provider: string, id: string) => registered.find((m) => m.provider === provider && m.id === id),
	};
	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: true,
		cwd: join(base, "project"),
		get model() {
			return model;
		},
		modelRegistry: registry,
		ui: { select, input, notify, setEditorText },
	} as unknown as ExtensionContext;

	const emit = async (event: string, payload: unknown = { type: event }) => {
		for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
	};
	return {
		dir,
		modelsPath,
		answers,
		inputs,
		prompts,
		levelRequests,
		sent,
		measured,
		capabilityDir,
		emitBus: (channel: string, data: unknown) => api.events.emit(channel, data),
		select,
		notify,
		setEditorText,
		setModel,
		setCurrentModel(next: Model<Api>) {
			model = next;
		},
		emit,
		startSession: () => emit("session_start", { type: "session_start", reason: "startup" }),
		command: (name: string, args: string) => commands.get(name)!(args, ctx),
		// The flow runs in the background after session_start; wait for its dialogs to drain.
		idle: () => vi.waitFor(() => expect(answers).toHaveLength(0)).then(() => new Promise((r) => setTimeout(r, 20))),
	};
}
