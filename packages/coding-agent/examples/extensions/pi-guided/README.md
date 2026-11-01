# pi-guided

Four pi extensions for scientists and engineers who are new to AI agents. Each works on its own; together they guide a newcomer from connecting a model to trusting it with real work.

| Extension | Commands | What it does |
|---|---|---|
| `careful` | `/careful`, `--careful` | [Careful levels](docs/careful-levels.md): limit what the agent may do to your files, from "only what I share" to "it's yours". |
| `capability` | `/probe`, `/expectations` | [Measure the connected model](docs/model-capability.md) with tasks that have known answers, and show what to expect from it. |
| `benchmark` | `/bench` | [Benchmark pi on your own work](docs/benchmarks.md): ladders of tasks you know the answers to, run on a copy and graded by you. |
| `onboarding` | `/onboarding` | [Guided setup](docs/guided-setup.md) for newcomers: connect, measure, pick a level, run a first benchmark. |

They use only pi's public extension API and change nothing in pi itself.

## Install

Unpack the folder somewhere permanent, then:

```bash
pi install /path/to/pi-guided
```

Pi loads it from that path on every start. To try it once without installing, run `pi -e /path/to/pi-guided`.

## Choose extensions

All four load by default. To load only some, use the object form of the package in `~/.pi/agent/settings.json`. An experienced user who only wants benchmarks:

```json
{
  "packages": [{ "source": "/path/to/pi-guided", "extensions": ["benchmark/index.ts"] }]
}
```

Or run `pi config` and turn individual extensions on or off.

The extensions talk to each other only through pi's event bus, so any combination works:

- Without `careful`, there are no levels: onboarding skips the level steps, and benchmark tasks still run at the level the ladder names.
- Without `capability`, onboarding skips the measurement and the card.
- Without `benchmark`, onboarding skips the first benchmark, and the card shows probe results only.
- Without `onboarding`, nothing starts on its own; every command still works.

## Limits

Benchmark tasks and the multi-step probe run as separate pi sessions. They read models from `~/.pi/agent/models.json` and stored logins (`/login`), so a model that only another extension registers is not available to them.

## Files

| Path | What it holds |
|---|---|
| `~/.pi/agent/careful/config.json` | Your careful level |
| `<project>/.pi/careful.json` | A project's highest allowed level |
| `~/.pi/agent/capability/` | Probe results per model |
| `~/.pi/agent/benchmark/` | Personal ladders and run history |
| `<project>/.pi/benchmarks/` | Ladders shared with your team |
| `~/.pi/agent/onboarding/state.json` | Where guided setup stopped |
