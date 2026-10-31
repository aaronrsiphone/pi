/**
 * Attachments for careful level 1, where the agent has no tools.
 *
 * Typing `@` in the editor completes a file path but leaves only the path in the message. At level 1
 * the model cannot open it, so mentioned files are read here and added to the message, the way
 * `pi @file` does on the command line.
 */

import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resolveReadPath } from "../../core/tools/path-utils.ts";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { stripBom } from "../../utils/text.ts";

export interface Attachments {
	/** `<file>` blocks to append to the message. Empty when nothing was mentioned. */
	text: string;
	images: ImageContent[];
	/** Mentions that could not be attached, with the reason, for a notification. */
	problems: string[];
}

// A large data file would crowd out the conversation; the model is told when a file was cut.
const MAX_TEXT_BYTES = 200_000;

/** `@path` or `@"path with spaces"`, as the editor's file completion inserts them. */
const MENTION = /(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/g;

/** Paths mentioned with `@` in a message, in order, without duplicates. */
export function findMentions(text: string): string[] {
	const out: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const path = (match[1] ?? match[2]).replace(/[,.;:!?)]+$/, "");
		if (path && !out.includes(path)) out.push(path);
	}
	return out;
}

/** Read every mentioned file that exists under `cwd` or elsewhere on disk. */
export async function readMentions(paths: string[], cwd: string): Promise<Attachments> {
	const out: Attachments = { text: "", images: [], problems: [] };
	for (const mention of paths) {
		const abs = resolveReadPath(mention, cwd);
		const info = await stat(abs).catch(() => undefined);
		if (!info?.isFile()) {
			// `@` also starts e-mail addresses and handles; only report things that look like paths.
			if (/[/\\.]/.test(mention)) out.problems.push(`${mention}: file not found`);
			continue;
		}
		const name = relative(cwd, abs).startsWith("..") ? abs : relative(cwd, abs);
		const mimeType = await detectSupportedImageMimeTypeFromFile(abs);
		const bytes = await readFile(abs);
		if (mimeType) {
			const image = await processImage(bytes, mimeType);
			if (!image.ok) {
				out.problems.push(`${mention}: ${image.message}`);
				continue;
			}
			out.images.push({ type: "image", mimeType: image.mimeType, data: image.data });
			out.text += `<file name="${name}">(image attached)</file>\n`;
			continue;
		}
		if (bytes.subarray(0, 8192).includes(0)) {
			out.problems.push(`${mention}: not a text file (save it as CSV or text to share it)`);
			continue;
		}
		const cut = bytes.length > MAX_TEXT_BYTES;
		const content = stripBom(bytes.subarray(0, MAX_TEXT_BYTES).toString("utf-8"));
		const note = cut ? `\n[file cut at ${MAX_TEXT_BYTES} bytes of ${bytes.length}]` : "";
		out.text += `<file name="${name}">\n${content}${note}\n</file>\n`;
	}
	return out;
}
