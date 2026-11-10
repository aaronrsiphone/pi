# Choose How Careful Pi Is

A careful level decides what Pi may do to your files. It limits what the agent can do, not only when it asks. Pick one with `/careful`.

| Level | Name | What Pi can do |
|---|---|---|
| 1 | Only what I share | Nothing on its own. It sees only files you attach with `@`. |
| 2 | Look, don't touch | Open, list, and search files. It cannot change, delete, or run anything. |
| 3 | Ask before changing | Open, list, and search freely. It asks before every file change and every command. |
| 4 | It's yours | Change files and run commands without asking. |

Pi starts at level 2 until you pick a level. Move up when Pi's answers are right for tasks you already know the answers to.

## How each level works

At levels 1 and 2, Pi removes the tools it may not use from the model's request and tells the model which ones it has. A weak model therefore does not keep trying a tool and getting refused. If anything calls a removed tool anyway, Pi blocks it. No setting can allow a change at these levels.

Pi tells the model the level in three places in its instructions: the first rule, a section describing the level, and, at level 1, the tool list itself. Models used to having tools otherwise try a tool anyway or end their turn without an answer. Asked to save something at level 1 or 2, the model gives the result in its reply and says that `/careful 3` lets it do the step with your approval. If another extension replaces Pi's instructions wholesale, the level's text is added to the end of them.

At level 1, typing `@` and a file name attaches the file: Pi reads it and adds it to your message. Text files are attached up to 200 KB; images are attached as images.

At level 2, Pi can write a plan you review before switching to level 3 and asking it to carry the plan out.

At level 3, Pi opens, lists, and searches files with its own tools without asking. Every other step asks, every time: each file change, each command, and each tool from an extension. Each question shows the command, or the file and the lines it changes. Answer with:

- **Yes, do it**: the step runs.
- **No**: Pi skips it and tries another way.
- **No, and tell it what to do instead**: Pi skips it and follows what you type.
- **Let's talk about it first**: Pi stops and explains what it wanted to do.

At level 4, Pi works as it does without careful levels.

## Settings

| Where | Setting | Effect |
|---|---|---|
| `/careful [1-4]` | | Save the level for future sessions and apply it now. |
| `--careful <1-4>` | | Use a level for this session only. |
| `~/.pi/agent/careful/config.json` | `"level": 1-4` | The saved level. |
| `<project>/.pi/careful.json` | `"maxLevel": 1-4` | The highest level Pi uses in this project. A project can lower the level, never raise it. |

To use the other extensions without careful levels, see [Choose extensions](../README.md#choose-extensions).

## Limits

Careful levels guard against mistakes and over-eager models. They are not a sandbox. At level 3 or 4, approving a command such as `python script.py` lets Pi run code it wrote. See "Run Pi Safely" in pi's documentation for isolation options.
