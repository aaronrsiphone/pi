import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
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
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runChecks, snapshot } from "../examples/extensions/pi-guided/benchmark/checks.ts";
import { compareRuns, formatComparison } from "../examples/extensions/pi-guided/benchmark/compare.ts";
import { BENCHMARK_FINISHED_EVENT } from "../examples/extensions/pi-guided/benchmark/events.ts";
import { EXAMPLE_LADDERS } from "../examples/extensions/pi-guided/benchmark/examples.ts";
import { createBenchmarkExtension } from "../examples/extensions/pi-guided/benchmark/index.ts";
import { type Ladder, type LadderTask, parseLadder } from "../examples/extensions/pi-guided/benchmark/ladder.ts";
import { runLadder } from "../examples/extensions/pi-guided/benchmark/run-ladder.ts";
import { type RunnerDeps, runTask } from "../examples/extensions/pi-guided/benchmark/runner.ts";
import {
	appendRun,
	type LadderEntry,
	listLadders,
	loadRuns,
	type RunRecord,
	saveLadder,
} from "../examples/extensions/pi-guided/benchmark/store.ts";
import { summarizeForModel } from "../examples/extensions/pi-guided/benchmark/summary.ts";
import { MAX_COPY_BYTES, prepareWorkspace } from "../examples/extensions/pi-guided/benchmark/workspace.ts";
import {
	EXPECTATIONS_COLLECT_EVENT,
	type ExpectationsCollectEvent,
} from "../examples/extensions/pi-guided/capability/expectations.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/index.ts";
import { fauxAgentDir } from "./pi-guided-faux.ts";

let faux: FauxProviderRegistration;
let base: string;

beforeEach(() => {
	faux = registerFauxProvider();
	base = mkdtempSync(join(tmpdir(), "benchmark-"));
});

afterEach(() => {
	faux.unregister();
	rmSync(base, { recursive: true, force: true });
});

const toolUse = (name: string, args: JsonObject) =>
	fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

const lastUserText = (context: Parameters<FauxResponseFactory>[0]): string => {
	const user = context.messages.filter((m) => m.role === "user").at(-1);
	return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
};

function task(overrides: Partial<LadderTask> = {}): LadderTask {
	return {
		id: "t1",
		title: "Task one",
		kind: "small-edit",
		prompt: "Change psi to kPa in data.csv",
		files: [],
		level: 3,
		judge: "",
		checks: [],
		...overrides,
	};
}

function deps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		model: faux.getModel(),
		thinkingLevel: "off",
		ui: undefined,
		agentDir: fauxAgentDir(faux, base),
		...overrides,
	};
}

function folder(files: Record<string, string>): string {
	const dir = mkdtempSync(join(base, "run-"));
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), content);
	}
	return dir;
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
	return {
		version: 1,
		ladderKey: "example:lab-data",
		ladderName: "Lab",
		taskId: "t1",
		taskTitle: "Task one",
		taskKind: "small-edit",
		at: 0,
		model: "faux/m",
		thinkingLevel: "off",
		level: 3,
		levelOverride: undefined,
		durationMs: 12_000,
		toolCalls: 4,
		inputTokens: 3000,
		outputTokens: 100,
		outcome: "pass",
		checks: [],
		answer: "",
		error: undefined,
		...overrides,
	};
}

describe("ladder files", () => {
	it("accepts the example ladders", () => {
		for (const ladder of Object.values(EXAMPLE_LADDERS)) {
			expect(parseLadder(JSON.parse(JSON.stringify(ladder)))).toEqual({ ok: true, ladder });
		}
	});

	it("rejects broken ladders with the first problem", () => {
		const good = JSON.parse(JSON.stringify(EXAMPLE_LADDERS["lab-data"])) as Record<string, unknown>;
		const tasks = good.tasks as Record<string, unknown>[];
		expect(parseLadder({ ...good, version: 2 })).toMatchObject({ ok: false, error: "unknown version (expected 1)" });
		expect(parseLadder({ ...good, tasks: [{ ...tasks[0], level: 5 }] })).toMatchObject({
			error: "task 1: level must be 1 to 4",
		});
		expect(parseLadder({ ...good, tasks: [tasks[0], tasks[0]] })).toMatchObject({
			error: "task 2: duplicate id sample-rate",
		});
		expect(parseLadder({ ...good, files: { "../outside.txt": "x" } })).toMatchObject({
			error: "file path ../outside.txt leaves the ladder's folder",
		});
		expect(
			parseLadder({
				...good,
				tasks: [{ ...tasks[0], checks: [{ type: "file-contains", path: "/etc/passwd", text: "" }] }],
			}),
		).toMatchObject({ ok: false });
	});
});

describe("storage", () => {
	it("lists personal and project ladders alongside the examples, and reports broken files", () => {
		const dir = join(base, "user");
		const project = join(base, "project");
		saveLadder(join(dir, "ladders"), { ...EXAMPLE_LADDERS["lab-data"], name: "Mine" });
		saveLadder(join(project, ".pi", "benchmarks"), { ...EXAMPLE_LADDERS["test-records"], name: "Team" });
		writeFileSync(join(project, ".pi", "benchmarks", "broken.json"), "{");
		const { ladders, problems } = listLadders(dir, project);
		expect(ladders.map((l) => [l.ladder.name, l.source])).toEqual([
			["Mine", "personal"],
			["Team", "project"],
			["Example: lab data basics", "example"],
			["Example: engineering test records", "example"],
		]);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("broken.json");
	});

	it("never overwrites a ladder with the same name", () => {
		const folderPath = join(base, "ladders");
		const first = saveLadder(folderPath, EXAMPLE_LADDERS["lab-data"]);
		const second = saveLadder(folderPath, EXAMPLE_LADDERS["lab-data"]);
		expect(first).not.toBe(second);
		expect(second).toMatch(/-2\.json$/);
	});

	it("keeps run history per user and skips a cut line", () => {
		const dir = join(base, "user");
		appendRun(dir, run());
		appendRun(dir, run({ ladderKey: "other" }));
		writeFileSync(join(dir, "runs.jsonl"), `${readFileSync(join(dir, "runs.jsonl"), "utf-8")}{"version":1,`);
		expect(loadRuns(dir)).toHaveLength(2);
		expect(loadRuns(dir, "other")).toHaveLength(1);
	});
});

describe("run folder", () => {
	it("copies the project without version control, dependencies, or links", () => {
		const project = folder({ "data.csv": "a", ".git/HEAD": "x", "node_modules/p/index.js": "x" });
		symlinkSync(join(project, "data.csv"), join(project, "link.csv"));
		const workspace = prepareWorkspace(undefined, project);
		if (!workspace.ok) throw new Error(workspace.error);
		expect(readFileSync(join(workspace.dir, "data.csv"), "utf-8")).toBe("a");
		expect(existsSync(join(workspace.dir, ".git"))).toBe(false);
		expect(existsSync(join(workspace.dir, "node_modules"))).toBe(false);
		expect(existsSync(join(workspace.dir, "link.csv"))).toBe(false);
		workspace.dispose();
		expect(existsSync(workspace.dir)).toBe(false);
	});

	it("uses only the ladder's own files when it brings them", () => {
		const project = folder({ "real.csv": "keep" });
		const workspace = prepareWorkspace({ "data/a.txt": "hello" }, project);
		if (!workspace.ok) throw new Error(workspace.error);
		expect(readFileSync(join(workspace.dir, "data/a.txt"), "utf-8")).toBe("hello");
		expect(existsSync(join(workspace.dir, "real.csv"))).toBe(false);
		workspace.dispose();
	});

	it("refuses a folder that is too large to copy", () => {
		const project = folder({ "big.bin": "" });
		// A sparse file reports its full size without using the disk.
		truncateSync(join(project, "big.bin"), MAX_COPY_BYTES + 1);
		const workspace = prepareWorkspace(undefined, project);
		expect(workspace).toMatchObject({ ok: false });
	});
});

describe("checks", () => {
	it("checks the answer, file contents, unchanged files, and command exit codes", async () => {
		const dir = folder({ "data.csv": "pressure_psi\n40\n", "notes.txt": "keep" });
		const checks = [
			{ type: "answer-contains", text: "275.8" },
			{ type: "file-contains", path: "data.csv", text: "pressure_kpa" },
			{ type: "file-unchanged", path: "notes.txt" },
			{ type: "command", command: "exit 3", exitCode: 3 },
			{ type: "command", command: "exit 1", exitCode: 0 },
		] as const;
		const before = snapshot(checks, dir);
		writeFileSync(join(dir, "data.csv"), "pressure_kpa\n275.8\n");
		writeFileSync(join(dir, "notes.txt"), "changed");
		const results = await runChecks(checks, "It is 275.8 KPA", dir, before);
		expect(results.map((r) => r.passed)).toEqual([true, true, false, true, false]);
		expect(results[4].label).toContain("(got 1)");
	});
});

describe("comparing runs", () => {
	it("puts the newest setups side by side, with each task's latest run", () => {
		const tasks = [
			{ id: "t1", title: "Task one" },
			{ id: "t2", title: "Task two" },
		];
		const comparison = compareRuns(
			[
				run({ outcome: "fail" }),
				run({ outcome: "pass" }),
				run({ model: "faux/big", taskId: "t2", outcome: "partial" }),
				run({ thinkingLevel: "high", levelOverride: 2, outcome: "fail" }),
			],
			tasks,
		);
		expect(comparison.setups.map((s) => s.key)).toEqual([
			"faux/m|off|ladder levels",
			"faux/big|off|ladder levels",
			"faux/m|high|level 2",
		]);
		expect(comparison.rows[0].cells.map((c) => c?.outcome)).toEqual(["pass", undefined, "fail"]);
		const text = formatComparison(comparison).join("\n");
		expect(text).toContain("A: faux/m, effort off, ladder levels");
		expect(text).toContain("  A  pass, 12 s, 4 step(s), 3.1k tokens");
		expect(text).toContain("  B  not run");
		expect(text).toContain("  A  1 of 2 passed");
	});

	it("summarizes a model's latest results for the expectations card", () => {
		const runs = [
			run({ outcome: "fail" }),
			run({ outcome: "pass" }),
			run({ taskId: "t2", taskKind: "multi-step", outcome: "partial" }),
			run({ taskId: "t3", model: "other/x", outcome: "fail" }),
		];
		expect(summarizeForModel(runs, "faux/m")).toEqual([
			"1 of 2 task(s) passed, 1 partly, 0 failed.",
			"Did well: Small edit.",
			"Check its work on: Multi-step.",
		]);
		expect(summarizeForModel(runs, "none/y")[0]).toContain("No benchmark runs");
	});
});

describe("running a task as its own agent", () => {
	it("works in its folder with the level's tools and counts steps and tokens", async () => {
		const dir = folder({ "data.csv": "pressure_psi\n40\n" });
		let tools: string[] = [];
		faux.setResponses([
			(context) => {
				tools = getCurrentTools(context.messages).map((t) => t.name);
				return toolUse("edit", {
					path: "data.csv",
					edits: [{ oldText: "pressure_psi\n40", newText: "pressure_kpa\n275.8" }],
				});
			},
			fauxAssistantMessage("Converted to 275.8 kPa."),
		]);
		const result = await runTask(task({ level: 4 }), dir, deps());
		expect(tools.sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(readFileSync(join(dir, "data.csv"), "utf-8")).toBe("pressure_kpa\n275.8\n");
		expect(result).toMatchObject({ answer: "Converted to 275.8 kPa.", toolCalls: 1, error: undefined });
		expect(result.inputTokens).toBeGreaterThan(0);
		expect(result.outputTokens).toBeGreaterThan(0);
	});

	it("level 2 offers only reading tools and blocks a write the model tries anyway", async () => {
		const dir = folder({ "a.txt": "x" });
		let tools: string[] = [];
		faux.setResponses([
			(context) => {
				tools = getCurrentTools(context.messages).map((t) => t.name);
				return toolUse("write", { path: "a.txt", content: "y" });
			},
			fauxAssistantMessage("I could not write."),
		]);
		await runTask(task({ level: 2 }), dir, deps());
		expect(tools.sort()).toEqual(["find", "grep", "ls", "read"]);
		expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("x");
	});

	it("level 1 has no tools and gets the task's files in the prompt", async () => {
		const dir = folder({ "header.txt": "sample_rate = 48000 Hz" });
		let prompt = "";
		let toolCount = -1;
		faux.setResponses([
			(context) => {
				prompt = lastUserText(context);
				toolCount = getCurrentTools(context.messages).length;
				return fauxAssistantMessage("48000 Hz");
			},
		]);
		const result = await runTask(
			task({ level: 1, prompt: "What is the sample rate?", files: ["header.txt"] }),
			dir,
			deps(),
		);
		expect(toolCount).toBe(0);
		expect(prompt).toContain("sample_rate = 48000 Hz");
		expect(result.answer).toBe("48000 Hz");
	});

	it("level 3 asks the user before a change, with the same question as a normal session", async () => {
		const dir = folder({ "a.txt": "x" });
		const select = vi.fn(async (_title: string, _options: string[]) => "No");
		faux.setResponses([toolUse("bash", { command: "rm a.txt" }), fauxAssistantMessage("Okay, I left it.")]);
		await runTask(task({ level: 3 }), dir, deps({ ui: { select, input: vi.fn() } }));
		expect(select).toHaveBeenCalledTimes(1);
		expect(String(select.mock.calls[0][0])).toContain("Pi wants to run a command\n\nrm a.txt");
		expect(existsSync(join(dir, "a.txt"))).toBe(true);
	});

	it("stops when the user aborts and says so", async () => {
		const dir = folder({});
		const controller = new AbortController();
		faux.setResponses([
			() => {
				controller.abort();
				return toolUse("ls", { path: "." });
			},
			fauxAssistantMessage("never"),
		]);
		const result = await runTask(task(), dir, deps({ signal: controller.signal }));
		expect(result.error).toBe("stopped by you");
	});
});

describe("running a ladder", () => {
	function command(answers: string[], options: { trusted?: boolean; cwd?: string } = {}) {
		const prompts: string[] = [];
		const ctx = {
			hasUI: true,
			cwd: options.cwd ?? folder({}),
			model: faux.getModel(),
			thinkingLevel: "off",
			isProjectTrusted: () => options.trusted ?? false,
			ui: {
				select: vi.fn(async (title: string, opts: string[]) => {
					prompts.push(title);
					const want = answers.shift();
					if (want === undefined) throw new Error(`unexpected prompt: ${title.split("\n")[0]}`);
					if (want === "<dismiss>") return undefined;
					const match = opts.find((o) => o.startsWith(want));
					if (!match) throw new Error(`no option starting with "${want}" in ${JSON.stringify(opts)}`);
					return match;
				}),
				input: vi.fn(),
				notify: vi.fn(),
				setWidget: vi.fn(),
				onTerminalInput: () => () => undefined,
			},
		} as unknown as ExtensionCommandContext;
		return { ctx, prompts };
	}

	const ladder: Ladder = {
		version: 1,
		name: "Units",
		description: "",
		files: undefined,
		tasks: [
			task({ id: "a", level: 4, checks: [{ type: "file-contains", path: "data.csv", text: "kpa" }] }),
			task({ id: "b", title: "Task two", level: 4, checks: [{ type: "command", command: "exit 0", exitCode: 0 }] }),
		],
	};

	it("runs on a copy, shows checks and how to judge, and records the user's grade", async () => {
		const project = folder({ "data.csv": "psi" });
		const dir = join(base, "history");
		faux.setResponses([
			toolUse("write", { path: "data.csv", content: "kpa" }),
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Nothing to do."),
		]);
		const { ctx, prompts } = command(["Pass", "Fail"], { cwd: project, trusted: true });
		const entry: LadderEntry = { key: "project:x", source: "project", path: undefined, ladder };
		const summary = await runLadder(
			entry,
			{ levelOverride: undefined, dir, agentDir: fauxAgentDir(faux, base) },
			ctx,
		);

		expect(readFileSync(join(project, "data.csv"), "utf-8")).toBe("psi");
		expect(prompts[0]).toContain("Task 1 of 2: Task one");
		expect(prompts[0]).toContain('ok    data.csv contains "kpa"');
		expect(prompts[0]).toContain("Pi never grades its own work");
		expect(prompts[1]).toContain("ok    `exit 0` exits with 0");
		expect(summary.runs.map((r) => [r.taskId, r.outcome, r.toolCalls])).toEqual([
			["a", "pass", 1],
			["b", "fail", 0],
		]);
		expect(loadRuns(dir, "project:x")).toHaveLength(2);
	});

	it("skips command checks from a project that is not trusted", async () => {
		faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done.")]);
		const { ctx, prompts } = command(["Skip", "<dismiss>"]);
		const entry: LadderEntry = { key: "project:x", source: "project", path: undefined, ladder };
		const summary = await runLadder(
			entry,
			{ levelOverride: undefined, dir: join(base, "h"), agentDir: fauxAgentDir(faux, base) },
			ctx,
		);
		expect(prompts[1]).toContain("command checks skipped: this project is not trusted");
		expect(prompts[1]).not.toContain("exit 0");
		// Skip records nothing; Escape stops the ladder.
		expect(summary).toEqual({ runs: [], stopped: true });
	});

	it("runs every task at one chosen level when asked, and records it", async () => {
		faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
		const { ctx } = command(["Pass", "Pass"]);
		const entry: LadderEntry = { key: "personal:x", source: "personal", path: undefined, ladder };
		const summary = await runLadder(
			entry,
			{ levelOverride: 2, dir: join(base, "h"), agentDir: fauxAgentDir(faux, base) },
			ctx,
		);
		expect(summary.runs.map((r) => [r.level, r.levelOverride])).toEqual([
			[2, 2],
			[2, 2],
		]);
	});
});

describe("benchmark extension", () => {
	it("adds its results to the expectations card and announces finished runs", () => {
		const dir = join(base, "user");
		appendRun(dir, run());
		const bus = new Map<string, ((data: unknown) => void)[]>();
		const api = {
			registerEntryRenderer: vi.fn(),
			registerCommand: vi.fn(),
			appendEntry: vi.fn(),
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
		createBenchmarkExtension(api, { dir });
		const collect: ExpectationsCollectEvent = { model: "faux/m", sections: [] };
		api.events.emit(EXPECTATIONS_COLLECT_EVENT, collect);
		expect(collect.sections).toEqual([
			{ title: "Your benchmarks", lines: summarizeForModel(loadRuns(dir), "faux/m") },
		]);
		expect(BENCHMARK_FINISHED_EVENT).toBe("benchmark:finished");
	});
});
