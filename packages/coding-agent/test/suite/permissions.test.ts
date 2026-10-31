import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createPermissionsExtension } from "../../src/extensions/permissions/index.ts";
import type { PermissionMode } from "../../src/extensions/permissions/levels.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

describe("careful levels in a real agent session", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	async function start(mode: PermissionMode, select: (title: string, options: string[]) => string | undefined) {
		const base = mkdtempSync(join(tmpdir(), "permissions-suite-"));
		dirs.push(base);
		const stateDir = join(base, "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "config.json"), JSON.stringify({ mode }));
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					createPermissionsExtension(pi, { stateDir, home: join(base, "home"), tempDirs: [join(base, "tmp")] }),
			],
		});
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
