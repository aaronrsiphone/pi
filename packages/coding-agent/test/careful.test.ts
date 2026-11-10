import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerToResult, describeCall } from "../examples/extensions/pi-guided/careful/approval.ts";
import { findMentions } from "../examples/extensions/pi-guided/careful/attach.ts";
import { readSavedLevel, writeSavedLevel } from "../examples/extensions/pi-guided/careful/config.ts";
import {
	CAREFUL_CHANGED_EVENT,
	CAREFUL_SET_EVENT,
	capLevel,
	decideForLevel,
	parseLevel,
	promptSection,
} from "../examples/extensions/pi-guided/careful/levels.ts";
import type { BeforeAgentStartEvent, InputEventResult } from "../src/core/extensions/index.ts";
import { type FixtureOptions, setupCareful } from "./careful-fixture.ts";

let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "careful-"));
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

async function startedWith(options: Omit<FixtureOptions, "base">) {
	const h = setupCareful({ base, ...options });
	await h.startSession();
	return h;
}

async function promptSectionAfterStart(h: Awaited<ReturnType<typeof startedWith>>): Promise<string | undefined> {
	const event = {
		type: "before_agent_start",
		systemPromptOptions: { sections: {}, promptGuidelines: [] },
	} as unknown as BeforeAgentStartEvent;
	await h.emit("before_agent_start", event);
	return event.systemPromptOptions.sections.careful;
}

const ALL_TOOLS = ["read", "bash", "edit", "write", "mcp_read", "mcp_delete"];
const READ_ONLY = ["read", "grep", "find", "ls"];

describe("level selection", () => {
	it("starts at level 2 until the user picks a level, and announces it", async () => {
		const h = await startedWith({});
		expect(h.activeTools).toEqual(READ_ONLY);
		expect(h.setStatus).toHaveBeenLastCalledWith("careful", "careful: 2 Look, don't touch");
		expect(h.sent.get(CAREFUL_CHANGED_EVENT)).toEqual([{ level: 2 }]);
	});

	it("uses the saved level, and the flag overrides it for the session", async () => {
		expect((await startedWith({ level: 4 })).activeTools).toEqual(ALL_TOOLS);
		expect((await startedWith({ level: 4, flag: "1" })).activeTools).toEqual([]);
	});

	it("lets a project lower the level but never raise it", async () => {
		const root = join(base, "capped");
		mkdirSync(join(root, ".pi"), { recursive: true });
		writeFileSync(join(root, ".pi", "careful.json"), JSON.stringify({ maxLevel: 2 }));
		const h = await startedWith({ level: 4, flag: "4", root });
		expect(h.activeTools).toEqual(READ_ONLY);
		expect((await h.call("write", { path: "a.txt", content: "" }))?.block).toBe(true);

		await h.command("careful", "3");
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("allows at most 2 Look, don't touch");
		expect(readSavedLevel(h.dir)).toBe(3);
	});

	it("saves /careful choices and applies them right away", async () => {
		const h = await startedWith({});
		h.answers.push("3.");
		await h.command("careful", "");
		expect(h.prompts[0].title).toContain("How careful should pi be?");
		expect(h.prompts[0].options[1]).toContain("(current)");
		expect(readSavedLevel(h.dir)).toBe(3);
		expect(h.activeTools).toEqual(ALL_TOOLS);
		expect(h.sent.get(CAREFUL_CHANGED_EVENT)?.at(-1)).toEqual({ level: 3 });
	});

	it("saves and applies a level another extension asks for on the event bus", async () => {
		const h = await startedWith({});
		h.emitBus(CAREFUL_SET_EVENT, { level: 4 });
		expect(readSavedLevel(h.dir)).toBe(4);
		expect(h.activeTools).toContain("write");
		expect(h.setStatus).toHaveBeenLastCalledWith("careful", "careful: 4 It's yours");
		h.emitBus(CAREFUL_SET_EVENT, { level: 9 });
		expect(readSavedLevel(h.dir)).toBe(4);
	});

	it("parses and caps levels", () => {
		expect(parseLevel("3")).toBe(3);
		expect(parseLevel(" 2 ")).toBe(2);
		expect(parseLevel(4)).toBe(4);
		expect(parseLevel("5")).toBeUndefined();
		expect(parseLevel("adaptive")).toBeUndefined();
		expect(capLevel(4, 2)).toBe(2);
		expect(capLevel(1, 3)).toBe(1);
		expect(capLevel(3, undefined)).toBe(3);
	});

	it("ignores a broken saved file", () => {
		const dir = join(base, "broken");
		mkdirSync(dir);
		writeFileSync(join(dir, "config.json"), "{");
		expect(readSavedLevel(dir)).toBeUndefined();
		writeSavedLevel(dir, 1);
		expect(readSavedLevel(dir)).toBe(1);
	});
});

describe("tool caps", () => {
	it("restores the user's tools when the cap is lifted, also after a resume", async () => {
		const h = await startedWith({});
		expect(h.activeTools).toEqual(READ_ONLY);
		writeSavedLevel(h.dir, 4);
		// A resumed session starts from the capped tools its transcript declares.
		await h.startSession();
		expect(h.activeTools).toEqual(ALL_TOOLS);
	});

	it("re-applies the cap before every run, so tools activated later are removed again", async () => {
		const h = await startedWith({ level: 2 });
		h.activeTools.push("bash");
		await promptSectionAfterStart(h);
		expect(h.activeTools).toEqual(READ_ONLY);
	});

	it("level 1 blocks every tool, even read", async () => {
		const h = await startedWith({ level: 1 });
		expect(h.activeTools).toEqual([]);
		const result = await h.call("read", { path: "src/a.ts" });
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("attach");
		expect(h.select).not.toHaveBeenCalled();
	});

	it("level 2 reads freely and blocks writes, commands, and other tools without asking", async () => {
		const h = await startedWith({ level: 2 });
		expect(await h.call("read", { path: "src/a.ts" })).toBeUndefined();
		expect(await h.call("ls", { path: "." })).toBeUndefined();
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

	it("decides every level from the tool name alone", () => {
		expect(decideForLevel(1, "ls").action).toBe("block");
		expect(decideForLevel(2, "grep")).toEqual({ action: "allow" });
		expect(decideForLevel(2, "codemode").action).toBe("block");
		expect(decideForLevel(3, "find")).toEqual({ action: "allow" });
		expect(decideForLevel(3, "bash")).toEqual({ action: "ask" });
		expect(decideForLevel(3, "mcp_read")).toEqual({ action: "ask" });
		expect(decideForLevel(4, "bash")).toEqual({ action: "allow" });
	});
});

describe("asking at level 3", () => {
	it("asks before every command, even one that only looks", async () => {
		const h = await startedWith({ level: 3 });
		h.answers.push("Yes");
		expect(await h.bash("ls -la")).toBeUndefined();
		expect(h.prompts[0].title).toContain("Pi wants to run a command\n\nls -la");
		expect(h.prompts[0].options).toEqual([
			"Yes, do it",
			"No",
			"No, and tell it what to do instead...",
			"Let's talk about it first",
		]);
		expect(await h.call("ls", { path: "." })).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(1);
	});

	it("asks every time", async () => {
		const h = await startedWith({ level: 3 });
		for (let i = 0; i < 4; i++) {
			h.answers.push("Yes");
			await h.call("write", { path: `src/${i}.ts`, content: "" });
		}
		expect(h.select).toHaveBeenCalledTimes(4);
	});

	it("tells the model what the user said", async () => {
		const h = await startedWith({ level: 3 });
		h.answers.push("No,");
		const reason = (await h.bash("npm install left-pad"))?.reason;
		expect(reason).toContain("The user said no to the command npm install left-pad");
		expect(reason).toContain("use pnpm");

		h.answers.push("Let's talk");
		expect(await h.bash("rm -rf build")).toMatchObject({ block: true, terminate: true });

		h.answers.push("<dismiss>");
		expect((await h.bash("rm -rf build"))?.reason).toContain("closed without an answer");
	});

	it("asks one question at a time for parallel calls", async () => {
		const h = await startedWith({ level: 3 });
		h.answers.push("Yes", "No");
		const results = await Promise.all([
			h.call("write", { path: "src/a.ts", content: "" }),
			h.call("write", { path: "src/b.ts", content: "" }),
		]);
		expect(results[0]).toBeUndefined();
		expect(results[1]?.block).toBe(true);
	});

	it("blocks what would need a question when there is no UI", async () => {
		const h = await startedWith({ level: 3, hasUI: false });
		expect(await h.call("read", { path: "a.txt" })).toBeUndefined();
		expect((await h.bash("ls"))?.reason).toContain("no interactive UI");
	});
});

describe("level 4", () => {
	it("changes files, runs commands, and uses any tool without asking", async () => {
		const h = await startedWith({ level: 4 });
		expect(await h.call("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
		expect(await h.bash("sudo rm -rf /var/log")).toBeUndefined();
		expect(await h.call("mcp_delete", { id: 1 })).toBeUndefined();
		expect(h.select).not.toHaveBeenCalled();
	});
});

describe("prompt section", () => {
	it("tells the model what levels 1 to 3 allow, and adds nothing at level 4", async () => {
		expect(await promptSectionAfterStart(await startedWith({ level: 1 }))).toContain("You have no tools");
		expect(await promptSectionAfterStart(await startedWith({ level: 2 }))).toContain("numbered plan");
		expect(await promptSectionAfterStart(await startedWith({ level: 3 }))).toContain("needs the user's approval");
		expect(await promptSectionAfterStart(await startedWith({ level: 4 }))).toBeUndefined();
		expect(promptSection(4)).toBeUndefined();
	});
});

describe("attachments at level 1", () => {
	it("adds mentioned files to the message and reports missing ones", async () => {
		const h = await startedWith({ level: 1 });
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
		const h = await startedWith({ level: 2 });
		writeFileSync(join(h.root, "header.txt"), "x");
		expect(await h.emit("input", { type: "input", text: "see @header.txt", source: "interactive" })).toBeUndefined();
	});

	it("finds plain and quoted mentions, but not e-mail addresses", () => {
		expect(findMentions('read @a.csv and @"my data/b.txt", mail me at x@y.org')).toEqual(["a.csv", "my data/b.txt"]);
	});
});

describe("approval question", () => {
	it("shows the command, or the file and the lines it changes", () => {
		const root = join(base, "project");
		mkdirSync(root, { recursive: true });
		writeFileSync(join(root, "old.csv"), "a\n");

		expect(describeCall("bash", { command: "python plot.py" }, root)).toMatchObject({
			title: "Pi wants to run a command",
			summary: "the command python plot.py",
		});
		expect(describeCall("write", { path: "new.csv", content: "a\nb" }, root).title).toBe("Pi wants to create a file");
		const replace = describeCall("write", { path: "old.csv", content: "b" }, root);
		expect(replace.title).toBe("Pi wants to replace a file");
		expect(replace.description).toContain("The old contents are lost");
		const edit = describeCall("edit", { path: "old.csv", edits: [{ oldText: "psi", newText: "kPa" }] }, root);
		expect(edit.description).toContain("  - psi\n  + kPa");
		expect(describeCall("mcp_delete", { id: 1 }, root).title).toBe("Pi wants to use the mcp_delete tool");
	});

	it("lets the call run only on yes", () => {
		const question = describeCall("bash", { command: "ls" }, base);
		expect(answerToResult("yes", question, "bash")).toBeUndefined();
		for (const action of ["no", "no-reason", "chat", undefined] as const) {
			expect(answerToResult(action, question, "bash")?.block).toBe(true);
		}
	});
});
