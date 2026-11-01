import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createCarefulExtension } from "../../examples/extensions/pi-guided/careful/index.ts";
import type { CarefulLevel } from "../../examples/extensions/pi-guided/careful/levels.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

describe("careful levels in a real agent session", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	async function start(level: CarefulLevel, select: (title: string, options: string[]) => string | undefined) {
		const dir = mkdtempSync(join(tmpdir(), "careful-suite-"));
		dirs.push(dir);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ level }));
		const harness = await createHarness({ extensionFactories: [(pi) => createCarefulExtension(pi, { dir })] });
		harnesses.push(harness);
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({ select: async (title, options) => select(title, options) }),
		});
		return harness;
	}

	it("level 2 leaves write tools out of the request, says so in the prompt, and they cannot be called", async () => {
		const harness = await start(2, () => {
			throw new Error("level 2 must not ask");
		});
		let tools: string[] = [];
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				tools = getCurrentTools(context.messages).map((tool) => tool.name);
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage([fauxToolCall("write", { path: "out.txt", content: "x" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("write out.txt");

		expect(tools.sort()).toEqual(["find", "grep", "ls", "read"]);
		expect(systemPrompt).toContain("careful level 2 (Look, don't touch)");
		expect(existsSync(join(harness.tempDir, "out.txt"))).toBe(false);
		// Undeclared tools never reach tool_call; the gate's block is the backstop for nested calls.
		expect(JSON.stringify(getToolResult(harness, "write").content)).toContain("Tool write not found");
	});

	it("level 1 says so in the tool list and the rules, before any other text about tools", async () => {
		const harness = await start(1, () => undefined);
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("Here is the poem.");
			},
		]);

		await harness.session.prompt("write a poem and save it to disk");

		const tools = systemPrompt.indexOf("<tools>");
		expect(systemPrompt.slice(tools, systemPrompt.indexOf("</tools>"))).toContain("Careful level 1 is on");
		expect(systemPrompt).not.toContain("you may have access to other custom tools");
		expect(systemPrompt).toContain("- Careful level 1 is on");
		expect(systemPrompt).toContain("/careful 3 lets you do it");
	});

	it("reaches the model when an earlier extension replaces the whole system prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "careful-suite-"));
		dirs.push(dir);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ level: 1 }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\nExecution policy.` })),
				(pi) => createCarefulExtension(pi, { dir }),
			],
		});
		harnesses.push(harness);
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("hi");

		expect(systemPrompt).toContain("Execution policy.");
		expect(systemPrompt).toContain("Careful level 1 is on");
	});

	it("a level chosen after moving back in the session tree takes effect", async () => {
		const harness = await start(1, () => undefined);
		harness.setResponses([fauxAssistantMessage("I have no tools.")]);
		await harness.session.prompt("configure config.toml");
		await harness.session.prompt("/careful 3");
		// Going back to before the first message restores the tools that point declared: none.
		const systemEntry = harness.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "system");
		await harness.session.navigateTree(systemEntry!.id, { summarize: false });
		let tools: string[] = [];
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				tools = getCurrentTools(context.messages).map((tool) => tool.name);
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("Reading both files.");
			},
		]);

		await harness.session.prompt("configure config.toml");

		expect(tools).toContain("bash");
		expect(tools).toContain("read");
		expect(systemPrompt).toContain("careful level 3");
		expect(systemPrompt).not.toContain("Careful level 1 is on");
	});

	it("level 3 asks in plain words, and /careful 4 gives the tools back for the next run", async () => {
		const asked: string[] = [];
		const harness = await start(3, (title, options) => {
			asked.push(title);
			return options.find((o) => o === "No");
		});
		let tools: string[] = [];
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "touch made.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("stopped"),
		]);
		await harness.session.prompt("make a file");
		expect(asked[0]).toContain("Pi wants to run a command");
		expect(existsSync(join(harness.tempDir, "made.txt"))).toBe(false);

		await harness.session.prompt("/careful 4");
		harness.setResponses([
			(context) => {
				tools = getCurrentTools(context.messages).map((tool) => tool.name);
				return fauxAssistantMessage([fauxToolCall("bash", { command: "touch made.txt" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("make a file");
		expect(tools).toContain("bash");
		expect(asked).toHaveLength(1);
		expect(existsSync(join(harness.tempDir, "made.txt"))).toBe(true);
	});
});
