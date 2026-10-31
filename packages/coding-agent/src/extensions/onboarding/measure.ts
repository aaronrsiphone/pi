/**
 * The "probe" step: measure the newly connected model and show what pi found, in plain words.
 *
 * A failed or declined measurement does not block setup: the user can run /probe later.
 */

import type { ExtensionContext } from "../../core/extensions/types.ts";
import type { SuiteOutcome } from "../capability/index.ts";
import { describeResult } from "../capability/summary.ts";
import type { FlowEvent } from "./flow.ts";

/** Run the measurement and show the result. Returns undefined when the user paused with Escape. */
export async function runProbe(
	ctx: ExtensionContext,
	measure: (ctx: ExtensionContext) => Promise<SuiteOutcome | undefined>,
): Promise<FlowEvent | undefined> {
	const outcome = await measure(ctx);
	if (!outcome) return { type: "probed" };
	const text = outcome.ok
		? [
				"Here is what pi measured. These are realistic expectations, not a promise: check its work.",
				"",
				...describeResult(outcome.result),
			].join("\n")
		: `Pi could not measure the model (${outcome.error}). You can try again later with /probe.`;
	const choice = await ctx.ui.select(text, ["Continue"]);
	return choice === undefined ? undefined : { type: "probed" };
}
