/**
 * The folder a benchmark task runs in: always a fresh copy, never the user's real files.
 *
 * A ladder that brings its own files gets exactly those. Otherwise the project folder is copied,
 * leaving out version control, dependency folders and symbolic links, up to a size limit so a data folder of
 * many gigabytes is refused instead of filling the disk.
 */

import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Folders never copied: version control and installed dependencies. */
const SKIPPED = new Set([".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv"]);

/** The largest project folder a run copies. */
export const MAX_COPY_BYTES = 200 * 1024 * 1024;

export type Workspace = { ok: true; dir: string; dispose(): void } | { ok: false; error: string };

/** Make a fresh folder for one run, from the ladder's files or a copy of `projectDir`. */
export function prepareWorkspace(files: Record<string, string> | undefined, projectDir: string): Workspace {
	if (!files) {
		const size = folderSize(projectDir, MAX_COPY_BYTES);
		if (size > MAX_COPY_BYTES) {
			return {
				ok: false,
				error: `This folder is larger than ${MAX_COPY_BYTES / 1024 / 1024} MB, too large to copy for a benchmark. Run it from a smaller folder, or give the ladder its own files.`,
			};
		}
	}
	const dir = mkdtempSync(join(tmpdir(), `pi-bench-${basename(projectDir)}-`));
	const dispose = () => rmSync(dir, { recursive: true, force: true });
	if (files) {
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(dir, path)), { recursive: true });
			writeFileSync(join(dir, path), content);
		}
	} else {
		cpSync(projectDir, dir, {
			recursive: true,
			// A symbolic link would let the run write through to the real file, so links are left out.
			filter: (source) =>
				source === projectDir || (!SKIPPED.has(basename(source)) && !lstatSync(source).isSymbolicLink()),
		});
	}
	return { ok: true, dir, dispose };
}

/** Bytes in a folder without the skipped folders, stopping early once past `limit`. */
function folderSize(dir: string, limit: number): number {
	let total = 0;
	const pending = [dir];
	while (pending.length > 0 && total <= limit) {
		const current = pending.pop()!;
		for (const name of readdirSync(current)) {
			if (SKIPPED.has(name)) continue;
			const path = join(current, name);
			const info = lstatSync(path);
			if (info.isSymbolicLink()) continue;
			if (info.isDirectory()) pending.push(path);
			else total += info.size;
		}
	}
	return total;
}
