/**
 * What the benchmark extension tells other extensions, on the event bus.
 */

import type { RunRecord } from "./store.ts";

/** Event-bus channel: a ladder run ended. Payload: `BenchmarkFinishedEvent`. */
export const BENCHMARK_FINISHED_EVENT = "benchmark:finished";

export interface BenchmarkFinishedEvent {
	ladderName: string;
	/** The graded runs, in task order. */
	runs: RunRecord[];
	/** True when the user stopped before the last task. */
	stopped: boolean;
}
