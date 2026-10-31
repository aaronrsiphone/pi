/**
 * A conservative bash parser for permission decisions.
 *
 * It does not execute or fully emulate bash. It answers one question: which simple commands
 * could this string run, with which literal arguments, redirects, and working-directory scopes?
 *
 * Anything it cannot analyze is reported in `issues`, and the decision engine treats an issue as
 * "must ask". Missing a construct must never turn into an auto-approval.
 *
 * Handled: single/double/ANSI-C quotes, backslash escapes and line continuations, comments,
 * `;` `&` `&&` `||` `|` `|&` and newlines, subshells `( )`, brace groups, `$( )`, backticks,
 * `<( )` / `>( )`, `${ }`, `$(( ))`, `(( ))`, `[[ ]]`, here-docs (with expansion when the
 * delimiter is unquoted), here-strings, fd redirects and duplications, assignments, and the
 * control keywords of if/while/until/for/select.
 */

export interface Word {
	/** Source text of the word. */
	raw: string;
	/** Value after quote removal. Expansions are kept as their source text. */
	value: string;
	/** Contains a parameter, command, or arithmetic expansion. */
	dynamic: boolean;
	/** Contains an unquoted glob or brace expansion. */
	glob: boolean;
	/** Starts with an unquoted `~`. */
	tilde: boolean;
	/** Command and process substitutions inside the word; each runs in a subshell. */
	substitutions: Script[];
}

export interface Redirect {
	/** One of `>`, `>>`, `>|`, `&>`, `&>>`, `<`, `<>`, `<<`, `<<-`, `<<<`, `>&`, `<&`. */
	op: string;
	fd: number | undefined;
	/** File target, here-doc delimiter, or here-string. Undefined for fd duplication (`2>&1`). */
	target: Word | undefined;
	heredocBody?: string;
}

export interface SimpleCommand {
	assignments: Word[];
	argv: Word[];
	redirects: Redirect[];
	/** Member of a multi-command pipeline (runs in its own subshell, so `cd` does not persist). */
	inPipeline: boolean;
	/** Previous command in the same pipeline, if any. */
	pipedFrom: SimpleCommand | undefined;
	text: string;
}

export type ScriptNode =
	| { kind: "command"; command: SimpleCommand }
	| { kind: "subshell"; script: Script; redirects: Redirect[]; inPipeline: boolean };

export interface Script {
	nodes: ScriptNode[];
}

export interface ParseResult {
	script: Script;
	/** Constructs the parser could not analyze. Non-empty means the command must be confirmed. */
	issues: string[];
}

const SKIP_KEYWORDS = new Set([
	"if",
	"then",
	"elif",
	"else",
	"fi",
	"do",
	"done",
	"while",
	"until",
	"!",
	"{",
	"}",
	"time",
]);
const WORD_BREAK = new Set([" ", "\t", "\n", "\r", ";", "&", "|", "(", ")", "<", ">"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

interface PendingHeredoc {
	delimiter: string;
	stripTabs: boolean;
	expand: boolean;
	redirect: Redirect;
}

type Terminator = ")" | "`" | undefined;

class Parser {
	readonly src: string;
	pos = 0;
	readonly issues: string[];
	private pending: PendingHeredoc[] = [];
	/** Inside `...`: an unescaped backtick ends the substitution instead of starting a new one. */
	private backtickDepth = 0;
	private depth: number;

	constructor(src: string, issues: string[], depth: number) {
		this.src = src;
		this.issues = issues;
		this.depth = depth;
		if (depth > 32) this.issue("nesting too deep");
	}

	private issue(message: string): void {
		if (!this.issues.includes(message)) this.issues.push(message);
	}

	private peek(offset = 0): string {
		return this.src[this.pos + offset] ?? "";
	}

	private atEnd(): boolean {
		return this.pos >= this.src.length;
	}

	/** Skip spaces, tabs, line continuations, and comments. Newlines are significant. */
	private skipBlank(): void {
		while (!this.atEnd()) {
			const ch = this.peek();
			if (ch === " " || ch === "\t" || ch === "\r") {
				this.pos++;
			} else if (ch === "\\" && this.peek(1) === "\n") {
				this.pos += 2;
			} else if (ch === "#") {
				while (!this.atEnd() && this.peek() !== "\n") this.pos++;
			} else {
				return;
			}
		}
	}

	private atTerminator(term: Terminator): boolean {
		return term !== undefined && this.peek() === term;
	}

	parseScript(term: Terminator): Script {
		const nodes: ScriptNode[] = [];
		for (;;) {
			this.skipBlank();
			if (this.atEnd()) {
				if (term !== undefined) this.issue(`unterminated ${term === ")" ? "$( or (" : "backtick"}`);
				this.readPendingHeredocs();
				return { nodes };
			}
			if (this.atTerminator(term)) {
				this.pos++;
				return { nodes };
			}
			const ch = this.peek();
			if (ch === "\n") {
				this.pos++;
				this.readPendingHeredocs();
				continue;
			}
			if (ch === ";") {
				if (this.peek(1) === ";") this.issue("case statement");
				this.pos += this.peek(1) === ";" ? 2 : 1;
				continue;
			}
			if ((ch === "&" && this.peek(1) === "&") || (ch === "|" && this.peek(1) === "|")) {
				this.pos += 2;
				continue;
			}
			if (ch === "&" && this.peek(1) !== ">") {
				this.pos++;
				continue;
			}
			if (ch === "|") {
				// A pipe with no left-hand command.
				this.issue("dangling pipe");
				this.pos++;
				continue;
			}
			if (ch === ")") {
				this.issue("unbalanced )");
				this.pos++;
				continue;
			}
			const before = this.pos;
			nodes.push(...this.parsePipeline(term));
			if (this.pos === before) {
				// Defensive: never loop without progress.
				this.issue(`unexpected character ${JSON.stringify(ch)}`);
				this.pos++;
			}
		}
	}

	private parsePipeline(term: Terminator): ScriptNode[] {
		const stages: ScriptNode[][] = [this.parseCommand(term)];
		for (;;) {
			this.skipBlank();
			if (this.peek() === "|" && this.peek(1) !== "|") {
				this.pos += this.peek(1) === "&" ? 2 : 1;
				this.skipBlankAndNewlines();
				stages.push(this.parseCommand(term));
				continue;
			}
			break;
		}
		if (stages.length > 1) {
			let previous: SimpleCommand | undefined;
			for (const stage of stages) {
				for (const node of stage) {
					if (node.kind === "command") node.command.inPipeline = true;
					else node.inPipeline = true;
				}
				const head = stage.find((n) => n.kind === "command");
				if (head?.kind === "command") {
					head.command.pipedFrom = previous;
					previous = head.command;
				} else {
					previous = undefined;
				}
			}
		}
		return stages.flat();
	}

	private skipBlankAndNewlines(): void {
		for (;;) {
			this.skipBlank();
			if (this.peek() === "\n") {
				this.pos++;
				this.readPendingHeredocs();
				continue;
			}
			return;
		}
	}

	private parseCommand(term: Terminator): ScriptNode[] {
		this.skipBlank();
		if (this.peek() === "(") {
			if (this.peek(1) === "(") {
				this.pos += 2;
				return this.substitutionsAsNodes(this.scanBalanced("((", "))"));
			}
			this.pos++;
			const script = this.parseNested(")");
			const redirects = this.parseTrailingRedirects();
			return [{ kind: "subshell", script, redirects, inPipeline: false }];
		}
		return this.parseSimple(term);
	}

	/** Parse a nested script (subshell or substitution) with a recursion limit. */
	private parseNested(term: Terminator): Script {
		this.depth++;
		if (term === "`") this.backtickDepth++;
		try {
			if (this.depth > 32) {
				this.issue("nesting too deep");
				this.pos = this.src.length;
				return { nodes: [] };
			}
			return this.parseScript(term);
		} finally {
			this.depth--;
			if (term === "`") this.backtickDepth--;
		}
	}

	private parseTrailingRedirects(): Redirect[] {
		const redirects: Redirect[] = [];
		for (;;) {
			this.skipBlank();
			const redirect = this.tryParseRedirect();
			if (!redirect) return redirects;
			redirects.push(redirect);
		}
	}

	private parseSimple(term: Terminator): ScriptNode[] {
		const start = this.pos;
		const assignments: Word[] = [];
		const argv: Word[] = [];
		const redirects: Redirect[] = [];
		const extra: ScriptNode[] = [];
		let testMode = false;

		for (;;) {
			this.skipBlank();
			if (this.atEnd() || this.atTerminator(term)) break;
			const ch = this.peek();

			if (testMode) {
				const op = this.src.slice(this.pos).match(/^(&&|\|\||[<>()!])/);
				if (op) {
					argv.push(literalWord(op[0]));
					this.pos += op[0].length;
					continue;
				}
				if (ch === "\n" || ch === ";") {
					this.issue("unterminated [[");
					break;
				}
			} else {
				if (ch === "\n" || ch === ";" || ch === "|" || ch === ")") break;
				if (ch === "&" && this.peek(1) !== ">") break;
				if ((ch === "<" || ch === ">") && this.peek(1) === "(") {
					argv.push(this.readWord());
					continue;
				}
				const redirect = this.tryParseRedirect();
				if (redirect) {
					redirects.push(redirect);
					continue;
				}
				if (ch === "(") {
					if (argv.length === 1 && this.peek(1) === ")") {
						this.issue("function definition");
						this.pos += 2;
						argv.length = 0;
						continue;
					}
					this.issue("unexpected (");
					this.pos++;
					continue;
				}
			}

			const word = this.readWord();
			if (word.raw.length === 0) {
				this.issue(`unexpected character ${JSON.stringify(ch)}`);
				this.pos++;
				continue;
			}

			if (testMode) {
				argv.push(word);
				if (word.raw === "]]") testMode = false;
				continue;
			}

			const isCommandPosition = argv.length === 0;
			const unquotedKeyword = isCommandPosition && word.raw === word.value && !word.dynamic;
			if (isCommandPosition && assignments.length === 0 && unquotedKeyword && SKIP_KEYWORDS.has(word.value)) {
				continue;
			}
			if (unquotedKeyword && assignments.length === 0 && (word.value === "for" || word.value === "select")) {
				extra.push(...this.parseForHeader(word.value));
				continue;
			}
			if (unquotedKeyword && assignments.length === 0 && word.value === "case") {
				this.issue("case statement");
				this.skipPast(/\besac\b/);
				break;
			}
			if (unquotedKeyword && assignments.length === 0 && word.value === "function") {
				this.issue("function definition");
				this.skipBlank();
				this.readWord();
				this.skipBlank();
				if (this.peek() === "(" && this.peek(1) === ")") this.pos += 2;
				continue;
			}
			if (unquotedKeyword && assignments.length === 0 && word.value === "coproc") {
				this.issue("coproc");
				continue;
			}
			if (isCommandPosition && ASSIGNMENT.test(word.raw)) {
				assignments.push(word);
				continue;
			}
			argv.push(word);
			if (isCommandPosition && word.raw === "[[") testMode = true;
		}

		const text = this.src.slice(start, this.pos).trim();
		if (argv.length === 0 && assignments.length === 0 && redirects.length === 0) return extra;
		const command: SimpleCommand = {
			assignments,
			argv,
			redirects,
			inPipeline: false,
			pipedFrom: undefined,
			text,
		};
		return [...extra, { kind: "command", command }];
	}

	/** `for name in words; do` / `for ((...)); do`: header words are expanded, not executed. */
	private parseForHeader(keyword: string): ScriptNode[] {
		this.skipBlank();
		if (keyword === "for" && this.peek() === "(" && this.peek(1) === "(") {
			this.pos += 2;
			return this.substitutionsAsNodes(this.scanBalanced("((", "))"));
		}
		const nodes: ScriptNode[] = [];
		for (;;) {
			this.skipBlank();
			const ch = this.peek();
			if (this.atEnd() || ch === ";" || ch === "\n" || ch === "&" || ch === "|" || ch === ")") return nodes;
			const word = this.readWord();
			if (word.raw.length === 0) {
				this.issue(`unexpected character ${JSON.stringify(ch)}`);
				this.pos++;
				continue;
			}
			for (const script of word.substitutions)
				nodes.push({ kind: "subshell", script, redirects: [], inPipeline: false });
			if (word.raw === "do") return nodes;
		}
	}

	private skipPast(pattern: RegExp): void {
		const rest = this.src.slice(this.pos);
		const match = pattern.exec(rest);
		this.pos = match ? this.pos + match.index + match[0].length : this.src.length;
	}

	private substitutionsAsNodes(text: string): ScriptNode[] {
		return scanSubstitutions(text, this.issues, this.depth + 1).map((script) => ({
			kind: "subshell" as const,
			script,
			redirects: [],
			inPipeline: false,
		}));
	}

	/** Scan from the current position to the matching close sequence, returning the inner text. */
	private scanBalanced(open: string, close: string): string {
		const start = this.pos;
		let depth = 1;
		while (!this.atEnd()) {
			if (this.src.startsWith(open, this.pos)) {
				depth++;
				this.pos += open.length;
				continue;
			}
			if (this.src.startsWith(close, this.pos)) {
				depth--;
				if (depth === 0) {
					const inner = this.src.slice(start, this.pos);
					this.pos += close.length;
					return inner;
				}
				this.pos += close.length;
				continue;
			}
			const ch = this.peek();
			if (ch === "'" || ch === '"') {
				this.skipQuoted(ch);
				continue;
			}
			this.pos++;
		}
		this.issue(`unterminated ${open}`);
		return this.src.slice(start);
	}

	private skipQuoted(quote: string): void {
		this.pos++;
		while (!this.atEnd() && this.peek() !== quote) {
			if (quote === '"' && this.peek() === "\\") this.pos++;
			this.pos++;
		}
		this.pos++;
	}

	private tryParseRedirect(): Redirect | undefined {
		const rest = this.src.slice(this.pos);
		const match = rest.match(/^(\d*)(&>>|&>|>>|>\||>&|<<<|<<-|<<|<>|<&|>|<)/);
		if (!match) return undefined;
		const [whole, fdText, op] = match;
		// `2>file` needs the digits glued to the operator; `echo 2 > f` passes "2" as an argument.
		this.pos += whole.length;
		const fd = fdText.length > 0 ? Number(fdText) : undefined;
		this.skipBlank();

		if (op === ">&" || op === "<&") {
			const dup = this.src.slice(this.pos).match(/^(\d+-?|-)(?=$|[\s;&|)<>])/);
			if (dup) {
				this.pos += dup[0].length;
				return { op, fd, target: undefined };
			}
			// `>& file` is the same as `&> file`.
			return { op: op === ">&" ? "&>" : "<", fd, target: this.readWord() };
		}

		const target = this.readWord();
		if (target.raw.length === 0) this.issue(`redirect ${op} without target`);
		const redirect: Redirect = { op, fd, target };
		if (op === "<<" || op === "<<-") {
			this.pending.push({
				delimiter: target.value,
				stripTabs: op === "<<-",
				expand: target.raw === target.value,
				redirect,
			});
		}
		return redirect;
	}

	private readPendingHeredocs(): void {
		const pending = this.pending;
		this.pending = [];
		for (const heredoc of pending) {
			const lines: string[] = [];
			let closed = false;
			while (!this.atEnd()) {
				let end = this.src.indexOf("\n", this.pos);
				if (end === -1) end = this.src.length;
				const line = this.src.slice(this.pos, end);
				this.pos = Math.min(end + 1, this.src.length);
				const compare = heredoc.stripTabs ? line.replace(/^\t+/, "") : line;
				if (compare === heredoc.delimiter) {
					closed = true;
					break;
				}
				lines.push(line);
			}
			if (!closed) this.issue("unterminated here-document");
			const body = lines.join("\n");
			heredoc.redirect.heredocBody = body;
			if (heredoc.expand && heredoc.redirect.target) {
				heredoc.redirect.target.substitutions.push(...scanSubstitutions(body, this.issues, this.depth + 1));
				if (/[$`]/.test(body)) heredoc.redirect.target.dynamic = true;
			}
		}
	}

	readWord(): Word {
		const start = this.pos;
		let value = "";
		let dynamic = false;
		let glob = false;
		let tilde = false;
		const substitutions: Script[] = [];

		if ((this.peek() === "<" || this.peek() === ">") && this.peek(1) === "(") {
			this.pos += 2;
			substitutions.push(this.parseNested(")"));
			const raw = this.src.slice(start, this.pos);
			return { raw, value: raw, dynamic: true, glob: false, tilde: false, substitutions };
		}

		if (this.peek() === "~") tilde = true;

		while (!this.atEnd()) {
			const ch = this.peek();
			if (WORD_BREAK.has(ch)) break;
			if (ch === "`" && this.backtickDepth > 0) break;
			if (ch === "\\") {
				if (this.peek(1) === "\n") {
					this.pos += 2;
					continue;
				}
				value += this.peek(1);
				this.pos += 2;
				continue;
			}
			if (ch === "'") {
				const end = this.src.indexOf("'", this.pos + 1);
				if (end === -1) {
					this.issue("unterminated single quote");
					value += this.src.slice(this.pos + 1);
					this.pos = this.src.length;
					break;
				}
				value += this.src.slice(this.pos + 1, end);
				this.pos = end + 1;
				continue;
			}
			if (ch === "$" && this.peek(1) === "'") {
				this.pos += 2;
				value += this.readAnsiC();
				continue;
			}
			if (ch === '"') {
				this.pos++;
				const inner = this.readDoubleQuoted(substitutions);
				value += inner.value;
				dynamic ||= inner.dynamic;
				continue;
			}
			if (ch === "$" || ch === "`") {
				const expansion = this.readExpansion(substitutions);
				value += expansion;
				if (expansion !== "$") dynamic = true;
				continue;
			}
			if (ch === "*" || ch === "?" || ch === "[") glob = true;
			if (ch === "{" && /^\{[^}\s]*(,|\.\.)[^}\s]*\}/.test(this.src.slice(this.pos))) glob = true;
			value += ch;
			this.pos++;
		}
		return { raw: this.src.slice(start, this.pos), value, dynamic, glob, tilde, substitutions };
	}

	private readAnsiC(): string {
		let out = "";
		const escapes: Record<string, string> = {
			n: "\n",
			t: "\t",
			r: "\r",
			"\\": "\\",
			"'": "'",
			'"': '"',
			a: "\x07",
			e: "\x1b",
		};
		while (!this.atEnd()) {
			const ch = this.peek();
			if (ch === "'") {
				this.pos++;
				return out;
			}
			if (ch === "\\") {
				const next = this.peek(1);
				const hex = this.src.slice(this.pos + 2).match(/^[0-9a-fA-F]{1,2}/);
				if (next === "x" && hex) {
					out += String.fromCharCode(parseInt(hex[0], 16));
					this.pos += 2 + hex[0].length;
					continue;
				}
				out += escapes[next] ?? next;
				this.pos += 2;
				continue;
			}
			out += ch;
			this.pos++;
		}
		this.issue("unterminated $'");
		return out;
	}

	private readDoubleQuoted(substitutions: Script[]): { value: string; dynamic: boolean } {
		let value = "";
		let dynamic = false;
		while (!this.atEnd()) {
			const ch = this.peek();
			if (ch === '"') {
				this.pos++;
				return { value, dynamic };
			}
			if (ch === "\\") {
				const next = this.peek(1);
				if (next === "\n") {
					this.pos += 2;
					continue;
				}
				value += '$`"\\'.includes(next) ? next : ch + next;
				this.pos += 2;
				continue;
			}
			if (ch === "$" || ch === "`") {
				const expansion = this.readExpansion(substitutions);
				value += expansion;
				if (expansion !== "$") dynamic = true;
				continue;
			}
			value += ch;
			this.pos++;
		}
		this.issue("unterminated double quote");
		return { value, dynamic };
	}

	/** Read one `$...` or backtick expansion and return its source text. */
	readExpansion(substitutions: Script[]): string {
		const start = this.pos;
		const ch = this.peek();
		if (ch === "`") {
			this.pos++;
			substitutions.push(this.parseNested("`"));
			return this.src.slice(start, this.pos);
		}
		const next = this.peek(1);
		if (next === "(" && this.peek(2) === "(") {
			this.pos += 3;
			const inner = this.scanBalanced("((", "))");
			substitutions.push(...scanSubstitutions(inner, this.issues, this.depth + 1));
			return this.src.slice(start, this.pos);
		}
		if (next === "(") {
			this.pos += 2;
			substitutions.push(this.parseNested(")"));
			return this.src.slice(start, this.pos);
		}
		if (next === "{") {
			this.pos += 2;
			const inner = this.scanBalanced("{", "}");
			substitutions.push(...scanSubstitutions(inner, this.issues, this.depth + 1));
			return this.src.slice(start, this.pos);
		}
		const name = this.src.slice(this.pos + 1).match(/^([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])/);
		if (name) {
			this.pos += 1 + name[0].length;
			return this.src.slice(start, this.pos);
		}
		this.pos++;
		return "$";
	}
}

function literalWord(text: string): Word {
	return { raw: text, value: text, dynamic: false, glob: false, tilde: false, substitutions: [] };
}

/**
 * Find command substitutions in text that bash expands like a double-quoted string
 * (here-doc bodies, `${...}` and arithmetic contents).
 */
function scanSubstitutions(text: string, issues: string[], depth: number): Script[] {
	if (!/[$`]/.test(text)) return [];
	const parser = new Parser(text, issues, depth);
	const substitutions: Script[] = [];
	while (parser.pos < text.length) {
		const ch = text[parser.pos];
		if (ch === "\\") {
			parser.pos += 2;
			continue;
		}
		if (ch === "$" || ch === "`") {
			parser.readExpansion(substitutions);
			continue;
		}
		parser.pos++;
	}
	return substitutions;
}

export function parseShell(source: string): ParseResult {
	const issues: string[] = [];
	const parser = new Parser(source, issues, 0);
	const script = parser.parseScript(undefined);
	return { script, issues };
}

/** Every simple command in a script, including those in subshells and substitutions, in source order. */
export function allCommands(script: Script): SimpleCommand[] {
	const out: SimpleCommand[] = [];
	const visitWord = (word: Word) => {
		for (const sub of word.substitutions) out.push(...allCommands(sub));
	};
	const visitRedirects = (redirects: Redirect[]) => {
		for (const r of redirects) if (r.target) visitWord(r.target);
	};
	for (const node of script.nodes) {
		if (node.kind === "subshell") {
			out.push(...allCommands(node.script));
			visitRedirects(node.redirects);
			continue;
		}
		const cmd = node.command;
		for (const w of cmd.assignments) visitWord(w);
		for (const w of cmd.argv) visitWord(w);
		visitRedirects(cmd.redirects);
		out.push(cmd);
	}
	return out;
}
