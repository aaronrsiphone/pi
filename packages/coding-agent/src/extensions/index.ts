import type { InlineExtension } from "../core/extensions/types.ts";
import capabilityExtension from "./capability/index.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import onboardingExtension from "./onboarding/index.ts";
import permissionsExtension from "./permissions/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true },
	// Replaceable: an extension that registers `codemode`, `tool_search`, or `/mcp` (such as a third-party
	// MCP extension) takes over instead of running alongside the built-in one.
	{ name: "codemode", factory: codemodeExtension, replaceable: true, builtin: true },
	{ name: "tool-search", factory: toolSearchExtension, replaceable: true, builtin: true },
	{ name: "mcp", factory: mcpExtension, replaceable: true, builtin: true },
	// Replaceable: a permission extension that registers `/permissions` takes over, so two gates never both ask.
	{ name: "permissions", factory: permissionsExtension, replaceable: true, builtin: true },
	{ name: "capability", factory: capabilityExtension, builtin: true },
	{ name: "onboarding", factory: onboardingExtension, builtin: true },
];
