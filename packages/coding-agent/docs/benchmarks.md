# Benchmark Pi on Your Own Work

A benchmark is a short list of tasks you already know the answers to, from easy to harder. Pi runs each task on a copy of the files and you grade every answer. Run the same list again after changing the model, the thinking effort, or the careful level, and you see what changed. That is how you choose a model and settings for your work.

Run `/bench` to start. It offers to run a ladder, make a new one, copy an example, or compare results.

## A ladder of tasks

A ladder climbs from tasks a weak model can do to your real work:

| Step | Kind of task | Example | Suggested level |
|---|---|---|---|
| 1 | Answer from a file I share | "What's the sample rate in this header?" | 1 |
| 2 | Find something in a folder | "Which script makes figure 3?" | 2 |
| 3 | Small edit | "Change the units in this column from psi to kPa." | 3 |
| 4 | Multi-step | "Write a script to plot this CSV, run it, check the axis labels." | 3 |
| 5 | A real task | Your own | 3 |

`/bench new` asks for each kind in turn: what you will ask, which files it needs, the careful level it runs at, how you will judge the answer, and an optional automatic check. Skip any kind you do not need.

Pi ships two example ladders with their own small files: lab data basics (a header, CSV files, plotting scripts) and engineering test records (a table of beam tests with gaps and a wrong date). Run them as they are, or copy one with `/bench example` and change it.

## How a run works

- **On a copy.** Each task starts in a fresh copy of the project folder, or of the ladder's own files if it brings them. Pi leaves out `.git`, `node_modules`, Python environments, and symbolic links, and refuses folders over 200 MB. Your real files are never touched. At careful level 4, commands the agent runs can still reach other folders by their full path; use level 3 when that matters.
- **At the ladder's levels.** Before a run, `/bench` asks whether to run each task at its own careful level or every task at one level, so you can compare levels. The first benchmark in [guided setup](guided-setup.md) runs the example at its own levels.
- **As its own agent.** The task runs separately from your conversation, with Pi's tools and system prompt, your context files, and the task's careful level, exactly as a normal session would. At level 3 it asks before every change, the same way. Press Escape to stop a task.
- **You grade.** Pi shows the answer, the automatic checks, how you said to judge it, and where its files are. You pick pass, partial, or fail. Pi never grades its own work, because a weak model grading itself is exactly the failure a benchmark should expose.
- **Recorded.** Every graded run records the time, the steps (tool calls), the tokens, the model, the effort, the careful level, and the grade.

Automatic checks help you grade; they never grade for you:

| Check | Passes when |
|---|---|
| `answer-contains` | The answer mentions the text, ignoring case. |
| `file-contains` | A file in the run's folder contains the text afterwards. |
| `file-unchanged` | A file in the run's folder is exactly as it was before. |
| `command` | A command run in the run's folder afterwards exits with the given code. |

Command checks from a project's ladders run only when the project is trusted, since they run code from a file in the project.

## Compare runs

`/bench compare` shows a ladder's latest result for each task under each setup: the model, the effort, and whether tasks ran at the ladder's levels or at one chosen level. The three most recent setups are shown side by side, with totals. After a run, Pi adds the same comparison to the chat. The [expectations card](model-capability.md#what-to-expect) (`/expectations`) includes your latest benchmark results for the connected model.

## Share a ladder with your team

| Where | Who sees it |
|---|---|
| `~/.pi/agent/benchmark/ladders/*.json` | You, in every folder |
| `<project>/.pi/benchmarks/*.json` | Everyone who opens the project, listed alongside their own ladders |
| `~/.pi/agent/benchmark/runs.jsonl` | Your run history, always per user |

Someone experienced writes a ladder from the office's real work and saves it in the project (`/bench new` asks where to save it). Each colleague runs it on their own setup, and their results stay their own.

## Ladder file format

```json
{
  "version": 1,
  "name": "Rig B data checks",
  "description": "Optional, shown before a run",
  "files": { "data/header.txt": "sample_rate = 48000 Hz\n" },
  "tasks": [
    {
      "id": "sample-rate",
      "title": "Sample rate from a header",
      "kind": "answer-from-file",
      "prompt": "@data/header.txt What is the sample rate in this header?",
      "files": ["data/header.txt"],
      "level": 1,
      "judge": "The header says 48000 Hz.",
      "checks": [{ "type": "answer-contains", "text": "48000" }]
    }
  ]
}
```

`kind` is one of `answer-from-file`, `find`, `small-edit`, `multi-step`, or `real`. `files` at the top level is optional: without it, tasks run on a copy of the project folder. A task's `files` are attached to the prompt at careful level 1, where the agent has no tools to open them. Paths must stay inside the folder. Keep each task's `id` when you edit a task, so its runs still compare.

To turn benchmarks off, add `"-builtin:benchmark"` to `extensions` in [settings](settings.md#resources).
