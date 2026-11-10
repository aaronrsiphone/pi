// An agent directory whose models.json reaches a faux provider, for the pi-guided extensions'
// separate sessions, which read models the way a user's pi does.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FauxProviderRegistration } from "@earendil-works/pi-ai/compat";

/** Write `<base>/agent/models.json` for `faux` and return the agent directory. */
export function fauxAgentDir(faux: FauxProviderRegistration, base: string): string {
	const agentDir = join(base, "agent");
	mkdirSync(agentDir, { recursive: true });
	const model = faux.getModel();
	const provider = {
		baseUrl: model.baseUrl,
		api: faux.api,
		apiKey: "faux-key",
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			reasoning: m.reasoning,
			input: m.input,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
		})),
	};
	writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [model.provider]: provider } }));
	return agentDir;
}
