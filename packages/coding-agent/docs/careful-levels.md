# Choose How Careful Pi Is

A careful level decides what Pi may do to your files. It limits what the agent can do, not only when it asks. Pick one with `/careful`; Pi's first-start setup also asks.

| Level | Name | What Pi can do |
|---|---|---|
| 1 | Only what I share | Nothing on its own. It sees only files you attach with `@`. |
| 2 | Look, don't touch | Open, list, and search files. It cannot change, delete, or run anything. |
| 3 | Ask before changing | Look around freely. It asks before every file change and every command that could change something. |
| 4 | It's yours | Change files and run commands without asking. It still asks before dangerous actions. |

New users start at level 2. Move up when Pi's answers are right for tasks you already know the answers to.

## How each level works

At levels 1 and 2, Pi removes the tools it may not use from the model's request and tells the model which ones it has. A weak model therefore does not keep trying a tool and getting refused. If anything calls a removed tool anyway, Pi blocks it. No rule or setting can allow a change at these levels.

At level 1, typing `@` and a file name attaches the file: Pi reads it and adds it to your message. Text files are attached up to 200 KB; images are attached as images.

At level 2, Pi can write a plan you review before switching to level 3 and asking it to carry the plan out.

At levels 2 and 3, reading credentials such as `~/.ssh` keys, cloud credentials, or `.env` files asks first.

At level 3, read-only commands such as `ls`, `cat`, and `git status` run without asking. Everything else asks every time, and Pi does not learn from your answers. Each question says what the step creates, changes, or deletes, and how risky it is. Answer with:

- **Yes, do it**: the step runs.
- **No**: Pi skips it and tries another way.
- **No, and tell it what to do instead**: Pi skips it and follows what you type.
- **Let's talk about it first**: Pi stops and explains what it wanted to do.

At level 4, Pi asks only before dangerous actions: `sudo`, deleting the project or home folder, piping a download into a shell, writing system folders, and changing its own permission settings.

## Settings

| Where | Setting | Effect |
|---|---|---|
| `/careful [1-4]` | | Save the level for future sessions and apply it now. |
| `--careful <1-4\|adaptive>` | | Use a level for this session only. |
| `~/.pi/agent/permissions/config.json` | `"mode": 1-4` or `"adaptive"` | The saved level. |
| `<project>/.pi/permissions.json` | `"maxLevel": 1-4` | The highest level Pi uses in this project. A project can lower the level, never raise it. |

## Adaptive rules for experienced users

`/careful adaptive`, or `"mode": "adaptive"`, switches to rules that learn what you allow. Pi parses each shell command, rates every command it could run from safe to critical, and asks until you allow it. Repeated approvals become suggested or learned rules; critical actions always ask. Manage rules, settings, and statistics with `/permissions`. The picker shows only levels 1 to 4.

An extension that registers its own `/permissions` command replaces Pi's careful levels, so two permission checks never both ask.

## Limits

Careful levels guard against mistakes and over-eager models. They are not a sandbox. At level 3 or 4, approving a command such as `python script.py` lets Pi run code it wrote. See [Run Pi Safely](security.md) for isolation options.

## Run setup again

`/onboarding` runs first-start setup again: connect a model, pick a level, and try a practice question. `/onboarding skip` turns it off. Setup can be paused with Escape and continues where it stopped.

Setup can connect to an address you were given, such as a company gateway or a local server: it adds the endpoint to [`models.json`](models.md#configure-a-compatible-endpoint) and checks the connection with one short request. For a provider account, it opens `/login`.
