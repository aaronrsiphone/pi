/**
 * The multi-step probe: find a settings file, change it, and read it back, in a throwaway folder.
 *
 * It runs as a separate pi session (shared/isolated-session.ts) with pi's own read, ls, edit, and
 * write tools and pi's system prompt, so it measures the model the way pi uses it. The result is checked from the files and the tool calls,
 * never from what the model says it did. There is no shell, so nothing outside the folder can change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runIsolated } from "../shared/isolated-session.ts";
import { type ProbeClient, withRetries } from "./client.ts";
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

/**
 * Run the task and score three checks: the right edit, nothing else touched, and a read back.
 * A provider failure mid-task restarts it in a fresh folder; when it persists, `ProviderUnavailableError`.
 */
export async function probeMultiStep(client: ProbeClient): Promise<MultiStepResult> {
	const attempt = await withRetries(
		() => attemptTask(client),
		(a) => a.providerError,
	);
	return attempt.result;
}

async function attemptTask(
	client: ProbeClient,
): Promise<{ result: MultiStepResult; providerError: string | undefined }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-probe-"));
	try {
		for (const [path, content] of Object.entries(FILES)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
		const { calls, stopped, providerError } = await runTask(client, dir);
		return { result: { ...score(dir, calls, stopped), toolCalls: calls.length }, providerError };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

interface Call {
	tool: string;
	/** Absolute path the call touched, when it named one. */
	path: string | undefined;
}

interface TaskRun {
	calls: Call[];
	/** Why pi stopped the model: too many turns or too long. A model failure, scored as such. */
	stopped: string | undefined;
	/** Why the provider failed. Not the model's fault, so the task is run again. */
	providerError: string | undefined;
}

async function runTask(client: ProbeClient, dir: string): Promise<TaskRun> {
	const result = await runIsolated({
		dir,
		model: client.model,
		thinkingLevel: client.thinkingLevel,
		tools: ["ls", "read", "edit", "write"],
		prompt: TASK,
		maxTurns: MAX_TURNS,
		timeoutMs: TIMEOUT_MS,
		agentDir: client.agentDir,
	});
	const calls = result.calls
		.filter((c) => !c.isError)
		.map((c) => ({ tool: c.tool, path: typeof c.args.path === "string" ? resolve(dir, c.args.path) : undefined }));
	return { calls, stopped: result.stopped, providerError: result.providerError };
}

function score(dir: string, calls: Call[], stopped: string | undefined): ScoreResult {
	const settingsPath = join(dir, "config/settings.txt");
	const settings = readFileSync(settingsPath, "utf-8");
	const notes: string[] = [];
	if (stopped) notes.push(`stopped early: ${stopped}`);
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
