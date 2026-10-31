import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPathCache } from "../src/extensions/permissions/paths.ts";
import { parseConfig, Store, withLock } from "../src/extensions/permissions/store.ts";
import { type FixtureOptions, setupPermissions } from "./permissions-fixture.ts";

let base: string;

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "permissions-adaptive-"));
	clearPathCache();
});

afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

function setup(options: Omit<FixtureOptions, "base" | "mode"> = {}) {
	return setupPermissions({ base, mode: "adaptive", ...options });
}

describe("adaptive permissions extension", () => {
	it("runs read-only commands without asking and asks for the rest", async () => {
		const h = setup();
		await h.startSession();
		expect(await h.bash("git status && ls -la | grep src")).toBeUndefined();
		expect(h.select).not.toHaveBeenCalled();

		h.answers.push("Allow once");
		expect(await h.bash("npm install")).toBeUndefined();
		expect(h.prompts[0].title).toContain("npm install");
		expect(h.prompts[0].title).toContain("medium");
	});

	it("blocks on deny with a reason the model can use, and passes the user's explanation", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Deny and tell the agent why");
		const result = await h.bash("npm install left-pad");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("use pnpm");
	});

	it("ends the turn when the user wants to chat", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Let's chat");
		const result = await h.bash("git push");
		expect(result).toMatchObject({ block: true, terminate: true });
	});

	it("treats a dismissed prompt as a denial", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("<dismiss>");
		expect((await h.bash("npm install"))?.block).toBe(true);
	});

	it("session grants cover later calls and survive a resume of the same session", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Allow for this session");
		await h.bash("npm run build");
		expect(await h.bash("npm run build")).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(1);
		// A different script is a different key.
		h.answers.push("Allow once");
		await h.bash("npm run deploy");
		expect(h.select).toHaveBeenCalledTimes(2);

		// Reload: grants are rebuilt from session entries.
		await h.startSession();
		expect(await h.bash("npm run build")).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(2);
	});

	it("'always' rules persist outside the repo and respect the risk ceiling", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Always allow in this project");
		await h.bash("git push origin main");
		expect(existsSync(join(h.root, ".pi"))).toBe(false);
		expect(
			readFileSync(join(h.stateDir, "projects", readdirOnly(join(h.stateDir, "projects")), "rules.json"), "utf-8"),
		).toContain('"command": "git push"');

		expect(await h.bash("git push origin feature")).toBeUndefined();
		h.answers.push("Deny");
		expect((await h.bash("git push --force origin main"))?.block).toBe(true);
		expect(h.prompts.at(-1)?.title).toContain("high");
	});

	it("serializes parallel prompts and re-checks queued calls after each answer", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Allow for this session");
		const results = await Promise.all([h.bash("npm run lint"), h.bash("npm run lint"), h.bash("npm run lint")]);
		expect(results).toEqual([undefined, undefined, undefined]);
		expect(h.select).toHaveBeenCalledTimes(1);
	});

	it("learns a low-risk pattern from varied approvals and stops asking", async () => {
		const h = setup();
		await h.startSession();
		for (const file of ["src/a.ts", "src/b.ts", "src/lib/c.ts"]) {
			h.answers.push("Allow once");
			expect(await h.call("write", { path: file, content: "x" })).toBeUndefined();
		}
		expect(h.select).toHaveBeenCalledTimes(3);
		// Fourth write in src: promoted to a learned rule instead of a prompt.
		expect(await h.call("edit", { path: "src/d.ts", edits: [] })).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(3);
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("Learned permission: write src/**");
		expect(await h.call("write", { path: "src/deep/e.ts", content: "x" })).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(3);
		// Learning never covers higher-risk paths.
		h.answers.push("Deny");
		expect((await h.call("write", { path: "src/.env", content: "x" }))?.block).toBe(true);
	});

	it("suggests a broader rule after approvals, and the suggestion applies when chosen", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Allow once");
		await h.bash("npm run lint");
		h.answers.push("Allow once");
		await h.bash("npm run typecheck");
		h.answers.push("Always allow in this project: npm run (any subcommand) (learned)");
		await h.bash("npm run test");
		expect(await h.bash("npm run build")).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(3);
	});

	it("promotes things granted for the session in several sessions", async () => {
		const h = setup({ sessionId: "s1" });
		await h.startSession();
		h.answers.push("Allow for this session");
		await h.bash("cargo test");
		await h.startSession("s2");
		h.answers.push("Allow for this session");
		await h.bash("cargo test");
		await h.startSession("s3");
		expect(await h.bash("cargo test")).toBeUndefined();
		expect(h.select).toHaveBeenCalledTimes(2);
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("allowed for the whole session in 2 sessions");
	});

	it("a removed learned rule is vetoed and not re-learned", async () => {
		const h = setup();
		await h.startSession();
		for (const file of ["src/a.ts", "src/b.ts", "src/c/d.ts"]) {
			h.answers.push("Allow once");
			await h.call("write", { path: file, content: "" });
		}
		await h.call("write", { path: "src/e.ts", content: "" });
		const store = new Store(h.stateDir, h.root);
		const learned = store.project().rules.find((r) => r.source === "learned")!;
		await h.command("permissions", `remove ${learned.id}`);
		h.answers.push("Allow once");
		await h.call("write", { path: "src/f.ts", content: "" });
		expect(h.select).toHaveBeenCalledTimes(4);
		expect(new Store(h.stateDir, h.root).project().rules.some((r) => r.source === "learned")).toBe(false);
	});

	it("critical commands always ask and offer no 'always' option", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Allow once");
		await h.bash("sudo whoami");
		expect(h.prompts[0].options.some((o) => o.startsWith("Always"))).toBe(false);
		expect(h.prompts[0].options.some((o) => o.startsWith("Allow for this session"))).toBe(false);
		h.answers.push("Deny");
		await h.bash("sudo whoami");
		expect(h.select).toHaveBeenCalledTimes(2);
	});

	it("never lets the agent write its own rules", async () => {
		const h = setup();
		await h.startSession();
		h.answers.push("Deny");
		const result = await h.call("write", { path: join(h.stateDir, "global.json"), content: "{}" });
		expect(result?.block).toBe(true);
		expect(h.prompts[0].title).toContain("critical");
	});

	it("gates reads of credentials but not ordinary reads", async () => {
		const h = setup();
		await h.startSession();
		expect(await h.call("read", { path: "src/index.ts" })).toBeUndefined();
		h.answers.push("Deny");
		expect((await h.call("read", { path: join(base, "home", ".aws", "credentials") }))?.block).toBe(true);
	});

	it("uses tool annotations for other tools", async () => {
		const h = setup();
		await h.startSession();
		expect(await h.call("mcp_read", { q: 1 })).toBeUndefined();
		h.answers.push("Deny");
		expect((await h.call("mcp_delete", { id: 1 }))?.block).toBe(true);
		expect(h.prompts[0].title).toContain("high");
	});

	it("headless mode applies rules and blocks what would need a prompt", async () => {
		const h = setup({ hasUI: false });
		await h.startSession();
		expect(await h.bash("git status")).toBeUndefined();
		const result = await h.bash("npm install");
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("no interactive UI");
	});

	it("repo rules: deny always applies, allow only in trusted projects", async () => {
		const untrusted = setup({ trusted: false });
		mkdirSync(join(untrusted.root, ".pi"), { recursive: true });
		writeFileSync(
			join(untrusted.root, ".pi", "permissions.json"),
			JSON.stringify({
				rules: [
					{ effect: "allow", tool: "bash", command: "npm install", maxRisk: 3 },
					{ effect: "deny", tool: "bash", command: "git push" },
				],
			}),
		);
		await untrusted.startSession();
		expect((await untrusted.bash("git push"))?.block).toBe(true);
		untrusted.answers.push("Allow once");
		await untrusted.bash("npm install");
		expect(untrusted.select).toHaveBeenCalledTimes(1);

		const trusted = setup({ trusted: true, root: untrusted.root });
		await trusted.startSession();
		expect(await trusted.bash("npm install")).toBeUndefined();
	});

	it("imports the legacy whitelist with risk caps", async () => {
		const h = setup();
		mkdirSync(join(h.root, ".pi"), { recursive: true });
		writeFileSync(
			join(h.root, ".pi", "permission-whitelist.json"),
			JSON.stringify({ approvedBashCommands: ["git", "npm run"], approvedWritePaths: ["src/a.ts"] }),
		);
		await h.startSession();
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("/permissions import");
		await h.command("permissions", "import");
		expect(await h.bash("git push")).toBeUndefined();
		expect(await h.call("write", { path: "src/a.ts", content: "" })).toBeUndefined();
		h.answers.push("Deny");
		expect((await h.bash("git push --force"))?.block).toBe(true);
	});

	it("explain shows classification and the decision", async () => {
		const h = setup();
		await h.startSession();
		await h.command("permissions", "explain cd .. && rm -rf project");
		const text = h.notify.mock.calls.at(-1)?.[0] as string;
		expect(text).toContain("[critical] rm");
		expect(text).toContain("Decision: ASK");
	});

	it("counts prompts saved", async () => {
		const h = setup();
		await h.startSession();
		await h.bash("ls");
		h.answers.push("Allow once");
		await h.bash("npm install");
		await h.emit("turn_end");
		await h.command("permissions", "stats");
		expect(h.notify.mock.calls.at(-1)?.[0]).toContain("2 gated calls, 50% ran without asking");
	});
});

describe("store", () => {
	it("serializes concurrent writers with a lock", () => {
		const file = join(base, "x.json");
		writeFileSync(`${file}.lock`, "");
		// A fresh lock blocks; a stale one is broken. Simulate staleness by waiting is slow, so check the timeout path.
		expect(() => withLock(file, () => 1)).toThrow(/timed out/);
		rmSync(`${file}.lock`);
		expect(withLock(file, () => 2)).toBe(2);
	}, 10_000);

	it("merges rules written by two sessions", () => {
		const root = join(base, "p");
		const a = new Store(join(base, "state"), root);
		const b = new Store(join(base, "state"), root);
		const rule = (command: string) => ({
			id: command,
			effect: "allow" as const,
			tool: "bash",
			command,
			maxRisk: 2 as const,
			scope: "project" as const,
			source: "user" as const,
			createdAt: 0,
			hits: 0,
		});
		expect(a.project().rules).toHaveLength(0);
		a.addRule(rule("make"));
		b.addRule(rule("cargo test"));
		expect(
			a
				.project()
				.rules.map((r) => r.command)
				.sort(),
		).toEqual(["cargo test", "make"]);
	});

	it("clamps unsafe config values", () => {
		const config = parseConfig({ autoAllowRisk: "critical", learning: { autoPromoteMaxRisk: "high" } });
		expect(config.autoAllowRisk).toBe(1);
		expect(config.learning.autoPromoteMaxRisk).toBe(2);
	});
});

function readdirOnly(dir: string): string {
	const entries = readdirSync(dir);
	expect(entries).toHaveLength(1);
	return entries[0];
}
