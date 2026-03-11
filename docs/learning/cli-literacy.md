# CLI Literacy

You don't need to become an engineer. You need to read a sentence.

That's what a CLI command is. A sentence. Subject, verb, object, modifiers. Once you see the grammar, every command you encounter -- from `gh pr list` to `kubectl get pods` to `npx agent-heart status` -- becomes readable. Not because you memorized it. Because you understand the structure.

This guide gets you there.

---

## What a CLI Actually Is

A CLI -- command-line interface -- is a way to tell your computer to do something by typing instead of clicking. That's it. No magic. No hacking. Just text instead of buttons.

Your computer already has one. On Mac, it's Terminal. On Windows, it's PowerShell. On Linux, it's whatever you want it to be.

When you open it, you see a blank line with a cursor. That's the **prompt**. It's waiting for you to type a command.

Here's the thing most tutorials get wrong: they start by teaching you commands to memorize. That's backwards. You don't memorize sentences in a new language -- you learn the grammar, and then every sentence makes sense.

---

## The Grammar of a Command

Every CLI command follows the same structure:

```
program [flags] [arguments]
```

That's the whole grammar. Three parts.

**Program** -- the tool you're running. Like `gh` (GitHub), `kubectl` (Kubernetes), or `npx` (Node package runner). This is the verb.

**Arguments** -- the thing you're acting on. A file name, a service name, a URL. This is the object.

**Flags** -- modifiers that change behavior. They start with `--` (long form) or `-` (short form). These are the adjectives and adverbs.

### Reading a Real Command

```bash
gh pr list --repo acme/api --state open --json title,url
```

Read it like a sentence:

> "GitHub, list pull requests from the acme/api repo, only open ones, and give me the title and URL in JSON format."

| Part | Role | Plain English |
|---|---|---|
| `gh` | Program | "Hey GitHub CLI" |
| `pr list` | Subcommand | "list pull requests" |
| `--repo acme/api` | Flag + value | "from this specific repo" |
| `--state open` | Flag + value | "only the open ones" |
| `--json title,url` | Flag + value | "formatted as JSON with these fields" |

That's not pseudocode. That's a real command you can run right now if you have `gh` installed.

### Another One

```bash
npx agent-heart exec --service github --tool gh --resource pulls -- gh pr list
```

> "Run agent-heart's exec wrapper, tracking this as a github service call using the gh tool against the pulls resource, and the actual command to run is gh pr list."

The `--` (double dash by itself) is a separator. Everything before it is flags for agent-heart. Everything after it is the command being wrapped.

Once you see the grammar, you can read any command. You don't need to have used the tool before.

---

## The 10 Commands That Cover 80% of Everything

You don't need hundreds of commands. You need about ten.

| Command | What it does | GUI equivalent |
|---|---|---|
| `ls` | List files in a directory | Opening a folder |
| `cd` | Change directory | Clicking into a folder |
| `pwd` | Print where you are | Looking at the folder path in the title bar |
| `cat` | Show a file's contents | Opening a file to read it |
| `cp` | Copy a file | Copy-paste in Finder |
| `mv` | Move or rename a file | Drag or right-click rename |
| `mkdir` | Create a directory | New Folder |
| `rm` | Delete a file | Move to trash (but permanent) |
| `which` | Find where a program lives | "Where is this app installed?" |
| `--help` | Show a command's manual | Pressing the Help button |

That last one is the most important. Every well-built CLI has `--help`. When you're unsure what a command does, add `--help` and it tells you.

```bash
gh --help
gh pr --help
gh pr list --help
```

Each level gives you more specific help. You never need to memorize -- just ask the tool.

---

## The Three Streams

Here's where it gets interesting, and where most beginner guides stop too early. Every command has three channels for communication:

**stdout** (standard output) -- the answer. When you ask `gh pr list`, the list of PRs comes out here. This is the data.

**stderr** (standard error) -- the commentary. Progress bars, warnings, error messages. This is the narration, not the data.

**exit code** -- the verdict. Did it work? `0` means yes. Anything else means no. You never see this directly, but every program returns one.

Why does this matter? Because these three streams are how automation works. When you pipe one command into another, stdout is what flows. When a script checks if a step succeeded, it reads the exit code. When an AI agent runs a command, it reads stdout for the answer and checks the exit code to know if it worked.

```bash
# stdout goes to the file, stderr still shows on screen
gh pr list --json title > prs.json

# Check if the last command succeeded
echo $?
# 0 = yes, anything else = no
```

This is the reason `agent-heart` separates its own messages (stderr) from its data output (stdout). Human-readable status goes one way. Machine-readable data goes another. Both matter. They just serve different readers.

---

## Piping: Connecting Commands Like Legos

The `|` character -- the pipe -- sends one command's stdout into the next command's input. This is the superpower of CLIs. Small tools, chained together.

```bash
# List PRs, then filter for ones by a specific author
gh pr list --json title,author | jq '.[] | select(.author == "eggy")'
```

Two tools. `gh` gets the data. `jq` filters it. Neither tool knows about the other. They just pass text.

This is composability. And it's the reason CLIs outlasted every GUI trend for fifty years. You can connect any tool to any other tool, without anyone designing the integration in advance.

```bash
# Count how many stale runs you have
npx agent-heart status --json | jq '[.[] | select(.status == "stale")] | length'
```

That's agent-heart's status piped into `jq` to count stale runs. One line. No dashboard needed.

---

## Flags You'll See Everywhere

Some flags show up across almost every CLI tool. Recognize these and you're already literate:

| Flag | Meaning | Why it matters |
|---|---|---|
| `--help` | Show usage instructions | Your built-in manual |
| `--version` | Show the tool's version | For troubleshooting |
| `--json` | Output in JSON format | Machine-readable output |
| `--quiet` or `-q` | Suppress extra output | Cleaner for scripts |
| `--verbose` or `-v` | Show more detail | For debugging |
| `--dry-run` | Show what would happen without doing it | Safe preview |
| `--force` or `-f` | Skip confirmation prompts | Use carefully |
| `--output` or `-o` | Specify output format or file | Control where results go |

When you see a new tool for the first time, these flags give you a starting vocabulary.

---

## The Things That Trip People Up

**Silence means success.** When you run `cp file.txt backup/` and nothing happens, that's good. Unix tools don't congratulate you. No output = it worked. This feels wrong coming from GUIs that show confirmation dialogs. You'll get used to it.

**Spaces matter.** `cd my folder` tries to change into a directory called `my` with an argument `folder`. You want `cd "my folder"` (quotes) or `cd my\ folder` (escape the space). Spaces separate arguments. Quotes group them.

**Paths are just addresses.** `/Users/you/Documents/report.txt` is an absolute path -- a full address from the root. `./report.txt` is a relative path -- relative to where you are right now. `~` means your home directory. That's it.

**Tab completion is your friend.** Start typing a file name or command, press Tab, and the shell fills in the rest. Press Tab twice to see all options. This is how experienced CLI users work fast -- not by typing faster, but by typing less.

**Up arrow recalls history.** Press up to get your previous command. Press up again for the one before that. `Ctrl+R` lets you search through your history. You ran that long command ten minutes ago? It's still there.

**You can't break your computer.** The truly dangerous commands (`rm -rf /`) require explicit flags and often root permissions you don't have. Running `ls` in the wrong directory shows you the wrong files. It doesn't delete them. Explore freely.

---

## Reading Commands You Didn't Write

This is the skill that matters most for non-engineers working with agents and automation. You won't write most of the commands you encounter. You'll read them -- in logs, in configs, in agent output, in documentation.

Here's a real config from a Claude Code hooks file:

```json
{
  "type": "command",
  "command": "echo '$TOOL_INPUT' | npx agent-heart hook claude-code --event pre-tool-use"
}
```

Break it down:

1. `echo '$TOOL_INPUT'` -- print the contents of the `TOOL_INPUT` variable
2. `|` -- pipe that output into the next command
3. `npx agent-heart` -- run the agent-heart CLI via npx
4. `hook claude-code` -- use the hook subcommand for Claude Code
5. `--event pre-tool-use` -- specify this is a pre-tool-use event

That's a hook that fires before every tool call, sends the tool's input to agent-heart, and agent-heart records it. You can read that now. You couldn't ten minutes ago.

### Practice: Read These

Try translating each command into plain English before reading the explanation.

```bash
kubectl get pods -n production --field-selector=status.phase=Running
```

> "Kubernetes, show me the pods in the production namespace that are currently running."

```bash
docker build -t acme/api:v2.3.1 .
```

> "Docker, build an image, tag it as acme/api version 2.3.1, using the current directory as the build context."

```bash
npx agent-heart runs --service github --status failed --json | jq '.[].message'
```

> "Show me agent-heart runs for the github service that failed, in JSON format, then extract just the message field from each one."

If you got the gist of those -- even roughly -- you're CLI-literate. The rest is vocabulary, and vocabulary comes with exposure.

---

## From Reading to Modifying

You don't need to write commands from scratch. You need to modify existing ones. That's a much lower bar.

**Change a value:**

```bash
# Original: list PRs from acme/api
gh pr list --repo acme/api

# Modified: list PRs from acme/web instead
gh pr list --repo acme/web
```

**Add a flag:**

```bash
# Original: list PRs
gh pr list --repo acme/api

# Modified: only open ones, in JSON
gh pr list --repo acme/api --state open --json title,url
```

**Remove a flag:**

```bash
# Original: verbose output
npx agent-heart status --verbose

# Modified: just the basics
npx agent-heart status
```

Find a working command. Change one thing. Run it. See what happens. That's the loop.

---

## What to Read Next

- [CLIs and Agents](./clis-and-agents.md) -- Why CLIs are the interface layer for AI agents, and how to build them for your own workflows.
- [Scenarios](../scenarios.md) -- Real agent-heart workflows that put these concepts into practice.
- [Architecture](../architecture.md) -- How agent-heart itself is built, if you want to see the internals.
