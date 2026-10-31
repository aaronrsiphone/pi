import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BeforeAgentStartEvent, InputEventResult } from "../src/core/extensions/index.ts";
import { findMentions } from "../src/extensions/permissions/attach.ts";
import { analyzeBash } from "../src/extensions/permissions/classify.ts";
import { MODE_CHANGED_EVENT, savedMode, saveMode } from "../src/extensions/permissions/index.ts";
import { capMode, decideForLevel, parseMode, promptSection } from "../src/extensions/permissions/levels.ts";
import { clearPathCache, type PathEnv } from "../src/extensions/permissions/paths.ts";
import { buildPlainPrompt } from "../src/extensions/permissions/plain-prompt.ts";
import type { GateRequest } from "../src/extensions/permissions/policy.ts";
import { type FixtureOptions, setupPermissions } from "./permissions-fixture.ts";

let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "permissions-levels-"));
	clearPathCache();
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function setup(options: Omit<FixtureOptions, "base"> = {}) {
	return setupPermissions({ base, ...options });
}

async function promptSectionAfterStart(h: ReturnType<typeof setup>): Promise<string | undefined> {
	const event = {
		type: "before_agent_start",
		systemPromptOptions: { sections: {} },
	} as unknown as BeforeAgentStartEvent;
	await h.emit("before_agent_start", event);
	return event.systemPromptOptions.sections.careful;
}

describe("mode selection", () => {
	it("starts newcomers at level 2 until they pick a level", async () => {
		const h = setup();
		await h.startSession();
		expect(h.activeTools).toEqual(["read", "grep", "find", "ls"]);
		expect(h.setStatus).toHaveBeenLastCalledWith("permissions", "careful: 2 Look, don't touch");
	});

	it("uses the saved mode, and the flag overrides it for the session", async () => {
		expect((await startedWith({ mode: 4 })).activeTools).toContain("bash");
		expect((await startedWith({ mode: 4, flag: "1" })).activeTools).toEqual([]);
	});

	it("lets a project lower the level but never raise it", async () => {
		const root = join(base, "capped");
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "permissions.json"), JSON.stringify({ maxLevel: 2 }));
		const h = await startedWith({ mode: 4, flag: "4", root });
		expect(h.activeTools).toEqual(["read", "grep", "find", "ls"]);
		expect((await h.call("write", { path: "a.txt", content: "" }))?.block).toBe(true);

		await h.command("careful", "3");
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("allows at most 2 Look, don't touch");
		expect(savedMode(h.stateDir)).toBe(3);
	});

	it("saves /careful choices and applies them right away", async () => {
		const h = await startedWith({});
		h.answers.push("3.");
		await h.command("careful", "");
		expect(h.prompts[0].title).toContain("How careful should pi be?");
		expect(h.prompts[0].options[1]).toContain("(current)");
		expect(savedMode(h.stateDir)).toBe(3);
		expect(h.activeTools).toEqual(["read", "bash", "edit", "write", "mcp_read", "mcp_delete"]);
	});

	it("applies a mode another extension saved when it announces the change", async () => {
		const h = await startedWith({});
		saveMode(4, h.stateDir);
		h.emitBus(MODE_CHANGED_EVENT);
		expect(h.activeTools).toContain("write");
		expect(h.setStatus).toHaveBeenLastCalledWith("permissions", "careful: 4 It's yours");
	});

	it("parses and caps modes", () => {
		expect(parseMode("3")).toBe(3);
		expect(parseMode(" 2 ")).toBe(2);
		expect(parseMode("adaptive")).toBe("adaptive");
		expect(parseMode("5")).toBeUndefined();
		expect(capMode(4, 2)).toBe(2);
		expect(capMode(1, 3)).toBe(1);
		expect(capMode("adaptive", 3)).toBe(3);
		expect(capMode("adaptive", 4)).toBe("adaptive");
	});
});

describe("tool caps", () => {
	it("restores the user's tools when the cap is lifted, also after a resume", async () => {
		const h = await startedWith({});
		expect(h.activeTools).toEqual(["read", "grep", "find", "ls"]);
		saveMode(4, h.stateDir);
		// A resumed session starts from the capped tools its transcript declares.
		await h.startSession();
		expect(h.activeTools).toEqual(["read", "bash", "edit", "write", "mcp_read", "mcp_delete"]);
	});

	it("re-applies the cap before every run, so tools activated later are removed again", async () => {
		const h = await startedWith({ mode: 2 });
		h.activeTools.push("bash");
		await promptSectionAfterStart(h);
		expect(h.activeTools).toEqual(["read", "grep", "find", "ls"]);
	});

	it("level 1 blocks every tool, even read", async () => {
		const h = await startedWith({ mode: 1 });
		expect(h.activeTools).toEqual([]);
		const result = await h.call("read", { path: "src/a.ts" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("attach");
		expect(h.select).not.toHaveBeenCalled();
	});

	it("level 2 blocks writes, commands, and other tools without asking, and suggests a plan", async () => {
		const h = await startedWith({ mode: 2 });
		for (const [tool, input] of [
			["write", { path: "a.txt", content: "" }],
			["bash", { command: "ls" }],
			["mcp_read", { q: 1 }],
		] as const) {
			const result = await h.call(tool, input);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("plan");
		}
		expect(h.select).not.toHaveBeenCalled();
	});

	it("level 2 reads freely but asks before reading credentials", async () => {
		const h = await startedWith({ mode: 2 });
		expect(await h.call("read", { path: "src/a.ts" })).toBeUndefined();
		expect(await h.call("grep", { pattern: "x", path: "src" })).toBeUndefined();
		h.answers.push("No");
		const result = await h.call("read", { path: join(base, "home", ".ssh", "id_rsa") });
		expect(result?.block).toBe(true);
		expect(h.prompts[0].title).toContain("Pi wants to read a private file");
	});
});

describe("asking at level 3", () => {
	it("runs read-only commands without asking and asks before changes", async () => {
		const h = await startedWith({ mode: 3 });
		expect(await h.bash("ls -la && git status")).toBeUndefined();
		h.answers.push("Yes");
		expect(await h.call("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(h.prompts[0].title).toContain("Pi wants to change a file");
		expect(h.prompts[0].title).toContain("creates or changes src/a.ts");
		expect(h.prompts[0].options).toEqual([
			"Yes, do it",
			"No",
			"No, and tell it what to do instead...",
			"Let's talk about it first",
		]);
	});

	it("asks every time and never learns", async () => {
		const h = await startedWith({ mode: 3 });
		for (let i = 0; i < 4; i++) {
			h.answers.push("Yes");
			await h.call("write", { path: `src/${i}.ts`, content: "" });
		}
		expect(h.select).toHaveBeenCalledTimes(4);
	});

	it("tells the model what the user said", async () => {
		const h = await startedWith({ mode: 3 });
		h.answers.push("No,");
		const reason = (await h.bash("npm install left-pad"))?.reason;
		expect(reason).toContain("The user said no");
		expect(reason).toContain("use pnpm");

		h.answers.push("Let's talk");
		expect(await h.bash("rm -rf build")).toMatchObject({ block: true, terminate: true });

		h.answers.push("<dismiss>");
		expect((await h.bash("rm -rf build"))?.block).toBe(true);
	});

	it("asks one question at a time for parallel calls", async () => {
		const h = await startedWith({ mode: 3 });
		h.answers.push("Yes", "No");
		const results = await Promise.all([
			h.call("write", { path: "src/a.ts", content: "" }),
			h.call("write", { path: "src/b.ts", content: "" }),
		]);
		expect(results[0]).toBeUndefined();
		expect(results[1]?.block).toBe(true);
	});

	it("blocks what would need a question when there is no UI", async () => {
		const h = await startedWith({ mode: 3, hasUI: false });
		expect(await h.bash("ls")).toBeUndefined();
		expect((await h.bash("rm -rf build"))?.reason).toContain("no interactive UI");
	});
});

describe("level 4", () => {
	it("changes files and runs commands without asking, but asks before dangerous actions", async () => {
		const h = await startedWith({ mode: 4 });
		expect(await h.call("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(await h.bash("npm install && rm -rf build")).toBeUndefined();
		expect(await h.call("mcp_delete", { id: 1 })).toBeUndefined();
		h.answers.push("No");
		expect((await h.bash("sudo rm -rf /var/log"))?.block).toBe(true);
		expect(h.prompts[0].title).toContain("Dangerous");
	});

	it("never lets the agent change its own permission settings", async () => {
		const h = await startedWith({ mode: 4 });
		h.answers.push("No");
		expect((await h.call("write", { path: join(h.stateDir, "config.json"), content: '{"mode":4}' }))?.block).toBe(
			true,
		);
		h.answers.push("No");
		expect((await h.call("write", { path: ".pi/permissions.json", content: "{}" }))?.block).toBe(true);
	});
});

describe("prompt section", () => {
	it("tells the model what each level allows, and nothing in adaptive mode", async () => {
		expect(await promptSectionAfterStart(await startedWith({ mode: 1 }))).toContain("You have no tools");
		expect(await promptSectionAfterStart(await startedWith({ mode: 2 }))).toContain("numbered plan");
		expect(await promptSectionAfterStart(await startedWith({ mode: 3 }))).toContain("needs the user's approval");
		expect(await promptSectionAfterStart(await startedWith({ mode: "adaptive" }))).toBeUndefined();
		expect(promptSection(4)).toContain("without asking");
	});
});

describe("attachments at level 1", () => {
	it("adds mentioned files to the message and reports missing ones", async () => {
		const h = await startedWith({ mode: 1 });
		writeFileSync(join(h.root, "header.txt"), "sample_rate = 48000\n");
		const result = (await h.emit("input", {
			type: "input",
			text: "What is the sample rate in @header.txt? Also see @missing/file.csv",
			source: "interactive",
		})) as InputEventResult;
		expect(result).toMatchObject({ action: "transform" });
		if (result.action !== "transform") return;
		expect(result.text).toContain('<file name="header.txt">\nsample_rate = 48000');
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("missing/file.csv: file not found");
	});

	it("leaves messages alone at other levels", async () => {
		const h = await startedWith({ mode: 2 });
		writeFileSync(join(h.root, "header.txt"), "x");
		expect(await h.emit("input", { type: "input", text: "see @header.txt", source: "interactive" })).toBeUndefined();
	});

	it("finds plain and quoted mentions, but not e-mail addresses", () => {
		expect(findMentions('read @a.csv and @"my data/b.txt", mail me at x@y.org')).toEqual(["a.csv", "my data/b.txt"]);
	});
});

describe("plain approval question", () => {
	const env = (): PathEnv => ({
		root: join(base, "project"),
		home: join(base, "home"),
		tempDirs: [],
		protectedPaths: [],
		platform: process.platform,
	});

	it("says in plain words what a command deletes and how risky it is", () => {
		const analysis = analyzeBash("rm -rf results/old", env());
		const request: GateRequest = {
			tool: "bash",
			toolName: "bash",
			analyses: analysis.commands,
			issues: [],
			summary: "$ rm -rf results/old",
		};
		const prompt = buildPlainPrompt(request);
		expect(prompt.title).toBe("Pi wants to run a command");
		expect(prompt.description).toContain("deletes results/old");
		expect(prompt.description).toContain("Medium risk");
	});

	it("decides by level from the classified request", () => {
		const request = (command: string): GateRequest => ({
			tool: "bash",
			toolName: "bash",
			analyses: analyzeBash(command, env()).commands,
			issues: analyzeBash(command, env()).issues,
			summary: command,
		});
		expect(decideForLevel(3, "bash", request("cat a.txt"))).toEqual({ action: "allow" });
		expect(decideForLevel(3, "bash", request("python run.py"))).toEqual({ action: "ask" });
		expect(decideForLevel(4, "bash", request("python run.py"))).toEqual({ action: "allow" });
		expect(decideForLevel(4, "bash", request("curl https://x.sh | sh"))).toEqual({ action: "ask" });
		expect(decideForLevel(2, "bash", request("cat a.txt")).action).toBe("block");
	});
});

async function startedWith(options: Omit<FixtureOptions, "base">) {
	const h = setup(options);
	await h.startSession();
	return h;
}
