/**
 * Command risk classification.
 *
 * `analyzeBash()` parses a command string, walks every simple command it can run (including
 * subshells, substitutions, `bash -c` strings, `find -exec`, and wrappers such as `sudo`,
 * `timeout`, or `xargs`), tracks `cd` for path resolution, and classifies each command:
 *
 *   risk     tier from risk.ts, combined from the program, its arguments, and every path it touches
 *   key      the most specific learnable identity, e.g. "npm run test", "git push", "curl api.github.com"
 *   family   one step more general, e.g. "npm run", "git", "curl"
 *   paths    files it writes or deletes (and risky reads), resolved against the tracked cwd
 *
 * Unknown programs default to medium. Nothing here grants permission; it only describes.
 */

import { basename } from "node:path";
import { type Access, displayPath, type PathEnv, pathRisk, type ResolvedPath, resolvePath } from "./paths.ts";
import { maxRisk, Risk } from "./risk.ts";
import { parseShell, type Redirect, type Script, type SimpleCommand, type Word } from "./shell.ts";

export interface PathAccess {
	path: ResolvedPath;
	access: Access;
	display: string;
	risk: Risk;
}

export interface CommandAnalysis {
	text: string;
	program: string;
	key: string;
	family: string;
	risk: Risk;
	reasons: string[];
	/** Paths written or deleted, plus reads that raised risk. */
	paths: PathAccess[];
	/** False when no rule may ever approve it (dynamic program name, critical risk). */
	learnable: boolean;
}

export interface BashAnalysis {
	commands: CommandAnalysis[];
	issues: string[];
	risk: Risk;
}

// ---------------------------------------------------------------------------
// Argument view
// ---------------------------------------------------------------------------

class Args {
	readonly words: Word[];
	readonly values: string[];

	constructor(words: Word[]) {
		this.words = words;
		this.values = words.map((w) => w.value);
	}

	/** True if any flag is present. Short flags match inside clusters (`-rf` has `-r`); long flags match `--x` and `--x=...`. */
	has(...flags: string[]): boolean {
		for (const v of this.values) {
			if (v === "--") return false;
			for (const flag of flags) {
				if (flag.startsWith("--")) {
					if (v === flag || v.startsWith(`${flag}=`)) return true;
				} else if (/^-[a-zA-Z0-9]$/.test(flag)) {
					if (/^-[a-zA-Z0-9]+$/.test(v) && v.includes(flag[1])) return true;
				} else if (v === flag) {
					return true;
				}
			}
		}
		return false;
	}

	/** Value of an option given as `-o v`, `-ov`, `--opt v`, or `--opt=v`. */
	option(...names: string[]): Word | undefined {
		for (let i = 0; i < this.words.length; i++) {
			const v = this.values[i];
			if (v === "--") return undefined;
			for (const name of names) {
				if (v === name) return this.words[i + 1];
				if (name.startsWith("--") && v.startsWith(`${name}=`))
					return derivedWord(this.words[i], v.slice(name.length + 1));
				if (!name.startsWith("--") && name.length === 2 && v.startsWith(name) && v.length > 2) {
					return derivedWord(this.words[i], v.slice(2));
				}
			}
		}
		return undefined;
	}

	/** Non-option words. Options listed in `takesValue` consume the following word. */
	positionals(takesValue: string[] = []): Word[] {
		const out: Word[] = [];
		let afterDashDash = false;
		for (let i = 0; i < this.words.length; i++) {
			const v = this.values[i];
			if (afterDashDash) {
				out.push(this.words[i]);
				continue;
			}
			if (v === "--") {
				afterDashDash = true;
				continue;
			}
			if (v.startsWith("-") && v.length > 1 && !this.words[i].dynamic) {
				if (takesValue.includes(v)) i++;
				continue;
			}
			out.push(this.words[i]);
		}
		return out;
	}

	/** Index of the first positional, honoring options that take values. */
	firstPositionalIndex(takesValue: string[] = []): number {
		for (let i = 0; i < this.words.length; i++) {
			const v = this.values[i];
			if (v === "--") return i + 1 < this.words.length ? i + 1 : -1;
			if (v.startsWith("-") && v.length > 1 && !this.words[i].dynamic) {
				if (takesValue.includes(v)) i++;
				continue;
			}
			return i;
		}
		return -1;
	}

	from(index: number): Args {
		return new Args(this.words.slice(index));
	}
}

function derivedWord(source: Word, value: string): Word {
	return { ...source, raw: value, value, substitutions: [] };
}

function synthetic(raw: string, dynamic: boolean): Word {
	return { raw, value: raw, dynamic, glob: false, tilde: false, substitutions: [] };
}

// ---------------------------------------------------------------------------
// Handler model
// ---------------------------------------------------------------------------

interface Verdict {
	risk: Risk;
	/** Defaults to the program name. */
	key?: string;
	family?: string;
	reasons?: string[];
	reads?: Word[];
	writes?: Word[];
	deletes?: Word[];
	/** Resolve this command's paths against another directory (`git -C`, `make -C`, `tar -C`). */
	cwd?: Word;
	/** Analyze another argv as the effective command (wrappers). */
	inner?: Word[];
	/** The inner command receives extra arguments from stdin (`xargs`, `find -exec {}`). */
	innerStdinArgs?: boolean;
	/** Analyze a shell string (`bash -c`, `eval`, `trap`). */
	innerScript?: Word;
	learnable?: boolean;
}

interface HandlerContext {
	name: string;
	args: Args;
	/** Program feeding stdin through a pipe, if any. */
	pipedFrom: string | undefined;
}

type Handler = (ctx: HandlerContext) => Verdict;

const v = (risk: Risk, extra: Omit<Verdict, "risk"> = {}): Verdict => ({ risk, ...extra });

const SUBCOMMAND = /^[a-zA-Z][a-zA-Z0-9._:-]*$/;

function subKey(name: string, sub: Word | undefined): string {
	return sub && !sub.dynamic && SUBCOMMAND.test(sub.value) ? `${name} ${sub.value}` : name;
}

// ---------------------------------------------------------------------------
// Program knowledge base
// ---------------------------------------------------------------------------

// biome-ignore format: data table
const SAFE_PROGRAMS = [
	"ls", "ll", "la", "dir", "vdir", "cat", "tac", "bat", "batcat", "less", "more", "most", "head", "tail", "wc", "nl",
	"grep", "egrep", "fgrep", "ag", "ack", "tree", "pwd", "echo", "printf", "true", "false", "test", "[", "[[", "which",
	"whereis", "type", "file", "stat", "du", "df", "free", "uptime", "uname", "whoami", "id", "groups", "hostname",
	"date", "cal", "cut", "tr", "paste", "column", "fold", "comm", "diff", "colordiff", "cmp", "md5sum", "md5",
	"sha1sum", "sha256sum", "sha512sum", "shasum", "cksum", "base64", "xxd", "hexdump", "od", "strings", "jq", "yq",
	"gojq", "realpath", "readlink", "basename", "dirname", "seq", "sleep", "wait", "jobs", "nproc", "lscpu", "ps",
	"pgrep", "lsof", "arch", "sw_vers", "locale", "tput", "tty", "logname", "printenv", "man", "info", "help",
	"history", "hash", "cd", "pushd", "popd", "dirs", "exit", "return", ":", "read", "let", "local", "declare",
	"typeset", "unset", "set", "shopt", "getconf", "expand", "unexpand", "fmt", "pr", "join", "look", "rev", "shuf",
	"numfmt", "factor", "expr", "bc", "dc", "units", "yes", "mktemp", "ulimit", "umask", "fc", "tsort", "iconv",
];

/** Project tooling: runs project code or config, writes only inside the project. */
// biome-ignore format: data table
const TOOLING_PROGRAMS = [
	"pytest", "py.test", "nox", "vitest", "jest", "mocha", "ava", "tap", "tsc", "eslint", "biome", "prettier", "ruff",
	"black", "isort", "flake8", "pylint", "mypy", "pyright", "rubocop", "rspec", "phpunit", "phpstan", "shellcheck",
	"shfmt", "hadolint", "golangci-lint", "gofmt", "goimports", "staticcheck", "rustfmt", "swiftlint", "ktlint",
	"stylelint", "markdownlint", "yamllint", "actionlint", "tflint", "cspell", "codespell", "knip", "depcheck", "madge",
	"gcc", "g++", "clang", "clang++", "cc", "rustc", "javac", "swiftc", "tsgo", "oxlint", "dprint", "turbo", "nx",
	"lerna",
];

// biome-ignore format: data table
const CRITICAL_PROGRAMS = [
	"mkfs", "mkfs.ext4", "mkfs.ext3", "mkfs.xfs", "mkfs.vfat", "mkfs.fat", "mkfs.ntfs", "mke2fs", "fdisk", "sfdisk",
	"gdisk", "parted", "wipefs", "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "su", "passwd", "useradd",
	"userdel", "usermod", "groupadd", "visudo", "chroot", "pkexec", "insmod", "rmmod", "modprobe", "kexec", "format",
	"diskpart", "bcdedit",
];

const NETWORK_SHELLS = ["ssh", "scp", "sftp", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "mosh"];
// biome-ignore format: data table
const INTERPRETERS = [
	"python", "python3", "python2", "node", "nodejs", "ruby", "perl", "php", "Rscript", "lua", "luajit", "tsx",
	"ts-node", "deno", "pypy", "pypy3", "osascript",
];
const SHELLS = ["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "pwsh", "powershell", "csh", "tcsh", "busybox"];
const DOWNLOADERS = ["curl", "wget", "fetch", "aria2c", "http", "https", "xh"];

// biome-ignore format: data table
const DANGEROUS_ENV = new Set([
	"PATH", "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "BASH_ENV",
	"ENV", "PROMPT_COMMAND", "IFS", "PAGER", "MANPAGER", "GIT_PAGER", "EDITOR", "VISUAL", "GIT_EDITOR", "GIT_SSH",
	"GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_PROXY_COMMAND", "GIT_EXEC_PATH",
	"GIT_TEMPLATE_DIR", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT", "NODE_OPTIONS", "PYTHONSTARTUP", "PYTHONPATH", "PERL5OPT", "PERL5LIB", "RUBYOPT", "RUBYLIB",
	"npm_config_script_shell", "SHELLOPTS", "BASHOPTS", "PS4", "HISTFILE", "TMPDIR", "HOME", "ZDOTDIR",
]);

function isDangerousEnvName(name: string): boolean {
	return (
		DANGEROUS_ENV.has(name) ||
		name.startsWith("LD_") ||
		name.startsWith("DYLD_") ||
		name.startsWith("GIT_CONFIG_KEY") ||
		name.startsWith("GIT_CONFIG_VALUE")
	);
}

const SAFE_GIT_CONFIG =
	/^(color\.|advice\.|user\.(name|email)$|core\.quotepath$|init\.defaultbranch$|log\.|format\.pretty$|column\.ui$|diff\.(renames|algorithm|context)$|status\.)/i;
const DANGEROUS_GIT_CONFIG =
	/^(alias\.|core\.(pager|editor|sshcommand|hookspath|fsmonitor|gitproxy|askpass|attributesfile|excludesfile)|diff\..*\.(command|textconv)|filter\.|credential\.|sequence\.editor|gpg\.|protocol\.|uploadpack\.|receivepack\.|merge\..*\.driver|includeif|include\.|remote\..*\.(uploadpack|receivepack))/i;

function gitHandler({ args }: HandlerContext): Verdict {
	const reasons: string[] = [];
	let risk: Risk = Risk.safe;
	let cwd: Word | undefined;
	let i = 0;
	for (; i < args.words.length; i++) {
		const value = args.values[i];
		if (value === "-C") {
			cwd = args.words[++i];
		} else if (value === "-c") {
			const config = args.values[++i] ?? "";
			const key = config.split("=")[0];
			if (!SAFE_GIT_CONFIG.test(key)) {
				risk = maxRisk(risk, Risk.high);
				reasons.push(`git -c ${key} can run arbitrary commands`);
			}
		} else if (/^--(exec-path|config-env)/.test(value)) {
			risk = maxRisk(risk, Risk.high);
			reasons.push(`git ${value.split("=")[0]} can run arbitrary commands`);
			if (!value.includes("=")) i++;
		} else if (/^--(git-dir|work-tree|namespace|super-prefix)$/.test(value)) {
			risk = maxRisk(risk, Risk.medium);
			reasons.push(`git ${value} points git at another repository`);
			i++;
		} else if (value.startsWith("-")) {
			if (/^--(git-dir|work-tree)=/.test(value)) {
				risk = maxRisk(risk, Risk.medium);
				reasons.push(`git ${value.split("=")[0]} points git at another repository`);
			}
		} else {
			break;
		}
	}
	const subWord = args.words[i];
	const sub = subWord?.value ?? "";
	const rest = args.from(i + 1);
	const key = subWord ? subKey("git", subWord) : "git";
	const out = (r: Risk, extra: Omit<Verdict, "risk"> = {}): Verdict => ({
		risk: maxRisk(risk, r),
		key,
		family: "git",
		cwd,
		...extra,
		reasons: [...reasons, ...(extra.reasons ?? [])],
	});

	switch (sub) {
		case "":
		case "status":
		case "log":
		case "show":
		case "rev-parse":
		case "ls-files":
		case "ls-tree":
		case "blame":
		case "annotate":
		case "describe":
		case "shortlog":
		case "cat-file":
		case "merge-base":
		case "grep":
		case "whatchanged":
		case "show-ref":
		case "for-each-ref":
		case "name-rev":
		case "rev-list":
		case "count-objects":
		case "check-ignore":
		case "check-attr":
		case "var":
		case "help":
		case "version":
		case "fsck":
		case "range-diff":
		case "cherry":
		case "show-branch":
		case "verify-commit":
		case "verify-tag":
			return out(Risk.safe);
		case "diff": {
			const output = rest.option("--output");
			return out(Risk.safe, output ? { writes: [output] } : {});
		}
		case "reflog":
			return out(["expire", "delete"].includes(rest.values[0] ?? "") ? Risk.medium : Risk.safe);
		case "ls-remote":
		case "fetch":
			return out(Risk.low, { reasons: ["contacts a remote"] });
		case "branch": {
			if (rest.has("-D") || (rest.has("-d", "--delete") && rest.has("-f", "--force"))) {
				return out(Risk.high, { reasons: ["force-deletes a branch"] });
			}
			if (rest.has("-d", "--delete")) return out(Risk.medium, { reasons: ["deletes a branch"] });
			if (rest.has("-f", "--force", "-M", "-C")) return out(Risk.high, { reasons: ["overwrites a branch"] });
			const listing =
				rest.positionals(["--format", "--sort", "--contains", "--merged", "--no-merged", "--points-at"]).length ===
				0;
			return out(listing || rest.has("--list", "-l", "-a", "-r", "--show-current") ? Risk.safe : Risk.low);
		}
		case "tag":
			if (rest.has("-d", "--delete")) return out(Risk.medium, { reasons: ["deletes a tag"] });
			if (rest.has("-f", "--force")) return out(Risk.high, { reasons: ["overwrites a tag"] });
			return out(rest.positionals().length === 0 || rest.has("-l", "--list") ? Risk.safe : Risk.low);
		case "remote": {
			const action = rest.positionals()[0]?.value;
			return out(action === undefined || action === "show" || action === "get-url" ? Risk.safe : Risk.medium);
		}
		case "config": {
			if (rest.has("--global", "--system", "--file", "-f")) {
				const reading = rest.has("--get", "--get-all", "--get-regexp", "--list", "-l");
				if (!reading) return out(Risk.high, { reasons: ["changes git config outside this repository"] });
			}
			const pos = rest.positionals(["--file", "-f", "--blob", "--type", "--default"]);
			const reading =
				rest.has("--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--name-only") ||
				pos.length <= 1;
			if (
				reading &&
				!rest.has(
					"--unset",
					"--unset-all",
					"--add",
					"--replace-all",
					"--rename-section",
					"--remove-section",
					"-e",
					"--edit",
				)
			) {
				return out(Risk.safe);
			}
			const configKey = pos[0]?.value ?? "";
			if (DANGEROUS_GIT_CONFIG.test(configKey) || !/^[\w.-]+$/.test(configKey)) {
				return out(Risk.high, { reasons: [`setting ${configKey || "config"} can make git run commands`] });
			}
			return out(Risk.medium, { reasons: ["changes repository config"] });
		}
		case "stash": {
			const action = rest.positionals()[0]?.value ?? "push";
			if (action === "list" || action === "show") return out(Risk.safe);
			if (action === "clear") return out(Risk.high, { reasons: ["deletes all stashes"] });
			if (action === "drop") return out(Risk.medium, { reasons: ["deletes a stash"] });
			return out(Risk.low);
		}
		case "add":
		case "commit":
		case "init":
		case "notes":
		case "mv":
		case "worktree":
		case "sparse-checkout":
			if (sub === "commit" && rest.has("--no-verify", "-n")) {
				return out(Risk.medium, { reasons: ["skips commit hooks"] });
			}
			if (sub === "worktree" && rest.has("--force", "-f"))
				return out(Risk.high, { reasons: ["forces worktree changes"] });
			if (sub === "worktree" && rest.values[0] === "list") return out(Risk.safe);
			return out(Risk.low);
		case "rm":
			return out(
				rest.has("--cached") ? Risk.low : Risk.medium,
				rest.has("--cached") ? {} : { deletes: rest.positionals() },
			);
		case "restore":
			if (rest.has("--staged", "-S") && !rest.has("--worktree", "-W")) return out(Risk.low);
			return out(Risk.medium, { reasons: ["discards uncommitted changes"] });
		case "checkout":
		case "switch": {
			if (rest.has("-f", "--force", "--discard-changes"))
				return out(Risk.high, { reasons: ["discards uncommitted changes"] });
			const pathspec = rest.values.includes("--") || rest.values.includes(".");
			if (pathspec) return out(Risk.medium, { reasons: ["discards uncommitted changes"] });
			return out(Risk.low);
		}
		case "reset":
			if (rest.has("--hard", "--merge", "--keep"))
				return out(Risk.high, { reasons: ["discards commits or uncommitted changes"] });
			return out(Risk.low);
		case "clean":
			if (rest.has("-n", "--dry-run")) return out(Risk.safe);
			return out(Risk.high, { reasons: ["deletes untracked files"] });
		case "push": {
			const refs = rest.positionals(["-o", "--push-option", "--receive-pack", "--exec", "--repo"]);
			if (rest.has("--receive-pack", "--exec")) return out(Risk.high, { reasons: ["runs a remote command"] });
			if (
				rest.has(
					"-f",
					"--force",
					"--force-with-lease",
					"--force-if-includes",
					"--mirror",
					"--delete",
					"-d",
					"--prune",
				)
			) {
				return out(Risk.high, { reasons: ["rewrites or deletes remote history"] });
			}
			if (refs.some((r) => r.value.startsWith("+") || r.value.startsWith(":"))) {
				return out(Risk.high, { reasons: ["force-pushes or deletes a remote ref"] });
			}
			if (rest.has("--no-verify")) return out(Risk.high, { reasons: ["skips push hooks"] });
			return out(Risk.medium, { reasons: ["publishes commits to a remote"] });
		}
		case "pull":
		case "merge":
		case "cherry-pick":
		case "revert":
		case "am":
		case "apply":
		case "clone":
		case "submodule":
		case "subtree":
		case "lfs":
			if (sub === "submodule" && ["status", "summary", "foreach"].includes(rest.values[0] ?? "")) {
				return rest.values[0] === "foreach"
					? out(Risk.high, { reasons: ["runs a command in every submodule"] })
					: out(Risk.safe);
			}
			return out(Risk.medium);
		case "rebase":
			if (rest.has("-x", "--exec")) return out(Risk.high, { reasons: ["runs commands during rebase"] });
			return out(Risk.medium, { reasons: ["rewrites history"] });
		case "bisect":
			if (rest.values[0] === "run") return out(Risk.high, { reasons: ["runs a command per commit"] });
			return out(Risk.low);
		case "gc":
		case "prune":
		case "repack":
		case "maintenance":
			return out(Risk.medium);
		case "filter-branch":
		case "filter-repo":
		case "replace":
		case "update-ref":
		case "symbolic-ref":
		case "hook":
		case "difftool":
		case "mergetool":
		case "daemon":
		case "instaweb":
		case "send-email":
		case "credential":
			return out(Risk.high, { reasons: [`git ${sub} can rewrite history, run tools, or expose credentials`] });
		default:
			return out(Risk.medium, { reasons: [`unknown git subcommand or alias "${sub}"`] });
	}
}

// biome-ignore format: data table
const PM_SAFE = new Set([
	"ls", "list", "ll", "la", "view", "info", "show", "outdated", "why", "explain", "audit", "prefix", "root", "bin",
	"doctor", "help", "search", "whoami", "ping", "fund", "licenses", "query", "docs", "repo", "bugs", "home", "-v",
	"--version", "version",
]);
// biome-ignore format: data table
const PM_INSTALL = new Set([
	"install", "i", "in", "add", "ci", "clean-install", "update", "upgrade", "up", "remove", "rm", "r", "uninstall",
	"un", "unlink", "dedupe", "ddp", "prune", "link", "ln", "rebuild", "rb", "import", "patch", "patch-commit",
]);
// biome-ignore format: data table
const PM_PUBLISH = new Set([
	"publish", "unpublish", "deprecate", "owner", "access", "token", "adduser", "login", "logout", "team", "org",
	"dist-tag", "stars", "star",
]);
const PM_SCRIPT = new Set(["test", "t", "tst", "start", "stop", "restart"]);

function packageManagerHandler(ctx: HandlerContext): Verdict {
	const { name, args } = ctx;
	const takesValue = ["--prefix", "-C", "--dir", "--filter", "-F", "--cwd", "-w", "--workspace", "--registry"];
	const index = args.firstPositionalIndex(takesValue);
	const subWord = index === -1 ? undefined : args.words[index];
	const sub = subWord?.value ?? "";
	const rest = index === -1 ? new Args([]) : args.from(index + 1);
	const global = args.has("-g", "--global", "--location=global") || sub === "global";
	const cwd = args.option("--prefix", "-C", "--dir", "--cwd");

	if (!subWord) {
		if (name === "yarn" || name === "bun")
			return v(Risk.medium, {
				key: `${name} install`,
				family: name,
				cwd,
				reasons: ["installs dependencies and may run install scripts"],
			});
		return v(Risk.safe, { family: name });
	}
	if (subWord.dynamic)
		return v(Risk.high, { key: name, reasons: ["subcommand depends on runtime expansion"], learnable: false });
	if (PM_SAFE.has(sub)) {
		if (sub === "version" && rest.positionals().length > 0) {
			return v(Risk.medium, {
				key: `${name} version`,
				family: name,
				reasons: ["bumps the version and may commit or tag"],
			});
		}
		if (sub === "audit" && rest.values.includes("fix"))
			return v(Risk.medium, { key: `${name} audit fix`, family: name, cwd });
		return v(Risk.safe, { key: `${name} ${sub}`, family: name });
	}
	if (sub === "config" || sub === "c" || sub === "get" || sub === "set") {
		const action = sub === "get" || sub === "set" ? sub : rest.values[0];
		if (action === "get" || action === "list" || action === "ls" || action === undefined)
			return v(Risk.safe, { key: `${name} config`, family: name });
		return v(Risk.medium, { key: `${name} config`, family: name, reasons: ["changes package manager config"] });
	}
	if (sub === "cache" || sub === "store") return v(Risk.low, { key: `${name} ${sub}`, family: name });
	if (PM_PUBLISH.has(sub))
		return v(Risk.high, { key: `${name} ${sub}`, family: name, reasons: ["publishes or changes registry state"] });
	if (PM_INSTALL.has(sub) || sub === "global") {
		if (global)
			return v(Risk.high, {
				key: `${name} ${sub} -g`,
				family: name,
				reasons: ["installs or removes packages globally"],
			});
		const ignoreScripts = args.has("--ignore-scripts") || rest.has("--ignore-scripts");
		return ignoreScripts
			? v(Risk.low, {
					key: `${name} ${sub}`,
					family: name,
					cwd,
					reasons: ["changes dependencies (scripts disabled)"],
				})
			: v(Risk.medium, {
					key: `${name} ${sub}`,
					family: name,
					cwd,
					reasons: ["changes dependencies and may run install scripts"],
				});
	}
	if (sub === "exec" || sub === "x" || sub === "dlx" || sub === "create" || sub === "init" || sub === "innit") {
		const pkg = rest.positionals(["-p", "--package", "-c", "--call"])[0];
		const key = pkg && !pkg.dynamic ? `${name} ${sub} ${pkg.value}` : `${name} ${sub}`;
		return v(Risk.medium, {
			key,
			family: `${name} ${sub}`,
			cwd,
			reasons: ["runs a package binary (may download it)"],
		});
	}
	let script: Word | undefined;
	if (sub === "run" || sub === "run-script" || sub === "rr") script = rest.positionals()[0];
	else if (PM_SCRIPT.has(sub)) script = synthetic(sub === "t" || sub === "tst" ? "test" : sub, false);
	else if (name !== "npm") script = subWord;
	if (script) {
		if (script.dynamic)
			return v(Risk.high, {
				key: `${name} run`,
				family: name,
				learnable: false,
				reasons: ["script name depends on runtime expansion"],
			});
		if (name === "bun" && /\.(m?[jt]sx?|c[jt]s)$/.test(script.value)) {
			return v(Risk.medium, {
				key: `bun ${script.value}`,
				family: "bun",
				reads: [script],
				reasons: ["runs a script file"],
			});
		}
		return v(Risk.medium, {
			key: `${name} run ${script.value}`,
			family: `${name} run`,
			cwd,
			reasons: ["runs a package.json script"],
		});
	}
	return v(Risk.medium, { key: `${name} ${sub}`, family: name, cwd });
}

function npxHandler({ name, args }: HandlerContext): Verdict {
	const index = args.firstPositionalIndex(["-p", "--package", "-c", "--call", "--node-options"]);
	if (args.has("-c", "--call"))
		return v(Risk.medium, { key: `${name} -c`, family: name, innerScript: args.option("-c", "--call") });
	if (index === -1) return v(Risk.low, { family: name });
	return v(Risk.low, { inner: args.words.slice(index), reasons: ["may download the package before running it"] });
}

function pythonPackageHandler({ name, args }: HandlerContext): Verdict {
	const sub = args.positionals()[0];
	const value = sub?.value ?? "";
	if (
		[
			"list",
			"show",
			"freeze",
			"check",
			"--version",
			"search",
			"inspect",
			"tree",
			"config",
			"info",
			"env",
			"help",
			"debug",
			"cache",
			"index",
		].includes(value)
	) {
		return v(value === "config" && args.has("set", "unset") ? Risk.medium : Risk.safe, {
			key: subKey(name, sub),
			family: name,
		});
	}
	if (value === "run" || value === "exec" || value === "shell") {
		const runArgs = args.from(args.values.indexOf(value) + 1);
		const index = runArgs.firstPositionalIndex([
			"--with",
			"--python",
			"-p",
			"--directory",
			"--project",
			"--extra",
			"--group",
			"--env-file",
		]);
		if (value === "shell" || index === -1) return v(Risk.medium, { key: `${name} ${value}`, family: name });
		return v(Risk.safe, { inner: runArgs.words.slice(index), reasons: [`via ${name} ${value}`] });
	}
	if (value === "publish" || value === "upload")
		return v(Risk.high, { key: `${name} ${value}`, family: name, reasons: ["publishes a package"] });
	const user = args.has("--user", "--system", "--break-system-packages", "--target", "-t", "--root", "--prefix");
	if (
		[
			"install",
			"uninstall",
			"add",
			"remove",
			"sync",
			"lock",
			"update",
			"upgrade",
			"download",
			"wheel",
			"venv",
			"init",
			"pip",
			"tool",
			"python",
		].includes(value)
	) {
		if (user)
			return v(Risk.high, {
				key: `${name} ${value}`,
				family: name,
				reasons: ["installs outside the project environment"],
			});
		return v(Risk.medium, { key: `${name} ${value}`, family: name, reasons: ["changes the Python environment"] });
	}
	return v(Risk.medium, { key: subKey(name, sub), family: name });
}

function cargoHandler({ args }: HandlerContext): Verdict {
	const sub = args.positionals([
		"--manifest-path",
		"-p",
		"--package",
		"-j",
		"--jobs",
		"--target",
		"--features",
		"-F",
		"--color",
		"-Z",
		"--config",
	])[0];
	const value = sub?.value ?? "";
	const key = subKey("cargo", sub);
	if (
		[
			"tree",
			"metadata",
			"locate-project",
			"search",
			"version",
			"pkgid",
			"verify-project",
			"read-manifest",
			"help",
			"--version",
			"-V",
			"--list",
		].includes(value)
	) {
		return v(Risk.safe, { key, family: "cargo" });
	}
	if (
		[
			"check",
			"clippy",
			"fmt",
			"doc",
			"c",
			"d",
			"build",
			"b",
			"test",
			"t",
			"bench",
			"run",
			"r",
			"nextest",
			"expand",
			"udeps",
			"machete",
			"clean",
			"update",
			"fetch",
			"generate-lockfile",
			"add",
			"rm",
			"remove",
			"new",
			"init",
			"fix",
			"vendor",
		].includes(value)
	) {
		const risk = ["fmt", "clean", "tree", "check", "clippy", "doc", "c", "d"].includes(value)
			? Risk.low
			: Risk.medium;
		return v(risk, {
			key,
			family: "cargo",
			reasons: risk === Risk.medium ? ["compiles and runs project code (build scripts, tests)"] : [],
		});
	}
	if (value === "install" || value === "uninstall")
		return v(Risk.medium, { key, family: "cargo", reasons: ["installs a binary for the user"] });
	if (value === "publish" || value === "yank" || value === "login" || value === "owner")
		return v(Risk.high, { key, family: "cargo", reasons: ["changes registry state"] });
	return v(Risk.medium, { key, family: "cargo" });
}

function goHandler({ args }: HandlerContext): Verdict {
	const sub = args.positionals()[0];
	const value = sub?.value ?? "";
	const key = subKey("go", sub);
	if (["version", "env", "list", "doc", "help"].includes(value) && !args.has("-w"))
		return v(Risk.safe, { key, family: "go" });
	if (value === "env" && args.has("-w", "-u"))
		return v(Risk.medium, { key: "go env -w", family: "go", reasons: ["changes the user's Go environment"] });
	if (["vet", "fmt", "mod"].includes(value)) return v(Risk.low, { key, family: "go" });
	if (value === "generate") return v(Risk.medium, { key, family: "go", reasons: ["runs //go:generate commands"] });
	return v(Risk.medium, { key, family: "go", reasons: ["compiles and runs project code"] });
}

function buildToolHandler({ name, args }: HandlerContext): Verdict {
	if (args.has("-n", "--dry-run", "--just-print", "--recon", "--list", "-l", "--summary", "--help"))
		return v(Risk.safe, { family: name });
	const targets = args.positionals([
		"-C",
		"--directory",
		"-f",
		"--file",
		"--makefile",
		"-j",
		"--jobs",
		"-l",
		"--load-average",
		"-o",
		"-W",
		"-I",
		"--justfile",
		"-d",
		"--working-directory",
		"--taskfile",
		"-t",
	]);
	const target = targets.find((t) => !t.value.includes("="));
	return v(Risk.medium, {
		key: target ? subKey(name, target) : `${name} (default)`,
		family: name,
		cwd: args.option("-C", "--directory", "-d", "--working-directory"),
		reasons: ["runs build recipes"],
	});
}

function dockerHandler({ name, args }: HandlerContext): Verdict {
	const sub = args.positionals(["-H", "--host", "--context", "-c", "--config", "-l", "--log-level"])[0];
	let value = sub?.value ?? "";
	let rest = args.from(args.values.indexOf(value) + 1);
	if (
		["container", "image", "volume", "network", "system", "builder", "buildx", "compose", "context"].includes(value)
	) {
		const second = rest.positionals()[0]?.value ?? "";
		value = `${value} ${second}`.trim();
		rest = rest.from(rest.values.indexOf(second) + 1);
	}
	const key = `${name} ${value}`.trim();
	const readOnly =
		/^(ps|images|logs|inspect|version|info|stats|top|history|port|diff|search|events|(container|image|volume|network|context) (ls|list|inspect)|system (df|info)|compose (ps|logs|config|ls|images|top|version)|buildx ls)$/;
	if (readOnly.test(value)) return v(Risk.safe, { key, family: name });
	if (/(prune|^system|^(volume|network|image|container) rm)/.test(value))
		return v(Risk.high, { key, family: name, reasons: ["deletes containers, images, volumes, or networks"] });
	if (/^(login|logout|push|trust|plugin|swarm|secret|node|service|stack)/.test(value))
		return v(Risk.high, { key, family: name, reasons: ["changes registry, credentials, or cluster state"] });
	if (/^(run|create|exec|compose (up|run|exec)|container (run|create|exec))/.test(value)) {
		const escapes = rest.has(
			"--privileged",
			"--pid=host",
			"--network=host",
			"--net=host",
			"--ipc=host",
			"--userns=host",
			"--cap-add",
			"--device",
			"--security-opt",
		);
		const mounts = rest.values.filter(
			(x, i) =>
				rest.values[i - 1] === "-v" ||
				rest.values[i - 1] === "--volume" ||
				rest.values[i - 1] === "--mount" ||
				x.startsWith("--volume=") ||
				x.startsWith("--mount="),
		);
		const hostMount = mounts.some((m) =>
			/(^|[=:,])\/(:|,|$)|docker\.sock|^\/(etc|root|home|Users|var)\b|^~/.test(m.replace(/^--(volume|mount)=/, "")),
		);
		if (escapes || hostMount)
			return v(Risk.high, { key, family: name, reasons: ["container gets host-level access"] });
		return v(Risk.medium, { key, family: name, reasons: ["runs a container"] });
	}
	if (/^(rm|rmi|kill|stop)/.test(value)) return v(Risk.medium, { key, family: name });
	return v(Risk.medium, { key, family: name });
}

function clusterHandler({ name, args }: HandlerContext): Verdict {
	const sub = args.positionals([
		"-n",
		"--namespace",
		"--context",
		"--kubeconfig",
		"-o",
		"--output",
		"-l",
		"--selector",
		"--cluster",
		"--project",
		"--region",
		"--profile",
	])[0];
	const value = sub?.value ?? "";
	const key = subKey(name, sub);
	const read =
		/^(get|describe|logs|top|explain|version|api-resources|api-versions|cluster-info|diff|status|list|ls|template|show|history|search|lint|plan|validate|fmt|output|providers|graph|whoami|preview|stack|config|auth|init|workspace)$/;
	if (read.test(value)) {
		if (
			(value === "config" && /set|use|delete|rename/.test(args.values.join(" "))) ||
			(value === "auth" && args.values.includes("login"))
		) {
			return v(Risk.medium, { key, family: name, reasons: ["changes credentials or context"] });
		}
		return v(Risk.low, { key, family: name, reasons: ["reads cloud or cluster state with your credentials"] });
	}
	return v(Risk.high, { key, family: name, reasons: ["changes cloud or cluster state"] });
}

function cloudCliHandler({ name, args }: HandlerContext): Verdict {
	const words = args.positionals([
		"--profile",
		"--region",
		"--project",
		"--output",
		"-o",
		"--query",
		"--format",
		"--subscription",
	]);
	const verb = words
		.map((w) => w.value)
		.find(
			(x) =>
				/^(describe|list|get|show|ls|wait|help|version|whoami|account|info)/.test(x) ||
				/^(create|delete|update|put|set|remove|rm|deploy|start|stop|terminate|run|invoke|cp|mv|sync|attach|detach|modify|reboot|apply|destroy|add|import|enable|disable)/.test(
					x,
				),
		);
	const key =
		words.length > 0
			? `${name} ${words
					.slice(0, 2)
					.map((w) => w.value)
					.join(" ")}`
			: name;
	if (verb && /^(describe|list|get|show|ls|wait|help|version|whoami|account|info)/.test(verb)) {
		return v(Risk.medium, { key, family: name, reasons: ["reads cloud state with your credentials"] });
	}
	return v(Risk.high, { key, family: name, reasons: ["may change cloud resources or credentials"] });
}

function ghHandler({ args }: HandlerContext): Verdict {
	const pos = args.positionals([
		"-R",
		"--repo",
		"-X",
		"--method",
		"-H",
		"--header",
		"-f",
		"-F",
		"--field",
		"--raw-field",
		"--jq",
		"-q",
		"--template",
		"-t",
		"-L",
		"--limit",
		"-s",
		"--state",
		"-l",
		"--label",
		"-a",
		"--assignee",
		"-b",
		"--body",
		"-B",
		"--base",
		"--head",
		"-w",
		"--web",
	]);
	const group = pos[0]?.value ?? "";
	const action = pos[1]?.value ?? "";
	const key = pos.length >= 2 ? `gh ${group} ${action}` : subKey("gh", pos[0]);
	if (group === "api") {
		const method = args.option("-X", "--method")?.value.toUpperCase();
		const writes =
			(method !== undefined && method !== "GET") || args.has("-f", "-F", "--field", "--raw-field", "--input");
		if (writes)
			return v(Risk.high, {
				key: "gh api (write)",
				family: "gh api",
				reasons: ["sends a write request to the GitHub API"],
			});
		return v(Risk.low, { key: "gh api", family: "gh", reasons: ["reads from the GitHub API"] });
	}
	if (
		/^(view|list|status|diff|checks|watch|ls|show)$/.test(action) ||
		["status", "search", "browse", "help", "version", "--version"].includes(group)
	) {
		return v(Risk.low, { key, family: "gh", reasons: ["reads from GitHub"] });
	}
	if (group === "auth" && action === "status") return v(Risk.low, { key, family: "gh" });
	if (group === "auth" && action === "token")
		return v(Risk.high, { key, family: "gh", reasons: ["prints your GitHub token"] });
	if (
		/^(delete|archive|transfer|rename|edit-visibility)$/.test(action) ||
		["auth", "secret", "ssh-key", "gpg-key", "extension", "alias", "config"].includes(group)
	) {
		return v(Risk.high, {
			key,
			family: "gh",
			reasons: ["changes credentials, settings, or deletes GitHub resources"],
		});
	}
	if (group === "pr" && action === "checkout")
		return v(Risk.medium, { key, family: "gh", reasons: ["checks out remote code"] });
	if (group === "repo" && action === "clone") return v(Risk.medium, { key, family: "gh" });
	return v(Risk.medium, { key, family: "gh", reasons: ["changes GitHub state (comments, PRs, issues, runs)"] });
}

function downloaderHandler({ name, args }: HandlerContext): Verdict {
	const valueOpts = [
		"-o",
		"--output",
		"-O",
		"-d",
		"--data",
		"--data-raw",
		"--data-binary",
		"--data-urlencode",
		"-F",
		"--form",
		"-H",
		"--header",
		"-X",
		"--request",
		"-u",
		"--user",
		"-T",
		"--upload-file",
		"-K",
		"--config",
		"-A",
		"--user-agent",
		"-e",
		"--referer",
		"-b",
		"--cookie",
		"-c",
		"--cookie-jar",
		"--output-document",
		"-P",
		"--directory-prefix",
		"--post-data",
		"--post-file",
		"--body-data",
		"--body-file",
		"--method",
		"--json",
		"-w",
		"--write-out",
		"--connect-timeout",
		"-m",
		"--max-time",
		"--retry",
		"-x",
		"--proxy",
	];
	const urls = args.positionals(valueOpts);
	const url = urls.find((u) => /^(https?|ftp):\/\//i.test(u.value) || /^[\w.-]+\.[a-z]{2,}(\/|$|:)/i.test(u.value));
	let host = "";
	if (url && !url.dynamic) {
		try {
			host = new URL(/^\w+:\/\//.test(url.value) ? url.value : `https://${url.value}`).hostname;
		} catch {
			host = "";
		}
	}
	const key = host ? `${name} ${host}` : name;
	const reasons: string[] = [];
	let risk: Risk = Risk.low;
	reasons.push(host ? `network request to ${host}` : "network request");
	const method = args.option("-X", "--request", "--method")?.value.toUpperCase();
	const uploads =
		args.has(
			"-d",
			"--data",
			"--data-raw",
			"--data-binary",
			"--data-urlencode",
			"-F",
			"--form",
			"-T",
			"--upload-file",
			"--json",
			"--post-data",
			"--post-file",
			"--body-data",
			"--body-file",
		) ||
		(method !== undefined && method !== "GET" && method !== "HEAD");
	if (uploads) {
		risk = Risk.medium;
		reasons.push("sends data (possible exfiltration)");
	}
	if (args.has("-K", "--config", "-x", "--proxy")) risk = maxRisk(risk, Risk.medium);
	if (url?.dynamic) {
		risk = maxRisk(risk, Risk.medium);
		reasons.push("URL depends on runtime expansion");
	}
	const writes: Word[] = [];
	const reads: Word[] = [];
	const output = args.option("-o", "--output", "--output-document", ...(name === "wget" ? ["-O"] : []));
	if (output && output.value !== "-") writes.push(output);
	if (name === "curl" && args.has("-O", "--remote-name", "--remote-name-all")) writes.push(synthetic(".", false));
	if (name === "wget" && !output) writes.push(args.option("-P", "--directory-prefix") ?? synthetic(".", false));
	for (const opt of ["-T", "--upload-file", "--post-file", "--body-file"]) {
		const file = args.option(opt);
		if (file) reads.push(file);
	}
	for (const opt of ["-d", "--data", "--data-binary", "--data-urlencode", "-F", "--form", "--json"]) {
		const data = args.option(opt);
		if (data?.value.startsWith("@")) reads.push(derivedWord(data, data.value.slice(1)));
		const formFile = data?.value.match(/=@([^;]+)/);
		if (formFile && data) reads.push(derivedWord(data, formFile[1]));
	}
	return v(risk, { key, family: name, reasons, writes, reads });
}

function interpreterHandler(ctx: HandlerContext): Verdict {
	const { name, args, pipedFrom } = ctx;
	const family = name.replace(/\d+(\.\d+)*$/, "") || name;
	if (args.words.length === 0 || args.values[0] === "-" || (args.has("-s") && SHELLS.includes(name))) {
		if (pipedFrom) {
			const fromDownload = DOWNLOADERS.includes(pipedFrom);
			return v(fromDownload ? Risk.critical : Risk.high, {
				key: `${name} (stdin)`,
				family,
				learnable: !fromDownload,
				reasons: [
					fromDownload ? `executes code downloaded by ${pipedFrom}` : `executes code piped from ${pipedFrom}`,
				],
			});
		}
		return v(Risk.low, { key: `${name} (interactive)`, family });
	}
	if (SHELLS.includes(name)) {
		const inline = args.option("-c");
		if (inline || args.has("-c")) {
			if (!inline || inline.dynamic)
				return v(Risk.high, {
					key: `${name} -c`,
					family,
					learnable: false,
					reasons: ["runs a shell string that depends on runtime expansion"],
				});
			return v(Risk.safe, { innerScript: inline, reasons: [`via ${name} -c`] });
		}
		if (args.has("-n")) return v(Risk.safe, { key: `${name} -n`, family });
	} else {
		if (family === "python" || family === "pypy") {
			const module = args.option("-m");
			if (module) {
				const index = args.values.findIndex((x) => x === "-m" || x.startsWith("-m"));
				const moduleArgs = args.values[index] === "-m" ? args.words.slice(index + 2) : args.words.slice(index + 1);
				if (module.dynamic) return v(Risk.high, { key: `${name} -m`, family, learnable: false });
				const known = HANDLERS.get(module.value);
				if (known && !["http.server", "pydoc"].includes(module.value))
					return v(Risk.safe, { inner: [module, ...moduleArgs], reasons: [`via ${name} -m`] });
				return v(Risk.medium, { key: `${name} -m ${module.value}`, family, reasons: ["runs a Python module"] });
			}
		}
		const inlineFlag = ["-c", "-e", "-E", "--eval", "-p", "--print", "-r", "-x"].find(
			(f) =>
				args.values.includes(f) ||
				(f.length === 2 && args.values.some((x) => /^-[a-zA-Z]+$/.test(x) && x.endsWith(f[1]))),
		);
		if (inlineFlag && !(family === "perl" && args.has("-i"))) {
			return v(Risk.medium, { key: `${name} ${inlineFlag}`, family, reasons: ["runs inline code"] });
		}
		if (family === "perl" && args.has("-i")) {
			return v(Risk.medium, {
				key: `${name} -i`,
				family,
				writes: args.positionals(["-e", "-E", "-I", "-M"]).slice(1),
				reasons: ["edits files in place with inline code"],
			});
		}
		if (family === "deno") {
			const sub = args.positionals()[0];
			if (sub && ["fmt", "lint", "check", "info", "doc", "types", "completions"].includes(sub.value))
				return v(Risk.low, { key: subKey("deno", sub), family });
		}
	}
	const valueOpts =
		family === "node"
			? ["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--env-file"]
			: ["-W", "-X", "-Q", "-I", "-M"];
	const script = args.positionals(valueOpts)[0];
	if (!script) return v(Risk.low, { key: name, family });
	if (script.dynamic)
		return v(Risk.high, {
			key: `${name} (dynamic script)`,
			family,
			learnable: false,
			reasons: ["script path depends on runtime expansion"],
		});
	return v(Risk.medium, { key: `${name} ${script.value}`, family, reads: [script], reasons: ["runs a script"] });
}

function sourceHandler({ name, args }: HandlerContext): Verdict {
	const file = args.positionals()[0];
	if (!file || file.dynamic)
		return v(Risk.high, { key: name, learnable: false, reasons: ["sources a file chosen at runtime"] });
	if (/(^|\/)(bin|Scripts)\/activate(\.\w+)?$/.test(file.value)) {
		return v(Risk.low, {
			key: `source ${file.value}`,
			family: "source",
			reasons: ["activates a virtual environment"],
		});
	}
	return v(Risk.medium, {
		key: `source ${file.value}`,
		family: "source",
		reads: [file],
		reasons: ["runs a script in the current shell"],
	});
}

function deleteHandler({ name, args }: HandlerContext): Verdict {
	const targets = args.positionals(["--exclude", "-I"]);
	const recursive = args.has("-r", "-R", "--recursive");
	if (recursive && targets.some((t) => !t.dynamic && /^(\.\/)?(\*|\.\*|\.\[!.\]\*)$/.test(t.value))) {
		return v(Risk.critical, {
			key: name,
			family: name,
			deletes: targets,
			learnable: false,
			reasons: ["recursively deletes everything in the current directory"],
		});
	}
	return v(recursive ? Risk.medium : Risk.low, {
		key: name,
		family: name,
		deletes: targets.length > 0 ? targets : [],
		reasons: recursive ? ["deletes recursively"] : [],
	});
}

function copyMoveHandler({ name, args }: HandlerContext): Verdict {
	const pos = args.positionals(["-t", "--target-directory", "-S", "--suffix", "--backup"]);
	const target = args.option("-t", "--target-directory");
	const destination = target ?? pos[pos.length - 1];
	const sources = target ? pos : pos.slice(0, -1);
	if (name === "mv") return v(Risk.low, { key: name, writes: destination ? [destination] : [], deletes: sources });
	return v(Risk.low, { key: name, writes: destination ? [destination] : [], reads: sources });
}

function writePositionals(risk: Risk, takesValue: string[] = []): Handler {
	return ({ name, args }) => v(risk, { key: name, writes: args.positionals(takesValue) });
}

function chmodHandler({ name, args }: HandlerContext): Verdict {
	const pos = args.positionals(["--reference"]);
	const mode = name === "chmod" ? (pos[0]?.value ?? "") : "";
	const files = name === "chmod" ? pos.slice(1) : pos.slice(1);
	const reasons: string[] = [];
	let risk: Risk = name === "chmod" ? Risk.low : Risk.medium;
	if (
		name === "chmod" &&
		(/[0-7]?[0-7][0-7][2367]$/.test(mode) || /(^|,)[oa]*[+=][rwxXst]*w/.test(mode) || /^[+=]w/.test(mode))
	) {
		risk = Risk.high;
		reasons.push("makes files world-writable");
	}
	if (name === "chmod" && (/^[4267][0-7]{3}$/.test(mode) || /[+=][^,]*s/.test(mode))) {
		risk = Risk.high;
		reasons.push("sets setuid/setgid");
	}
	if (args.has("-R", "--recursive")) reasons.push("recursive");
	return v(risk, { key: name, writes: files, reasons });
}

function findHandler({ args }: HandlerContext): Verdict {
	// find [-H|-L|-P|-Olevel|-D opts] [roots...] [expression]
	let i = 0;
	while (i < args.values.length && /^-([HLP]|O\d*|D)$/.test(args.values[i])) i += args.values[i] === "-D" ? 2 : 1;
	const roots: Word[] = [];
	for (; i < args.words.length; i++) {
		const value = args.values[i];
		if (value.startsWith("-") || value === "(" || value === "!" || value === "\\(") break;
		roots.push(args.words[i]);
	}
	const values = args.values;
	for (let i = 0; i < values.length; i++) {
		if (["-exec", "-execdir", "-ok", "-okdir"].includes(values[i])) {
			let end = i + 1;
			while (end < values.length && values[end] !== ";" && values[end] !== "+") end++;
			const matchWords = (roots.length > 0 ? roots : [synthetic(".", false)]).map((r) => ({
				...derivedWord(r, `${r.value.replace(/\/$/, "")}/*`),
				glob: true,
			}));
			const inner = args.words.slice(i + 1, end).flatMap((w) => (w.value === "{}" ? matchWords : [w]));
			return v(Risk.safe, { key: "find -exec", family: "find", inner, reasons: ["runs a command for each match"] });
		}
	}
	if (values.includes("-delete")) {
		const matchWords = (roots.length > 0 ? roots : [synthetic(".", false)]).map((r) => ({
			...derivedWord(r, `${r.value.replace(/\/$/, "")}/*`),
			glob: true,
		}));
		return v(Risk.medium, {
			key: "find -delete",
			family: "find",
			deletes: matchWords,
			reasons: ["deletes every match"],
		});
	}
	const outFile = args.option("-fprint", "-fprint0", "-fprintf", "-fls");
	return v(Risk.safe, { key: "find", family: "find", writes: outFile ? [outFile] : [] });
}

function wrapperHandler(
	skipValueOpts: string[],
	extra: { minRisk?: Risk; stdinArgs?: boolean; skipPositionals?: number } = {},
): Handler {
	return ({ name, args }) => {
		let index = 0;
		let skipped = 0;
		for (; index < args.words.length; index++) {
			const value = args.values[index];
			if (value === "--") {
				index++;
				break;
			}
			if (value.startsWith("-") && value.length > 1) {
				if (skipValueOpts.includes(value)) index++;
				continue;
			}
			if (skipped < (extra.skipPositionals ?? 0)) {
				skipped++;
				continue;
			}
			break;
		}
		const inner = args.words.slice(index);
		if (inner.length === 0) return v(Risk.safe, { key: name, family: name });
		return v(extra.minRisk ?? Risk.safe, { inner, innerStdinArgs: extra.stdinArgs, reasons: [`via ${name}`] });
	};
}

function envHandler({ args }: HandlerContext): Verdict {
	const reasons: string[] = [];
	let risk: Risk = Risk.safe;
	let index = 0;
	for (; index < args.words.length; index++) {
		const value = args.values[index];
		if (
			value === "-u" ||
			value === "--unset" ||
			value === "-C" ||
			value === "--chdir" ||
			value === "-S" ||
			value === "--split-string"
		) {
			if (value === "-S" || value === "--split-string") {
				return v(Risk.safe, { innerScript: args.words[index + 1], reasons: ["via env -S"] });
			}
			index++;
			continue;
		}
		if (value.startsWith("-")) continue;
		const assignment = value.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
		if (assignment) {
			if (isDangerousEnvName(assignment[1])) {
				risk = Risk.high;
				reasons.push(`overrides ${assignment[1]}`);
			}
			continue;
		}
		break;
	}
	const inner = args.words.slice(index);
	if (inner.length === 0) return v(Risk.safe, { key: "env", family: "env" });
	return v(risk, { inner, reasons: ["via env", ...reasons] });
}

function sudoHandler({ name, args }: HandlerContext): Verdict {
	const inner = wrapperHandler([
		"-u",
		"--user",
		"-g",
		"--group",
		"-p",
		"--prompt",
		"-C",
		"-h",
		"--host",
		"-r",
		"-t",
		"-D",
		"--chdir",
		"-U",
	])({ name, args, pipedFrom: undefined });
	return {
		...inner,
		risk: Risk.critical,
		learnable: false,
		key: name,
		reasons: [`runs with elevated privileges (${name})`],
	};
}

function sedHandler({ args }: HandlerContext): Verdict {
	const inPlace = args.values.some(
		(x) =>
			x === "-i" ||
			x.startsWith("-i") ||
			x.startsWith("--in-place") ||
			(/^-[a-zA-Z]+$/.test(x) && x.includes("i") && !x.startsWith("--")),
	);
	const scriptGiven = args.has("-e", "--expression", "-f", "--file");
	const pos = args.positionals(["-e", "--expression", "-f", "--file", "-l", "--line-length"]);
	const script = scriptGiven
		? args.values.filter((_, i) => ["-e", "--expression"].includes(args.values[i - 1] ?? "")).join("\n")
		: (pos[0]?.value ?? "");
	const files = scriptGiven ? pos : pos.slice(1);
	const executes = /(^|[;\n}{]\s*|\d\s*|\/\s*)e(\s|$|;)|\/[gpIiMm0-9]*e[gpIiMm0-9]*($|[;\s}])/.test(script);
	const writesFile = /(^|[;\n}{]\s*|\/[gpIiMm0-9]*)\s*[wW]\s+\S/.test(script);
	const reasons: string[] = [];
	let risk: Risk = Risk.safe;
	if (executes) {
		risk = Risk.high;
		reasons.push("sed script executes shell commands");
	}
	if (writesFile) {
		risk = maxRisk(risk, Risk.medium);
		reasons.push("sed script writes files");
	}
	if (args.has("-f", "--file")) {
		risk = maxRisk(risk, Risk.low);
		reasons.push("sed script read from a file");
	}
	return inPlace
		? v(maxRisk(risk, Risk.low), { key: "sed -i", family: "sed", writes: files, reasons })
		: v(risk, { key: "sed", family: "sed", reads: files, reasons });
}

function awkHandler({ name, args }: HandlerContext): Verdict {
	const pos = args.positionals(["-f", "-v", "-F", "-i", "--include", "-l", "--load"]);
	const script = args.has("-f") ? "" : (pos[0]?.value ?? "");
	const inPlace = args.values.some((x, i) => (x === "-i" && args.values[i + 1] === "inplace") || x === "-iinplace");
	if (args.has("-f"))
		return v(Risk.medium, { key: `${name} -f`, family: name, reasons: ["awk program read from a file"] });
	if (/system\s*\(|\|\s*(getline|")|print[f]?[^;]*\s>{1,2}\s*["\w$(]|[^<>=!]\|[^|]/.test(script)) {
		return v(Risk.medium, { key: name, family: name, reasons: ["awk program runs commands or writes files"] });
	}
	return inPlace
		? v(Risk.low, { key: `${name} -i inplace`, family: name, writes: pos.slice(1) })
		: v(Risk.safe, { key: name, family: name });
}

function teeHandler({ args }: HandlerContext): Verdict {
	return v(Risk.low, { key: "tee", writes: args.positionals() });
}

function sortHandler({ args }: HandlerContext): Verdict {
	const output = args.option("-o", "--output");
	return v(output ? Risk.low : Risk.safe, { key: "sort", writes: output ? [output] : [] });
}

function uniqHandler({ args }: HandlerContext): Verdict {
	const pos = args.positionals(["-f", "-s", "-w", "--skip-fields", "--skip-chars", "--check-chars"]);
	return pos.length >= 2 ? v(Risk.low, { key: "uniq", writes: [pos[1]] }) : v(Risk.safe, { key: "uniq" });
}

function ddHandler({ args }: HandlerContext): Verdict {
	const out = args.values.find((x) => x.startsWith("of="));
	const input = args.values.find((x) => x.startsWith("if="));
	const writes = out ? [synthetic(out.slice(3), /[$`]/.test(out))] : [];
	const reads = input ? [synthetic(input.slice(3), /[$`]/.test(input))] : [];
	if (out && /^\/dev\/(sd|nvme|disk|hd|mmcblk|rdisk|xvd|vd)/.test(out.slice(3))) {
		return v(Risk.critical, { key: "dd", learnable: false, reasons: ["writes directly to a disk device"] });
	}
	return v(Risk.medium, { key: "dd", writes, reads });
}

function archiveHandler({ name, args }: HandlerContext): Verdict {
	const first = args.values[0] ?? "";
	const cluster = first.startsWith("-") ? first.slice(1) : first;
	const extract =
		args.has("-x", "--extract", "--get") ||
		(name === "tar" && /^[a-zA-Z]*x/.test(cluster) && !first.startsWith("--"));
	const create =
		args.has("-c", "--create", "-r", "--append", "-u", "--update") ||
		(name === "tar" && /^[a-zA-Z]*[cru]/.test(cluster) && !first.startsWith("--"));
	const dir = args.option("-C", "--directory", "-d");
	const file =
		args.option("-f", "--file") ??
		(name === "tar" && /f/.test(cluster) && !first.startsWith("-") ? args.words[1] : undefined);
	if (name === "unzip" || name === "7z" || name === "unrar") {
		if (args.has("-l", "-t", "-v") || args.values[0] === "l" || args.values[0] === "t")
			return v(Risk.safe, { key: name });
		return v(Risk.low, { key: name, writes: [dir ?? synthetic(".", false)], reasons: ["extracts files"] });
	}
	if (extract)
		return v(Risk.low, {
			key: `${name} extract`,
			family: name,
			writes: [dir ?? synthetic(".", false)],
			reasons: ["extracts files"],
		});
	if (create) return v(Risk.low, { key: `${name} create`, family: name, writes: file ? [file] : [] });
	return v(Risk.safe, { key: name });
}

function compressHandler({ name, args }: HandlerContext): Verdict {
	if (args.has("-c", "--stdout", "-l", "--list", "-t", "--test")) return v(Risk.safe, { key: name });
	return v(Risk.low, { key: name, writes: args.positionals(["-S", "--suffix", "-o"]) });
}

function rgHandler({ name, args }: HandlerContext): Verdict {
	if (args.has("--pre"))
		return v(Risk.medium, {
			key: `${name} --pre`,
			family: name,
			reasons: ["runs a preprocessor command for each file"],
		});
	return v(Risk.safe, { key: name });
}

function fdHandler({ name, args }: HandlerContext): Verdict {
	const index = args.values.findIndex((x) => ["-x", "--exec", "-X", "--exec-batch"].includes(x));
	if (index !== -1) {
		return v(Risk.safe, {
			key: `${name} --exec`,
			family: name,
			inner: args.words.slice(index + 1),
			innerStdinArgs: true,
			reasons: ["runs a command for each match"],
		});
	}
	return v(Risk.safe, { key: name });
}

function xargsHandler(ctx: HandlerContext): Verdict {
	return wrapperHandler(
		[
			"-n",
			"--max-args",
			"-I",
			"-i",
			"-L",
			"-l",
			"--max-lines",
			"-P",
			"--max-procs",
			"-d",
			"--delimiter",
			"-E",
			"-e",
			"--eof",
			"-s",
			"--max-chars",
			"-a",
			"--arg-file",
		],
		{ stdinArgs: true },
	)(ctx);
}

function killHandler({ name, args }: HandlerContext): Verdict {
	if (name === "kill" && (args.values[0] === "-0" || args.has("-l", "-L"))) return v(Risk.safe, { key: name });
	return v(Risk.medium, { key: name, reasons: ["terminates processes"] });
}

function serviceHandler({ name, args }: HandlerContext): Verdict {
	const action = args.positionals()[0]?.value ?? "";
	if (/^(status|show|list.*|is-.*|cat|print|blame|help|-l)$/.test(action) || (name === "crontab" && args.has("-l")))
		return v(Risk.safe, { key: subKey(name, args.positionals()[0]) });
	return v(Risk.high, {
		key: subKey(name, args.positionals()[0]),
		family: name,
		reasons: ["changes system services or scheduled jobs"],
	});
}

function exportHandler({ args }: HandlerContext): Verdict {
	const dangerous = args
		.positionals()
		.map((w) => w.value.split("=")[0])
		.filter(isDangerousEnvName);
	if (dangerous.length > 0)
		return v(Risk.medium, { key: "export", reasons: [`changes ${dangerous.join(", ")} for later commands`] });
	return v(Risk.safe, { key: "export" });
}

function evalHandler({ args }: HandlerContext): Verdict {
	if (args.words.some((w) => w.dynamic))
		return v(Risk.high, {
			key: "eval",
			learnable: false,
			reasons: ["evaluates a string that depends on runtime expansion"],
		});
	return v(Risk.safe, { innerScript: synthetic(args.values.join(" "), false), reasons: ["via eval"] });
}

function trapHandler({ args }: HandlerContext): Verdict {
	const action = args.positionals()[0];
	if (!action || args.has("-l", "-p")) return v(Risk.safe, { key: "trap" });
	if (action.dynamic) return v(Risk.high, { key: "trap", learnable: false });
	return v(Risk.safe, { innerScript: action, reasons: ["via trap"] });
}

function commandBuiltinHandler(ctx: HandlerContext): Verdict {
	if (ctx.args.has("-v", "-V")) return v(Risk.safe, { key: `${ctx.name} -v` });
	return wrapperHandler([])(ctx);
}

function rsyncHandler(ctx: HandlerContext): Verdict {
	const pos = ctx.args.positionals([
		"-e",
		"--rsh",
		"--exclude",
		"--include",
		"--filter",
		"-f",
		"--files-from",
		"--rsync-path",
	]);
	if (ctx.args.has("-e", "--rsh", "--rsync-path") || pos.some((p) => /^[^/]*:/.test(p.value))) {
		return v(Risk.high, {
			key: "rsync (remote)",
			family: "rsync",
			reasons: ["transfers files to or from another host"],
		});
	}
	const deletes = ctx.args.has(
		"--delete",
		"--delete-before",
		"--delete-after",
		"--delete-during",
		"--remove-source-files",
	);
	const dest = pos[pos.length - 1];
	return v(deletes ? Risk.medium : Risk.low, {
		key: "rsync",
		writes: dest ? [dest] : [],
		deletes: deletes && dest ? [dest] : [],
	});
}

function openHandler({ name }: HandlerContext): Verdict {
	return v(Risk.medium, { key: name, reasons: ["opens a file or URL in another application"] });
}

function editorHandler({ name, args }: HandlerContext): Verdict {
	return v(Risk.medium, { key: name, writes: args.positionals(), reasons: ["opens an interactive editor"] });
}

const HANDLERS = new Map<string, Handler>();

function register(names: string[], handler: Handler): void {
	for (const name of names) HANDLERS.set(name, handler);
}

register(SAFE_PROGRAMS, ({ name }) => v(Risk.safe, { key: name }));
register(TOOLING_PROGRAMS, ({ name }) => v(Risk.low, { key: name, reasons: ["runs project tooling"] }));
register(CRITICAL_PROGRAMS, ({ name }) =>
	v(Risk.critical, { key: name, learnable: false, reasons: [`${name} can damage the system`] }),
);
register(["sudo", "doas", "run0", "runas", "gsudo"], sudoHandler);
register(["git"], gitHandler);
register(["npm", "pnpm", "yarn", "bun"], packageManagerHandler);
register(["npx", "bunx", "pnpx"], npxHandler);
register(
	["pip", "pip3", "uv", "poetry", "pipenv", "pipx", "conda", "mamba", "pdm", "hatch", "rye"],
	pythonPackageHandler,
);
register(["cargo"], cargoHandler);
register(["go"], goHandler);
register(["make", "gmake", "just", "task", "rake", "ninja", "mage"], buildToolHandler);
register(
	[
		"gradle",
		"gradlew",
		"./gradlew",
		"mvn",
		"./mvnw",
		"mvnw",
		"bazel",
		"bazelisk",
		"sbt",
		"cmake",
		"meson",
		"dotnet",
		"swift",
		"zig",
		"mix",
		"lein",
		"stack",
		"cabal",
		"flutter",
		"dart",
		"composer",
		"bundle",
		"gem",
	],
	({ name, args }) =>
		v(Risk.medium, {
			key: subKey(name, args.positionals()[0]),
			family: name,
			reasons: ["runs a build or package tool"],
		}),
);
register(["docker", "podman", "nerdctl"], dockerHandler);
register(
	["kubectl", "oc", "helm", "terraform", "tofu", "pulumi", "k9s", "kustomize", "flux", "argocd"],
	clusterHandler,
);
register(
	[
		"aws",
		"gcloud",
		"az",
		"gsutil",
		"bq",
		"doctl",
		"flyctl",
		"fly",
		"heroku",
		"vercel",
		"netlify",
		"wrangler",
		"firebase",
		"supabase",
	],
	cloudCliHandler,
);
register(["gh"], ghHandler);
register(DOWNLOADERS, downloaderHandler);
register(NETWORK_SHELLS, ({ name }) =>
	v(Risk.high, { key: name, reasons: ["opens a network connection to another host"] }),
);
register(["rsync"], rsyncHandler);
register([...INTERPRETERS, ...SHELLS], interpreterHandler);
register(["source", "."], sourceHandler);
register(["rm", "rmdir", "unlink", "shred", "trash", "trash-put", "srm"], deleteHandler);
register(["cp", "mv", "install", "ln"], copyMoveHandler);
register(
	["mkdir", "touch", "truncate"],
	writePositionals(Risk.low, ["-m", "--mode", "-s", "--size", "-r", "--reference", "-d", "--date", "-t"]),
);
register(["chmod", "chown", "chgrp", "chattr", "setfacl"], chmodHandler);
register(["find"], findHandler);
register(["fd", "fdfind"], fdHandler);
register(["rg"], rgHandler);
register(["xargs", "parallel"], xargsHandler);
register(["env"], envHandler);
register(
	[
		"nice",
		"nohup",
		"time",
		"stdbuf",
		"ionice",
		"caffeinate",
		"unbuffer",
		"chronic",
		"exec",
		"builtin",
		"setsid",
		"dotenv",
		"with-contenv",
		"nvm-exec",
		"fnm",
		"direnv",
		"asdf",
		"mise",
	],
	wrapperHandler(["-n", "--adjustment", "-c", "-p", "-i", "-o", "-e", "--class", "--classdata", "-a", "-f"]),
);
register(["timeout", "gtimeout"], wrapperHandler(["-s", "--signal", "-k", "--kill-after"], { skipPositionals: 1 }));
register(["watch"], wrapperHandler(["-n", "--interval", "-d", "--differences"]));
register(["flock"], wrapperHandler(["-w", "--timeout", "-E", "--conflict-exit-code"], { skipPositionals: 1 }));
register(["taskset", "chrt"], wrapperHandler([], { skipPositionals: 1 }));
register(
	["c8", "nyc", "dotenvx", "cross-env", "concurrently", "nodemon", "ts-node-dev", "tsx-watch", "entr"],
	wrapperHandler(["-r", "--reporter", "--include", "--exclude"], { minRisk: Risk.low }),
);
register(["command"], commandBuiltinHandler);
register(["sed", "gsed"], sedHandler);
register(["awk", "gawk", "mawk", "nawk"], awkHandler);
register(["tee"], teeHandler);
register(["sort"], sortHandler);
register(["uniq"], uniqHandler);
register(["dd"], ddHandler);
register(["tar", "gtar", "bsdtar", "unzip", "zip", "7z", "unrar"], archiveHandler);
register(["gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "zstd", "unzstd", "lz4", "brotli"], compressHandler);
register(["kill", "pkill", "killall"], killHandler);
register(["systemctl", "service", "launchctl", "crontab", "at", "schtasks", "sc"], serviceHandler);
register(["export"], exportHandler);
register(["eval"], evalHandler);
register(["trap"], trapHandler);
register(["alias", "unalias", "bind", "complete", "enable"], ({ name }) => v(Risk.low, { key: name }));
register(["open", "xdg-open", "start", "explorer", "wslview"], openHandler);
register(["vi", "vim", "nvim", "nano", "emacs", "code", "subl", "ed", "ex", "pico", "micro", "hx"], editorHandler);
register(["patch"], ({ args }) =>
	v(Risk.medium, {
		key: "patch",
		writes: [args.option("-d", "--directory") ?? synthetic(".", false)],
		reasons: ["applies a patch to files"],
	}),
);
register(["split", "csplit"], ({ name }) => v(Risk.low, { key: name, writes: [synthetic(".", false)] }));
register(
	[
		"mount",
		"umount",
		"iptables",
		"ip6tables",
		"nft",
		"ufw",
		"pfctl",
		"sysctl",
		"scutil",
		"networksetup",
		"route",
		"ifconfig",
		"ip",
		"defaults",
		"reg",
		"regedit",
		"setx",
		"diskutil",
		"hdiutil",
		"csrutil",
		"spctl",
		"tccutil",
		"security",
		"launchd",
	],
	({ name, args }) => {
		const readOnly =
			args.words.length === 0 ||
			/^(show|list|print|-l|-L|read|info|status|addr|link|route|-a|find-.*|dump-trust-settings)$/.test(
				args.values[0] ?? "",
			);
		return readOnly
			? v(Risk.low, { key: name })
			: v(Risk.high, {
					key: subKey(name, args.positionals()[0]),
					family: name,
					reasons: ["changes system configuration"],
				});
	},
);

const VERSION_ARGS = new Set(["--version", "-v", "-V", "--help", "-h", "-help", "version", "help", "-version"]);

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

interface WalkState {
	/** Tracked working directory, or undefined after a `cd` we could not resolve. */
	cwd: string | undefined;
}

interface Walker {
	env: PathEnv;
	issues: string[];
	out: CommandAnalysis[];
	depth: number;
}

const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>"]);

export function analyzeBash(command: string, env: PathEnv, cwd: string = env.root): BashAnalysis {
	const walker: Walker = { env, issues: [], out: [], depth: 0 };
	const { script, issues } = parseShell(command);
	walker.issues.push(...issues);
	walkScript(script, walker, { cwd });
	let risk: Risk = Risk.safe;
	for (const c of walker.out) risk = maxRisk(risk, c.risk);
	if (walker.issues.length > 0) risk = maxRisk(risk, Risk.medium);
	return { commands: walker.out, issues: [...new Set(walker.issues)], risk };
}

function walkScript(script: Script, walker: Walker, state: WalkState): void {
	for (const node of script.nodes) {
		if (node.kind === "subshell") {
			walkScript(node.script, walker, { cwd: state.cwd });
			if (node.redirects.length > 0) {
				const analysis = blankAnalysis("(subshell)", "(subshell redirect)");
				applyRedirects(analysis, node.redirects, walker, state.cwd);
				walker.out.push(finalize(analysis));
			}
			continue;
		}
		walkCommand(node.command, walker, state);
	}
}

function walkSubstitutions(words: Word[], walker: Walker, cwd: string | undefined): void {
	for (const word of words) for (const sub of word.substitutions) walkScript(sub, walker, { cwd });
}

function walkCommand(cmd: SimpleCommand, walker: Walker, state: WalkState): void {
	walkSubstitutions(cmd.assignments, walker, state.cwd);
	walkSubstitutions(cmd.argv, walker, state.cwd);
	walkSubstitutions(
		cmd.redirects.flatMap((r) => (r.target ? [r.target] : [])),
		walker,
		state.cwd,
	);

	const pipedFromWord = cmd.pipedFrom?.argv[0];
	const pipedFrom = pipedFromWord ? programName(pipedFromWord.value) : cmd.pipedFrom ? "(command)" : undefined;
	const results = analyzeArgv(cmd.argv, cmd.text, walker, state.cwd, pipedFrom, false);

	// Assignments and redirects belong to the outermost command of this simple command.
	const head = results[0] ?? blankAnalysis(cmd.text, "(assignment)");
	for (const assignment of cmd.assignments) {
		const name = assignment.raw.split(/[+[=]/)[0];
		if (isDangerousEnvName(name)) {
			head.risk = maxRisk(head.risk, Risk.high);
			head.reasons.push(`overrides ${name}`);
		}
	}
	applyRedirects(head, cmd.redirects, walker, state.cwd);
	if (results.length === 0) results.push(head);
	for (const r of results) walker.out.push(finalize(r));

	// Track the working directory for later relative paths. Pipeline members run in subshells.
	const program = cmd.argv[0]?.value;
	if (!cmd.inPipeline && (program === "cd" || program === "pushd")) {
		const target = new Args(cmd.argv.slice(1)).positionals()[0];
		if (!target) state.cwd = walker.env.home;
		else if (target.value === "-" || (target.dynamic && expandWord(target, walker.env, state.cwd) === undefined))
			state.cwd = undefined;
		else {
			const resolved = resolvePath(target.value, state.cwd, walker.env, {
				dynamic: target.dynamic,
				tilde: target.tilde,
			});
			state.cwd = resolved.dynamic ? undefined : resolved.abs;
		}
	} else if (!cmd.inPipeline && program === "popd") {
		state.cwd = undefined;
	}
}

function expandWord(word: Word, env: PathEnv, cwd: string | undefined): string | undefined {
	const resolved = resolvePath(word.value, cwd, env, { dynamic: word.dynamic, tilde: word.tilde });
	return resolved.dynamic ? undefined : resolved.abs;
}

function blankAnalysis(text: string, key: string): CommandAnalysis {
	return { text, program: key, key, family: key, risk: Risk.safe, reasons: [], paths: [], learnable: true };
}

function finalize(analysis: CommandAnalysis): CommandAnalysis {
	analysis.reasons = [...new Set(analysis.reasons)];
	if (analysis.risk >= Risk.critical) analysis.learnable = false;
	return analysis;
}

function applyRedirects(
	analysis: CommandAnalysis,
	redirects: Redirect[],
	walker: Walker,
	cwd: string | undefined,
): void {
	for (const redirect of redirects) {
		if (!redirect.target) continue;
		if (OUTPUT_REDIRECTS.has(redirect.op)) addPath(analysis, redirect.target, "write", walker, cwd);
		else if (redirect.op === "<") addPath(analysis, redirect.target, "read", walker, cwd);
	}
}

function addPath(analysis: CommandAnalysis, word: Word, access: Access, walker: Walker, cwd: string | undefined): void {
	if (/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(word.value) && !word.dynamic) return;
	const path = resolvePath(word.value, cwd, walker.env, { dynamic: word.dynamic, tilde: word.tilde, glob: word.glob });
	const { risk, reason } = pathRisk(path, access, walker.env);
	if (access === "read" && risk === Risk.safe) return;
	analysis.paths.push({ path, access, display: displayPath(path, walker.env), risk });
	analysis.risk = maxRisk(analysis.risk, risk);
	if (reason) analysis.reasons.push(reason);
}

/** Bare program name used for table lookup: `/usr/bin/git` -> `git`; `./run.sh` stays a path. */
function programName(value: string): string {
	if (/^(\/usr)?(\/local)?\/s?bin\/[^/]+$/.test(value) || /^\/opt\/homebrew\/bin\/[^/]+$/.test(value))
		return basename(value);
	if (/\.exe$/i.test(value))
		return basename(value)
			.replace(/\.exe$/i, "")
			.toLowerCase();
	return value;
}

function analyzeArgv(
	argv: Word[],
	text: string,
	walker: Walker,
	cwd: string | undefined,
	pipedFrom: string | undefined,
	stdinArgs: boolean,
): CommandAnalysis[] {
	if (argv.length === 0) return [];
	walker.depth++;
	try {
		if (walker.depth > 16) {
			walker.issues.push("wrapper nesting too deep");
			return [];
		}
		const head = argv[0];
		if (head.dynamic || head.glob) {
			const a = blankAnalysis(text, head.raw);
			a.program = head.raw;
			a.risk = Risk.high;
			a.learnable = false;
			a.reasons.push("command name depends on runtime expansion");
			return [a];
		}
		const name = programName(head.value);
		const words = stdinArgs ? [...argv.slice(1), synthetic("$STDIN_ARGS", true)] : argv.slice(1);
		const args = new Args(words);
		const isPath = name.includes("/") || name.includes("\\");
		const handler = isPath ? undefined : HANDLERS.get(name);

		if (
			!isPath &&
			args.words.length === 1 &&
			VERSION_ARGS.has(args.values[0]) &&
			!SHELLS.includes(name) &&
			name !== "sudo"
		) {
			const a = blankAnalysis(text, `${name} ${args.values[0]}`);
			a.program = name;
			a.family = name;
			return [a];
		}

		let verdict: Verdict;
		let program = name;
		if (handler) {
			verdict = handler({ name, args, pipedFrom });
		} else if (isPath) {
			const resolved = resolvePath(head.value, cwd, walker.env, { tilde: head.tilde });
			program = displayPath(resolved, walker.env);
			verdict = v(resolved.rel !== undefined ? Risk.medium : Risk.high, {
				key: program,
				family: program,
				reasons: [
					resolved.rel !== undefined ? "runs a project script" : `runs ${program} from outside the project`,
				],
			});
		} else {
			verdict = v(Risk.medium, {
				key: subKey(name, args.positionals()[0]),
				family: name,
				reasons: [`unrecognized command "${name}"`],
			});
		}

		const pathCwd = verdict.cwd ? expandWord(verdict.cwd, walker.env, cwd) : cwd;
		if (verdict.cwd && pathCwd === undefined) {
			verdict.risk = maxRisk(verdict.risk, Risk.high);
			verdict.reasons = [...(verdict.reasons ?? []), "working directory depends on runtime expansion"];
		}

		const results: CommandAnalysis[] = [];
		if (verdict.inner || verdict.innerScript) {
			if (verdict.inner && verdict.inner.length > 0) {
				results.push(
					...analyzeArgv(verdict.inner, text, walker, pathCwd, undefined, verdict.innerStdinArgs ?? false),
				);
			}
			if (verdict.innerScript) {
				if (verdict.innerScript.dynamic) {
					const a = blankAnalysis(text, `${name} (dynamic script)`);
					a.risk = Risk.high;
					a.learnable = false;
					a.reasons.push("runs a script that depends on runtime expansion");
					results.push(a);
				} else {
					const nested = analyzeBash(verdict.innerScript.value, walker.env, pathCwd ?? walker.env.root);
					walker.issues.push(...nested.issues);
					for (const c of nested.commands) results.push({ ...c, text });
				}
			}
			const wrapperReasons = verdict.reasons ?? [];
			if (results.length === 0) results.push(blankAnalysis(text, verdict.key ?? name));
			for (const r of results) {
				r.risk = maxRisk(r.risk, verdict.risk);
				r.reasons.push(...wrapperReasons);
				if (verdict.learnable === false) {
					r.learnable = false;
					r.key = verdict.key ?? r.key;
				}
			}
			// Wrapper-level paths (e.g. `find -delete` never reaches here, but `xargs -a file` reads).
			return results;
		}

		const analysis: CommandAnalysis = {
			text,
			program,
			key: verdict.key ?? name,
			family: verdict.family ?? verdict.key?.split(" ")[0] ?? name,
			risk: verdict.risk,
			reasons: [...(verdict.reasons ?? [])],
			paths: [],
			learnable: verdict.learnable ?? true,
		};
		for (const w of verdict.writes ?? []) addPath(analysis, w, "write", walker, pathCwd);
		for (const w of verdict.deletes ?? []) addPath(analysis, w, "delete", walker, pathCwd);
		for (const w of verdict.reads ?? []) addPath(analysis, w, "read", walker, pathCwd);

		// Generic secret-read scan over remaining positionals: `grep token ~/.aws/credentials`.
		const touched = new Set([...(verdict.writes ?? []), ...(verdict.deletes ?? []), ...(verdict.reads ?? [])]);
		for (const w of args.positionals()) {
			if (touched.has(w) || w.dynamic) continue;
			if (!/[/.~]/.test(w.value)) continue;
			addPath(analysis, w, "read", walker, pathCwd);
		}

		if (pathCwd === undefined && analysis.paths.some((p) => p.access !== "read" && !p.path.dynamic && !p.path.abs)) {
			analysis.risk = maxRisk(analysis.risk, Risk.high);
		}
		return [analysis];
	} finally {
		walker.depth--;
	}
}

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

export function analyzeFileAccess(
	toolName: string,
	inputPath: string,
	access: Access,
	env: PathEnv,
	cwd: string = env.root,
): CommandAnalysis {
	const path = resolvePath(inputPath, cwd, env, { tilde: inputPath.startsWith("~") });
	const { risk, reason } = pathRisk(path, access, env);
	const display = displayPath(path, env);
	return finalize({
		text: `${toolName} ${display}`,
		program: toolName,
		key: toolName,
		family: toolName,
		risk: access === "read" ? risk : maxRisk(risk, Risk.low),
		reasons: reason ? [reason] : [],
		paths: [{ path, access, display, risk }],
		learnable: true,
	});
}
