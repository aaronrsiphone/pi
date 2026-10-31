# Get Started Step by Step

If you have never used an AI agent, Pi can walk you through setup. It starts on its own the first time you open Pi, and `/onboarding` runs it again at any time.

Pi runs every step itself. The model only does the tasks being tested, so a weak model cannot spoil setup.

1. **Connect.** Use the model you have, enter an address (URL) you were given for a company gateway or a server on your computer, or sign in to a provider with `/login`. Pi adds an address to [`models.json`](models.md#configure-a-compatible-endpoint) and checks the connection with one short request.
2. **Measure.** Pi runs the [capability probes](model-capability.md) for about a minute and shows what it found.
3. **"Have you used an AI agent before?"** Answer yes for the short path: the careful levels and settings at a glance, with the benchmark optional.
4. **Pick a careful level.** The [careful level](careful-levels.md) decides what Pi may do to your files. Newcomers start at level 2, Look, don't touch, or lower if the probes found a weak model.
5. **Practice.** Pi shows what a level 3 approval question looks like and what each answer does. Nothing runs.
6. **First benchmark.** Run the example ladder of lab data tasks, or start a ladder of your own. See [Benchmark Pi on Your Own Work](benchmarks.md).
7. **What to expect.** The [expectations card](model-capability.md#what-to-expect) sums up the model and your results.
8. **First task.** Pi suggests a first task with a known answer that suits your level and puts it in the message box.

After a benchmark, when every task at your current level passed, Pi suggests the next level and a harder task. Move up when you trust the results.

Pi works in the folder you started it in. To work on another project, quit Pi and start it in that folder.

## Pause, skip, and run again

| Action | How |
|---|---|
| Pause | Press Escape in any step. Setup continues where it stopped the next time you open Pi or run `/onboarding`. |
| Skip | Choose "Skip setup for now", or run `/onboarding skip`. |
| Run again | `/onboarding`, or `/onboarding restart` to start from the first step. |

Setup only guides. Careful levels (`/careful`), probes (`/probe`, `/expectations`), and benchmarks (`/bench`) work on their own, and setup skips the step for any of them that is turned off. To turn setup off, add `"-builtin:onboarding"` to `extensions` in [settings](settings.md#resources).
