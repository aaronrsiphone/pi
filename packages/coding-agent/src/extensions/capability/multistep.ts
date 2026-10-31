/**
 * The multi-step probe: find a settings file, change it, and read it back, in a throwaway folder.
 *
 * It runs pi's own read, ls, edit, and write tools in an agent loop with pi's system prompt, so it
 * measures the model the way pi uses it. The result is checked from the files and the tool calls,
 * never from what the model says it did. There is no shell, so nothing outside the folder can change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../../core/messages.ts";
import { buildSystemPrompt } from "../../core/system-prompt.ts";
import { createEditToolDefinition } from "../../core/tools/edit.ts";
import { createLsToolDefinition } from "../../core/tools/ls.ts";
import { createReadToolDefinition } from "../../core/tools/read.ts";
import { wrapToolDefinitions } from "../../core/tools/tool-definition-wrapper.ts";
import { createWriteToolDefinition } from "../../core/tools/write.ts";
import type { ProbeClient } from "./client.ts";
import type { ScoreResult } from "./probes.ts";

export interface MultiStepResult extends ScoreResult {
	toolCalls: number;
}

const SETTINGS = "pressure_units = psi\nthreshold = 40\nlogging = on\n";

const FILES: Record<string, string> = {
	"config/settings.txt": SETTINGS,
	"config/settings.example.txt": SETTINGS,
	"scripts/plot.py": "import pandas as pd\n\ndf = pd.read_csv('data.csv')\ndf.plot(x='time', y='pressure')\n",
	"README.txt": "Pressure rig tools. The program reads its settings from the config folder.\n",
};

const TASK =
	"The program in this folder reads its settings from the config folder. Switch its pressure settings from psi to kPa: " +
	"set pressure_units to kPa and convert threshold (1 psi = 6.895 kPa, round to one decimal). " +
	"Leave the example settings file unchanged. When you are done, read the settings file again to check it.";

// Enough for list, read, edit, read back, and a few mistakes; a model that loops is stopped here.
const MAX_TURNS = 12;
const TIMEOUT_MS = 180_000;

/** Run the task and score three checks: the right edit, nothing else touched, and a read back. */
export async function probeMultiStep(client: ProbeClient): Promise<MultiStepResult> {
	const dir = mkdtempSync(join(tmpdir(), "pi-probe-"));
	try {
		for (const [path, content] of Object.entries(FILES)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		const { calls, error } = await runTask(client, dir);
		return { ...score(dir, calls, error), toolCalls: calls.length };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

interface Call {
	tool: string;
	/** Absolute path the call touched, when it named one. */
	path: string | undefined;
}

async function runTask(client: ProbeClient, dir: string): Promise<{ calls: Call[]; error: string | undefined }> {
	const definitions = [
		createLsToolDefinition(dir),
		createReadToolDefinition(dir),
		createEditToolDefinition(dir),
		createWriteToolDefinition(dir),
	];
	const agent = new Agent({
		streamFn: (model, context, options) =>
			client.registry.streamSimple(model, context, { ...options, temperature: 0 }),
		convertToLlm,
		initialState: {
			model: client.model,
			thinkingLevel: client.thinkingLevel,
			tools: wrapToolDefinitions(definitions),
			systemPrompt: buildSystemPrompt({
				cwd: dir,
				selectedTools: definitions.map((d) => d.name),
				toolSnippets: Object.fromEntries(definitions.map((d) => [d.name, d.promptSnippet ?? ""])),
				toolGuidelines: Object.fromEntries(definitions.map((d) => [d.name, d.promptGuidelines ?? []])),
			}),
		},
	});
	const calls: Call[] = [];
	const started = new Map<string, unknown>();
	let turns = 0;
	agent.subscribe((event) => {
		if (event.type === "tool_execution_start") {
			started.set(event.toolCallId, event.args);
		} else if (event.type === "tool_execution_end" && !event.isError) {
			const path = (started.get(event.toolCallId) as { path?: unknown } | undefined)?.path;
			calls.push({ tool: event.toolName, path: typeof path === "string" ? resolve(dir, path) : undefined });
		} else if (event.type === "turn_end" && ++turns >= MAX_TURNS) {
			agent.abort();
		}
	});
	const timer = setTimeout(() => agent.abort(), TIMEOUT_MS);
	try {
		await agent.prompt(TASK);
		await agent.waitForIdle();
	} catch (error) {
		return { calls, error: error instanceof Error ? error.message : String(error) };
	} finally {
		clearTimeout(timer);
	}
	return { calls, error: agent.state.errorMessage };
}

function score(dir: string, calls: Call[], error: string | undefined): ScoreResult {
	const settingsPath = join(dir, "config/settings.txt");
	const settings = readFileSync(settingsPath, "utf-8");
	const notes: string[] = [];
	if (error) notes.push(`stopped early: ${error}`);
	const changed =
		/^pressure_units\s*=\s*kPa\s*$/im.test(settings) &&
		/^threshold\s*=\s*275\.8\s*$/m.test(settings) &&
		/^logging\s*=\s*on\s*$/m.test(settings);
	if (!changed) notes.push("the settings file is not correctly converted");
	const others = Object.entries(FILES).filter(([path]) => path !== "config/settings.txt");
	const touched = others.filter(([path, content]) => readFileSync(join(dir, path), "utf-8") !== content);
	if (touched.length > 0) notes.push(`changed files it should have left alone: ${touched.map(([p]) => p).join(", ")}`);
	const lastChange = calls.findLastIndex((c) => (c.tool === "edit" || c.tool === "write") && c.path === settingsPath);
	const verified =
		lastChange !== -1 && calls.slice(lastChange + 1).some((c) => c.tool === "read" && c.path === settingsPath);
	if (!verified) notes.push("did not read the file back after changing it");
	return { passed: 3 - notes.filter((n) => !n.startsWith("stopped early")).length, total: 3, notes };
}
