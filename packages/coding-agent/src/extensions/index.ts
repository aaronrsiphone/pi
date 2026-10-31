import type { InlineExtension } from "../core/extensions/types.ts";
import benchmarkExtension from "./benchmark/index.ts";
import capabilityExtension from "./capability/index.ts";
import carefulExtension from "./careful/index.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import onboardingExtension from "./onboarding/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// Each extension below works on its own; onboarding uses the others when they are enabled.
	{ name: "careful", factory: carefulExtension, builtin: true },
	{ name: "capability", factory: capabilityExtension, builtin: true },
	{ name: "benchmark", factory: benchmarkExtension, builtin: true },
	{ name: "onboarding", factory: onboardingExtension, builtin: true },
];
