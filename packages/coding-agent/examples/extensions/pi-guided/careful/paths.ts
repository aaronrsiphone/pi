// Resolve a path the user or the model typed, the way pi's file tools do for ordinary paths.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/** Absolute path for `path` relative to `cwd`, expanding a leading `~` and dropping a leading `@`. */
export function resolveUserPath(path: string, cwd: string): string {
	const bare = path.startsWith("@") ? path.slice(1) : path;
	const expanded = bare === "~" ? homedir() : bare.startsWith("~/") ? join(homedir(), bare.slice(2)) : bare;
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
