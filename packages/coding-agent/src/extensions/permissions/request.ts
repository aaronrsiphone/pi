/**
 * Gate requests: what a tool call would do, built from a `tool_call` event.
 *
 * Every mode (careful levels and adaptive rules) decides from the same request, so a command is
 * classified the same way whichever mode is active.
 */

import { isToolCallEventType, type ToolAnnotations, type ToolCallEvent } from "../../core/extensions/types.ts";
import { analyzeBash, analyzeFileAccess, type CommandAnalysis } from "./classify.ts";
import type { PathEnv } from "./paths.ts";
import type { GateRequest } from "./policy.ts";
import { Risk } from "./risk.ts";
import type { Config } from "./store.ts";

/** Built-in tools that only read. */
export const READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

/**
 * Describe a tool call for the gate. Returns undefined for calls no mode gates: ordinary reads when
 * secret-read gating is off, and other tools when `customTools` is "off".
 */
export function buildRequest(
	event: ToolCallEvent,
	env: PathEnv,
	config: Config,
	annotationsOf: (toolName: string) => ToolAnnotations | undefined,
): GateRequest | undefined {
	if (isToolCallEventType("bash", event)) {
		const command = event.input.command;
		const analysis = analyzeBash(command, env, env.root);
		return {
			tool: "bash",
			toolName: "bash",
			analyses: analysis.commands,
			issues: analysis.issues,
			summary: `$ ${command}`,
		};
	}
	if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
		const a = analyzeFileAccess(event.toolName, event.input.path, "write", env, env.root);
		const size = isToolCallEventType("write", event)
			? ` (${event.input.content.length} chars)`
			: ` (${event.input.edits?.length ?? 1} edit(s))`;
		return {
			tool: "file:write",
			toolName: event.toolName,
			analyses: [a],
			issues: [],
			summary: `${event.toolName} ${a.paths[0].display}${size}`,
		};
	}
	if (READ_TOOLS.includes(event.toolName)) {
		if (!config.gateSecretReads) return undefined;
		const rawPath = (event.input as { path?: unknown }).path;
		const path = typeof rawPath === "string" ? rawPath : undefined;
		if (!path) return undefined;
		const a = analyzeFileAccess(event.toolName, path, "read", env, env.root);
		return {
			tool: "file:read",
			toolName: event.toolName,
			analyses: [a],
			issues: [],
			summary: `${event.toolName} ${a.paths[0].display}`,
		};
	}
	if (event.toolName === "powershell") {
		const command = String((event.input as { command?: unknown }).command ?? "");
		const head = command.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		const analysis: CommandAnalysis = {
			text: command,
			program: head,
			key: `powershell ${head}`.trim(),
			family: "powershell",
			risk: /^(get-|select-|where-|format-|measure-|test-path|resolve-path)/.test(head) ? Risk.low : Risk.medium,
			reasons: ["PowerShell commands are classified by their first cmdlet only"],
			paths: [],
			learnable: true,
		};
		return {
			tool: "powershell",
			toolName: "powershell",
			analyses: [analysis],
			issues: [],
			summary: `PS> ${command}`,
		};
	}
	if (config.customTools === "off") return undefined;
	const hints = annotationsOf(event.toolName);
	let risk: Risk;
	const reasons: string[] = [];
	if (config.customTools === "all") {
		risk = Risk.medium;
	} else if (hints?.readOnlyHint) {
		risk = Risk.safe;
	} else if (hints?.destructiveHint === true) {
		risk = Risk.high;
		reasons.push("tool declares it may delete or overwrite data");
	} else if ((hints?.destructiveHint ?? true) || (hints?.openWorldHint ?? true)) {
		risk = Risk.medium;
		reasons.push(hints ? "tool may modify data or reach external systems" : "tool declares no safety hints");
	} else {
		risk = Risk.low;
	}
	const args = clipJson(event.input);
	return {
		tool: event.toolName,
		toolName: event.toolName,
		analyses: [
			{
				text: args,
				program: event.toolName,
				key: event.toolName,
				family: event.toolName,
				risk,
				reasons,
				paths: [],
				learnable: true,
			},
		],
		issues: [],
		summary: `${event.toolName} ${args}`,
	};
}

function clipJson(value: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}
