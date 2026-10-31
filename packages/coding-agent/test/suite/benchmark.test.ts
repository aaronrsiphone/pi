import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createBenchmarkExtension } from "../../src/extensions/benchmark/index.ts";
import { loadRuns } from "../../src/extensions/benchmark/store.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

describe("/bench in a real agent session", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	it("runs an example ladder as its own agent, records the grades, and leaves the conversation alone", async () => {
		const dir = mkdtempSync(join(tmpdir(), "benchmark-suite-"));
		dirs.push(dir);
		const harness = await createHarness({ extensionFactories: [(pi) => createBenchmarkExtension(pi, { dir })] });
		harnesses.push(harness);
		const dialogs: string[] = [];
		// Dialogs in order: two grades, the level 3 approval, two grades. A named ladder runs at its own levels.
		const answers = ["Pass", "Pass", "No", "Fail", "Partial"];
		await harness.session.bindExtensions({
			uiContext: createTestUiContext({
				select: async (title, options) => {
					dialogs.push(title);
					const want = answers.shift();
					return options.find((o) => want !== undefined && o.startsWith(want));
				},
			}),
		});
		harness.setResponses([
			fauxAssistantMessage("The sample rate is 48000 Hz."),
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "fig3", path: "." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("scripts/summary_plots.py makes figure 3."),
			// Level 3 asks before this write, and the user says no.
			fauxAssistantMessage([fauxToolCall("write", { path: "data/pressure.csv", content: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("I was not allowed to change it."),
			fauxAssistantMessage("I would write a plot script."),
		]);

		await harness.session.prompt("/bench run example:lab-data");

		const runs = loadRuns(dir, "example:lab-data");
		expect(runs.map((r) => [r.taskId, r.outcome, r.toolCalls])).toEqual([
			["sample-rate", "pass", 0],
			["figure-3", "pass", 1],
			["psi-to-kpa", "fail", 1],
			["plot-run-07", "partial", 0],
		]);
		expect(dialogs.some((d) => d.startsWith("Pi wants to replace a file"))).toBe(true);
		expect(dialogs[0]).toContain('ok    answer mentions "48"');
		expect(runs[0].model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
		// The ladder ran in its own agents: the user's conversation has no messages from it.
		expect(harness.session.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
		expect(readFileSync(join(dir, "runs.jsonl"), "utf-8").split("\n").filter(Boolean)).toHaveLength(4);
	});
});
