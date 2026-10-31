# Know What Your Model Can Do

Pi cannot tell you which model is "good". It can measure the connected model on small tasks with known answers, place it in plain-language ranges, and recommend settings from them. Run `/probe` at any time. First-start setup runs it right after connecting.

The suite takes about a minute on a typical local model and sends about 20 requests. For a model that charges per token, Pi shows the estimated cost and asks first. Results are saved per model in `~/.pi/agent/capability/`, with the last 10 runs.

## What to expect

`/expectations` shows a card for the connected model:

- its class and its range on each probe
- what it did well on the probes and on your own [benchmarks](benchmarks.md)
- where to double-check its work
- the recommended careful level and thinking effort, next to the current ones

Pi builds the card from the latest probe and benchmark results each time it is shown, and adds it to the chat after every probe. It is shown to you and never sent to the model.

## What Pi measures

Pi checks every answer in its own code. The model never grades itself.

| Probe | What it does | Checked by |
|---|---|---|
| Speed | Counts from 1 to 60 | Time to first token and tokens per second |
| Context | Reads the context window from the model's metadata or `models.json` | Shown "as configured"; Pi cannot tell a real value from a default |
| Using tools | Three requests, each needing one tool: convert units, open a file, make a plot | Right tool, arguments valid against the schema, right values |
| Following instructions | Three answers in a required format: JSON only, exactly three bullet lines, one capital word | The format, checked exactly |
| Finding facts in long text | Two facts hidden in a lab log of up to about 8,000 tokens, among similar decoys | Both values appear in the answer |
| Small multi-step task | In a throwaway folder, find the settings file, convert psi to kPa, leave the example file alone, read the file back | The files on disk and the tool calls Pi recorded |

The multi-step probe uses Pi's own read, list, edit, and write tools and its system prompt, with no shell, so nothing outside the throwaway folder can change. Requests use temperature 0 where the provider supports it, so a re-run on the same model gives the same verdict. A model at the edge of a speed range can still move between ranges from one run to the next.

## Ranges

| Dimension | Low | Middle | High |
|---|---|---|---|
| Speed | Slow: under 12 tokens/s | Usable: 12 to 40 tokens/s, or a first token after more than 10 s | Fast: over 40 tokens/s |
| Context | Short: under 32k tokens, a few pages at a time | Medium: under 128k, a few files | Long: 128k or more, many files |
| Using tools, Following instructions | Unreliable: 1 or fewer of 3 | Usually: 2 of 3 | Reliable: 3 of 3 |
| Finding facts | Unreliable: 0 of 2 | Usually: 1 of 2 | Reliable: 2 of 2 |
| Multi-step task | Not done: 1 or fewer of 3 checks | Partly done: 2 of 3 | Done right: 3 of 3 |

### Overall class

| Class | Rule | Roughly | Recommended level | Task size |
|---|---|---|---|---|
| Chat only | Using tools: 1 or fewer | Small local models | 1 Only what I share | One question about the files you share |
| Basic | Below Capable | Small and mid-size local models | 2 Look, don't touch | One file at a time |
| Capable | Multi-step 2 or more, tools 2 or more, instructions 2 or more | Haiku-class | 3 Ask before changing | Small multi-step tasks |
| Strong | Every probe passed | Sonnet- and Opus-class | 3 Ask before changing | Larger changes across several files |

New users still start at level 2 or lower; the recommendation applies when they move up. Thinking effort starts at medium, or low for slow models, because more thinking makes a slow model much slower. Pi lists where to double-check its work from the probes it failed, and always includes numbers, units, and calculations.

## Why these boundaries

- **Speed.** People read about 4 to 8 words a second, so below about 12 tokens/s an answer arrives slower than it can be read. Hosted models stream far faster: [Artificial Analysis](https://artificialanalysis.ai/models/comparisons/claude-haiku-5-5-vs-claude-opus-5-5) measures Haiku-class models at about 140 to 240 tokens/s and Opus-class at about 75. Estimates for an 8B model under llama.cpp on recent Apple chips are 40 to 80 tokens/s ([llama.cpp Apple Silicon results](https://github.com/ggml-org/llama.cpp/discussions/4167), [WillItRunAI estimates](https://willitrunai.com/can-run/llama-3.1-8b-on-m4-max-48gb)); CPU-only laptops are much slower.
- **Context.** Many models handle much less than their claimed window: in [RULER](https://github.com/nvidia/RULER), only about half of the models that claimed 32k or more held up at 32k. That is why the window is shown "as configured" and the retrieval probe checks real reading on a long text.
- **Tools and format.** Simple tool calls and format following are close to solved for capable models, while small models score far lower on function-calling benchmarks ([BFCL](https://gorilla.cs.berkeley.edu/leaderboard.html)) and somewhat lower on format following ([IFEval comparisons](https://arxiv.org/pdf/2410.12049)). These probes therefore mainly flag weak models.
- **Multi-step work separates the classes most.** On Terminal-Bench 2.0, Haiku 4.5, Sonnet 4.6, and Opus 4.6 scored 41%, 59%, and 65% ([comparison](https://www.morphllm.com/comparisons/claude-haiku-vs-sonnet-vs-opus)), a much wider spread than on code generation. The overall class therefore depends most on the multi-step task.

## Limits

A one-minute suite tells a weak model from a capable one. It cannot tell a Sonnet-class model from an Opus-class model: both usually pass every probe. [Benchmarks](benchmarks.md) you build from tasks you know the answers to show the difference on your own work.

The suite version is saved with each result. When the probes or boundaries change, the version changes and older results are not compared with new ones.

To turn probes and the card off, add `"-builtin:capability"` to `extensions` in [settings](settings.md#resources).
