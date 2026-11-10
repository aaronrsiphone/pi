// A fake extension API and context for the careful extension: tool calls, prompts, and session
// entries without an agent session. test/suite/careful.test.ts covers a real session.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { createCarefulExtension } from "../examples/extensions/pi-guided/careful/index.ts";
import type { CarefulLevel } from "../examples/extensions/pi-guided/careful/levels.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "../src/core/extensions/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void>;

export interface Fixture {
	root: string;
	dir: string;
	ctx: ExtensionContext;
	select: ReturnType<typeof vi.fn>;
	notify: ReturnType<typeof vi.fn>;
	input: ReturnType<typeof vi.fn>;
	setStatus: ReturnType<typeof vi.fn>;
	entries: { type: string; customType: string; data: unknown; id: string; session: string }[];
	/** Tools declared to the model, as `setActiveTools()` left them. */
	activeTools: string[];
	/** Answers for upcoming prompts, matched by option prefix. */
	answers: string[];
	prompts: { title: string; options: string[] }[];
	call(toolName: string, input: Record<string, unknown>): Promise<ToolCallEventResult | undefined>;
	bash(command: string): Promise<ToolCallEventResult | undefined>;
	command(name: string, args: string): Promise<void>;
	startSession(sessionId?: string): Promise<void>;
	emit(event: string, payload?: unknown): Promise<unknown>;
	emitBus(channel: string, data?: unknown): void;
	/** Payloads sent on the event bus, by channel. */
	sent: Map<string, unknown[]>;
}

export interface FixtureOptions {
	base: string;
	level?: CarefulLevel;
	flag?: string;
	hasUI?: boolean;
	sessionId?: string;
	root?: string;
}

let callId = 0;

/** Load the careful extension into a fake API rooted at `<base>/project`. */
export function setupCareful(options: FixtureOptions): Fixture {
	const root = options.root ?? join(options.base, "project");
	const dir = join(options.base, "home", ".pi", "agent", "careful");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(dir, { recursive: true });
	if (options.level !== undefined) writeFileSync(join(dir, "config.json"), JSON.stringify({ level: options.level }));

	const handlers = new Map<string, Handler[]>();
	const bus = new Map<string, ((data: unknown) => void)[]>();
	const sent = new Map<string, unknown[]>();
	const commands = new Map<string, CommandHandler>();
	const entries: Fixture["entries"] = [];
	const answers: string[] = [];
	const prompts: Fixture["prompts"] = [];
	const registeredTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "mcp_read", "mcp_delete"];
	let activeTools = ["read", "bash", "edit", "write", "mcp_read", "mcp_delete"];
	let sessionId = options.sessionId ?? "session-1";

	const api = {
		on(event: string, handler: Handler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			return () => undefined;
		},
		registerCommand(name: string, command: { handler: CommandHandler }) {
			commands.set(name, command.handler);
		},
		registerFlag: () => undefined,
		getFlag: (name: string) => (name === "careful" ? options.flag : undefined),
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data, id: String(entries.length), session: sessionId });
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]) {
			activeTools = names.filter((name) => registeredTools.includes(name));
		},
		getAllTools: () => registeredTools.map((name) => ({ name })),
		events: {
			on(channel: string, handler: (data: unknown) => void) {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => undefined;
			},
			emit(channel: string, data: unknown) {
				sent.set(channel, [...(sent.get(channel) ?? []), data]);
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;

	createCarefulExtension(api, { dir });

	const select = vi.fn(async (title: string, opts: string[]) => {
		prompts.push({ title, options: opts });
		const want = answers.shift();
		if (want === undefined) throw new Error(`unexpected prompt: ${title.split("\n")[0]}`);
		if (want === "<dismiss>") return undefined;
		const match = opts.find((o) => o.startsWith(want));
		if (!match) throw new Error(`no option starting with "${want}" in ${JSON.stringify(opts)}`);
		return match;
	});
	const notify = vi.fn();
	const input = vi.fn(async () => "use pnpm");
	const setStatus = vi.fn();
	const ctx = {
		hasUI: options.hasUI ?? true,
		cwd: root,
		mode: "tui",
		signal: undefined,
		ui: { select, notify, input, setStatus, confirm: vi.fn() },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getBranch: () => entries.filter((e) => e.session === sessionId),
		},
	} as unknown as ExtensionContext;

	const emit = async (event: string, payload: unknown = { type: event }) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = (await handler(payload, ctx)) ?? result;
		return result;
	};

	return {
		root,
		dir,
		sent,
		ctx,
		select,
		notify,
		input,
		setStatus,
		entries,
		get activeTools() {
			return activeTools;
		},
		answers,
		prompts,
		async call(toolName, toolInput) {
			const event = { type: "tool_call", toolCallId: `c${++callId}`, toolName, input: toolInput } as ToolCallEvent;
			return (await emit("tool_call", event)) as ToolCallEventResult | undefined;
		},
		bash(command) {
			return this.call("bash", { command });
		},
		async command(name, args) {
			await commands.get(name)!(args, ctx);
		},
		async startSession(id) {
			if (id) sessionId = id;
			await emit("session_start");
		},
		emit,
		emitBus(channel, data) {
			api.events.emit(channel, data);
		},
	};
}
