/**
 * Path resolution and path risk.
 *
 * Paths are resolved the way the operating system will see them: `~` and `$HOME` expand, relative
 * paths resolve against the tracked working directory, and symlinks in the existing part of the path
 * are followed so `src/link -> /etc` is treated as `/etc`.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Risk } from "./risk.ts";

export interface PathEnv {
	/** Project root (the session cwd). */
	root: string;
	home: string;
	/** Directories where writes are low risk (system temp dirs). */
	tempDirs: string[];
	/** Files and directories the agent must never write: the gate's own state and code. */
	protectedPaths: string[];
	platform: NodeJS.Platform;
}

export interface ResolvedPath {
	/** As written by the caller. */
	input: string;
	/** Absolute, symlink-resolved path. Empty when the path is dynamic. */
	abs: string;
	/** Project-relative POSIX path when inside the project ("" for the root itself). */
	rel: string | undefined;
	/** Depends on runtime expansion we cannot resolve. */
	dynamic: boolean;
	/** Contains a glob; `abs` is the directory the glob expands within. */
	glob: boolean;
}

export type Access = "read" | "write" | "delete";

export interface PathRisk {
	risk: Risk;
	reason: string | undefined;
}

const realpathCache = new Map<string, string>();

/** Resolve symlinks in the longest existing prefix of `abs`, keeping the non-existing tail. */
export function realpathLoose(abs: string): string {
	const cached = realpathCache.get(abs);
	if (cached !== undefined) return cached;
	let current = abs;
	const tail: string[] = [];
	for (let i = 0; i < 256; i++) {
		try {
			const real = realpathSync.native(current);
			const result = tail.length > 0 ? join(real, ...tail.reverse()) : real;
			if (realpathCache.size > 2000) realpathCache.clear();
			realpathCache.set(abs, result);
			return result;
		} catch {
			const parent = dirname(current);
			if (parent === current) break;
			tail.push(basename(current));
			current = parent;
		}
	}
	return abs;
}

/** Clear the realpath cache (tests, or after the filesystem changed under us). */
export function clearPathCache(): void {
	realpathCache.clear();
}

function norm(path: string, env: PathEnv): string {
	return env.platform === "win32" ? path.toLowerCase() : path;
}

export function isWithin(child: string, parent: string, env: PathEnv): boolean {
	const c = norm(child, env);
	const p = norm(parent, env);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function toPosix(path: string): string {
	return path.split(sep).join("/");
}

/**
 * Expand the parts of a shell word we can expand statically.
 * Returns undefined when the word still depends on runtime state.
 */
export function expandStatic(
	value: string,
	dynamic: boolean,
	tilde: boolean,
	env: PathEnv,
	cwd: string,
): string | undefined {
	let out = value;
	if (tilde) {
		if (out === "~") out = env.home;
		else if (out.startsWith("~/")) out = join(env.home, out.slice(2));
		else return undefined;
	}
	if (dynamic) {
		out = out.replace(/\$\{HOME\}|\$HOME\b/g, env.home).replace(/\$\{PWD\}|\$PWD\b/g, cwd);
		if (/[$`]/.test(out)) return undefined;
	}
	return out;
}

export function resolvePath(
	input: string,
	cwd: string | undefined,
	env: PathEnv,
	options: { dynamic?: boolean; tilde?: boolean; glob?: boolean } = {},
): ResolvedPath {
	const base = cwd ?? "";
	const expanded = expandStatic(input, options.dynamic ?? false, options.tilde ?? false, env, base);
	if (expanded === undefined || (cwd === undefined && !isAbsolute(expanded))) {
		return { input, abs: "", rel: undefined, dynamic: true, glob: options.glob ?? false };
	}
	let target = expanded;
	const glob = options.glob ?? /[*?[]/.test(expanded);
	if (glob) {
		// Evaluate the directory the glob expands within: "src/*.ts" -> "src".
		const firstGlob = target.search(/[*?[{]/);
		const prefix = firstGlob === -1 ? target : target.slice(0, firstGlob);
		target = prefix.endsWith("/") || prefix.endsWith(sep) || prefix === "" ? prefix || "." : dirname(prefix);
	}
	const abs = realpathLoose(resolve(base, target));
	const root = realpathLoose(env.root);
	const rel = isWithin(abs, root, env) ? toPosix(relative(root, abs)) : undefined;
	return { input, abs, rel, dynamic: false, glob };
}

// ---------------------------------------------------------------------------
// Glob matching for rules
// ---------------------------------------------------------------------------

const globCache = new Map<string, RegExp>();

/** Convert a path glob (`**`, `*`, `?`, `{a,b}`) to an anchored RegExp over POSIX paths. */
export function globToRegExp(glob: string): RegExp {
	const cached = globCache.get(glob);
	if (cached) return cached;
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const slashAfter = glob[i + 2] === "/";
				re += slashAfter ? "(?:.*/)?" : ".*";
				i += slashAfter ? 2 : 1;
			} else {
				re += "[^/]*";
			}
		} else if (ch === "?") {
			re += "[^/]";
		} else if (ch === "{") {
			const end = glob.indexOf("}", i);
			if (end === -1) {
				re += "\\{";
			} else {
				re += `(?:${glob
					.slice(i + 1, end)
					.split(",")
					.map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
					.join("|")})`;
				i = end;
			}
		} else {
			re += ch.replace(/[.+^$()|[\]\\]/g, "\\$&");
		}
	}
	const compiled = new RegExp(`^${re}$`);
	if (globCache.size > 500) globCache.clear();
	globCache.set(glob, compiled);
	return compiled;
}

export function matchGlob(glob: string, posixPath: string): boolean {
	return globToRegExp(glob).test(posixPath);
}

// ---------------------------------------------------------------------------
// Path risk
// ---------------------------------------------------------------------------

/** Inside the project: files whose modification can execute code or change agent/tool behavior. */
const PROJECT_EXEC_CONFIG = [
	".git/**",
	".pi/**",
	".husky/**",
	".githooks/**",
	".envrc",
	".github/workflows/**",
	".gitlab-ci.yml",
	".vscode/**",
	".idea/**",
	".claude/**",
	".cursor/**",
	"**/.git/hooks/**",
];

/** Inside the project: secrets. Writing is medium, reading is medium. */
const PROJECT_SECRETS = [
	"**/.env",
	"**/.env.*",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/id_rsa*",
	"**/id_ed25519*",
	"**/id_ecdsa*",
];

/** Relative to home: secrets whose read alone is high risk (credential exfiltration). */
const HOME_SECRETS = [
	".ssh/**",
	".aws/**",
	".azure/**",
	".config/gcloud/**",
	".kube/**",
	".docker/config.json",
	".netrc",
	".npmrc",
	".pypirc",
	".gnupg/**",
	".git-credentials",
	".config/gh/hosts.yml",
	".pi/agent/auth.json",
	".password-store/**",
	"Library/Keychains/**",
];

/** Relative to home: writes here change shell, tool, or login behavior. */
const HOME_EXEC_CONFIG = [
	".bashrc",
	".bash_profile",
	".profile",
	".zshrc",
	".zprofile",
	".zshenv",
	".config/fish/**",
	".gitconfig",
	".config/git/**",
	".ssh/**",
	".pi/**",
	".config/**",
	".local/bin/**",
	"Library/LaunchAgents/**",
];

const SYSTEM_ROOTS_POSIX = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/boot",
	"/System",
	"/Library",
	"/var",
	"/opt",
	"/dev",
	"/proc",
	"/sys",
];

function relTo(abs: string, base: string, env: PathEnv): string | undefined {
	const realBase = realpathLoose(base);
	return isWithin(abs, realBase, env) ? toPosix(relative(realBase, abs)) : undefined;
}

function anyGlob(globs: string[], rel: string): boolean {
	return globs.some((g) => matchGlob(g, rel));
}

/** Risk of accessing one resolved path. */
export function pathRisk(path: ResolvedPath, access: Access, env: PathEnv): PathRisk {
	if (path.dynamic) {
		return access === "read"
			? { risk: Risk.low, reason: `reads a path that depends on runtime expansion (${path.input})` }
			: {
					risk: Risk.high,
					reason: `${access === "delete" ? "deletes" : "writes"} a path that depends on runtime expansion (${path.input})`,
				};
	}
	const abs = path.abs;
	const verb = access === "read" ? "reads" : access === "delete" ? "deletes" : "writes";

	for (const protectedPath of env.protectedPaths) {
		const real = realpathLoose(protectedPath);
		if (isWithin(abs, real, env) || (access !== "read" && isWithin(real, abs, env) && path.glob)) {
			return access === "read"
				? { risk: Risk.safe, reason: undefined }
				: { risk: Risk.critical, reason: `${verb} the permission gate's own rules or code (${path.input})` };
		}
	}

	const homeRel = relTo(abs, env.home, env);

	if (path.rel !== undefined) {
		const rel = path.rel;
		if (access !== "read" && rel === "") {
			if (access === "write") return { risk: Risk.low, reason: undefined };
			return path.glob
				? { risk: Risk.high, reason: "deletes matching files anywhere in the project" }
				: { risk: Risk.critical, reason: "deletes the project root" };
		}
		if (access === "read") {
			if (anyGlob(PROJECT_SECRETS, rel)) return { risk: Risk.medium, reason: `reads a secrets file (${rel})` };
			return { risk: Risk.safe, reason: undefined };
		}
		if (anyGlob(PROJECT_EXEC_CONFIG, rel) || rel === ".git") {
			return { risk: Risk.high, reason: `${verb} ${rel}, which controls code execution or agent behavior` };
		}
		if (anyGlob(PROJECT_SECRETS, rel)) return { risk: Risk.medium, reason: `${verb} a secrets file (${rel})` };
		return { risk: access === "delete" ? Risk.medium : Risk.low, reason: undefined };
	}

	// Outside the project.
	if (access === "read") {
		if (homeRel !== undefined && anyGlob(HOME_SECRETS, homeRel)) {
			return { risk: Risk.high, reason: `reads credentials (~/${homeRel})` };
		}
		if (anyGlob(PROJECT_SECRETS, toPosix(abs).replace(/^\//, ""))) {
			return { risk: Risk.medium, reason: `reads a secrets file (${path.input})` };
		}
		return { risk: Risk.safe, reason: undefined };
	}

	if (homeRel !== undefined && (homeRel === ".ssh" || homeRel.startsWith(".ssh/"))) {
		return { risk: Risk.critical, reason: `${verb} ~/${homeRel} (SSH keys and authorized logins)` };
	}
	for (const tmp of env.tempDirs) {
		if (isWithin(abs, realpathLoose(tmp), env) && norm(abs, env) !== norm(realpathLoose(tmp), env)) {
			return { risk: Risk.low, reason: undefined };
		}
	}
	if (abs === "/dev/null" || abs === "/dev/stdout" || abs === "/dev/stderr" || abs === "/dev/tty") {
		return { risk: Risk.safe, reason: undefined };
	}

	if (homeRel === "" || isWithin(env.root, abs, env) || abs === sep || /^[a-zA-Z]:\\?$/.test(abs)) {
		return access === "delete"
			? { risk: Risk.critical, reason: `deletes ${path.input}, which contains the project or home directory` }
			: { risk: Risk.high, reason: `${verb} ${path.input} outside the project` };
	}
	if (env.platform !== "win32" && SYSTEM_ROOTS_POSIX.some((r) => abs === r || abs.startsWith(`${r}/`))) {
		return { risk: Risk.critical, reason: `${verb} system path ${path.input}` };
	}
	if (env.platform === "win32" && /^[a-z]:\\(windows|program files)/i.test(abs)) {
		return { risk: Risk.critical, reason: `${verb} system path ${path.input}` };
	}
	if (homeRel !== undefined && anyGlob(HOME_EXEC_CONFIG, homeRel)) {
		return { risk: Risk.high, reason: `${verb} ~/${homeRel}, which changes shell or tool behavior` };
	}
	return { risk: Risk.high, reason: `${verb} ${path.input} outside the project` };
}

/** Display form for prompts and rules: project-relative when possible. */
export function displayPath(path: ResolvedPath, env: PathEnv): string {
	if (path.dynamic) return path.input;
	if (path.rel !== undefined) return path.rel === "" ? "." : path.rel;
	const homeRel = relTo(path.abs, env.home, env);
	return homeRel !== undefined ? `~/${homeRel}` : path.abs;
}
