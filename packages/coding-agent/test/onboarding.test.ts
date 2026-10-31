import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "../src/core/extensions/index.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import type { SuiteOutcome, SuiteResult } from "../src/extensions/capability/index.ts";
import { place, SUITE_VERSION } from "../src/extensions/capability/ranges.ts";
import { saveResult } from "../src/extensions/capability/store.ts";
import { checkConnection, listModels, mergeProvider, normalizeBaseUrl } from "../src/extensions/onboarding/endpoint.ts";
import { advance, INITIAL_STATE, type OnboardingState, parseState } from "../src/extensions/onboarding/flow.ts";
import { createOnboardingExtension } from "../src/extensions/onboarding/index.ts";
import { loadState } from "../src/extensions/onboarding/state.ts";
import { MODE_CHANGED_EVENT, savedMode } from "../src/extensions/permissions/index.ts";
import { levelInfo } from "../src/extensions/permissions/levels.ts";

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
			{ type: "probed" },
			{ type: "answered-experience", experienced: false },
			{ type: "chose-level" },
			{ type: "practiced" },
			{ type: "suggested-task" },
		] as const;
		let state = INITIAL_STATE;
		const seen = [state.step];
		for (const event of steps) {
			state = advance(state, event, 1);
			seen.push(state.step);
		}
		expect(seen).toEqual(["connect", "probe", "experience", "levels", "practice", "first-task", "done"]);
		expect(state.connectedModel).toBe("p/m");
	});

	it("gives experienced users the short path", () => {
		const state = run(
			{ type: "connected", model: "p/m" },
			{ type: "probed" },
			{ type: "answered-experience", experienced: true },
			{ type: "chose-level" },
		);
		expect(state.step).toBe("done");
	});

	it("waits for /login and continues when it connects", () => {
		const waiting = run({ type: "login-started" });
		expect(waiting.step).toBe("waiting-for-login");
		expect(advance(waiting, { type: "connected", model: "p/m" }, 1).step).toBe("probe");
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
		expect(parseState({ version: 2, step: "done" })).toEqual(INITIAL_STATE);
		expect(parseState({ version: 1, step: "nowhere" })).toEqual(INITIAL_STATE);
		expect(parseState({ version: 1, step: "levels", experienced: true }).experienced).toBe(true);
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
			reason: "models.json is not valid JSON.",
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
	it("guides a newcomer from a connected model to a first task", async () => {
		const h = setup({ model: fakeModel, measured: "chat-only" });
		h.answers.push("Use this model", "Continue", "No, this is new", "3.", "No", "Continue", "Put the example");
		await h.startSession();
		await h.idle();
		expect(loadState(h.dir).step).toBe("done");
		expect(savedMode(h.permissionsDir)).toBe(3);
		expect(h.busEvents).toEqual([MODE_CHANGED_EVENT]);
		expect(h.prompts[1]).toContain("Here is what pi measured");
		// The probe found a chat-only model, so level 1 is recommended instead of the usual 2.
		expect(h.select.mock.calls[3][1]).toContain("1. Only what I share (recommended to start)");
		expect(h.prompts[3]).toContain("Start at level 1");
		expect(h.prompts[4]).toContain("Practice");
		expect(h.prompts[4]).toContain("deletes results/old-run.csv");
		expect(h.setEditorText).toHaveBeenLastCalledWith(levelInfo(3).example);
	});

	it("continues setup when the model cannot be measured", async () => {
		const h = setup({ model: fakeModel, measured: "error" });
		h.answers.push("Use this model", "Continue", "<dismiss>");
		await h.startSession();
		await h.idle();
		expect(h.prompts[1]).toContain("could not measure the model (timeout)");
		expect(loadState(h.dir).step).toBe("experience");
	});

	it("shows experienced users the levels and settings, then stops", async () => {
		const h = setup({ model: fakeModel });
		h.answers.push("Use this model", "Yes", "4.");
		await h.startSession();
		await h.idle();
		expect(loadState(h.dir).step).toBe("done");
		expect(savedMode(h.permissionsDir)).toBe(4);
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("/permissions");
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
		writeFileSync(join(done.dir, "state.json"), JSON.stringify({ version: 1, step: "done" }));
		await done.startSession();
		expect(done.select).not.toHaveBeenCalled();
	});
});

const fakeModel = { provider: "office", id: "m1", name: "Model One" } as Model<Api>;

/** A probe result for fakeModel from a model that answers tool requests in text. */
function chatOnlyResult(): SuiteResult {
	const score = (passed: number, total: number) => ({ passed, total, notes: [] });
	const measurements = {
		contextWindow: 32_000,
		speed: { firstTokenMs: 800, tokensPerSecond: 25 },
		tools: score(0, 3),
		instructions: score(2, 3),
		retrieval: { ...score(1, 2), approxTokens: 8000 },
		multiStep: { ...score(0, 3), toolCalls: 0 },
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

function setup(options: { model?: Model<Api>; mode?: "tui" | "print"; measured?: "chat-only" | "error" }) {
	const dir = join(base, "onboarding");
	const capabilityDir = join(base, "capability");
	const permissionsDir = join(base, "permissions");
	const modelsPath = join(base, "models.json");
	const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const answers: string[] = [];
	const inputs: string[] = [];
	const prompts: string[] = [];
	const busEvents: string[] = [];
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
		getCommands: () => [{ name: "careful" }],
		setModel,
		events: { emit: (channel: string) => busEvents.push(channel), on: () => () => undefined },
	} as unknown as ExtensionAPI;
	const measure = async (): Promise<SuiteOutcome | undefined> => {
		if (options.measured === undefined) return undefined;
		if (options.measured === "error") return { ok: false, error: "timeout" };
		const result = chatOnlyResult();
		saveResult(capabilityDir, result);
		return { ok: true, result };
	};
	createOnboardingExtension(api, { dir, permissionsStateDir: permissionsDir, modelsPath, capabilityDir, measure });

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
		permissionsDir,
		modelsPath,
		answers,
		inputs,
		prompts,
		busEvents,
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
