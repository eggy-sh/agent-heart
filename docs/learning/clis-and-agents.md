# CLIs and Agents

Here's something that surprises people: AI agents don't click buttons.

When Claude Code fixes a bug, it doesn't open VS Code and navigate menus. It runs `git diff`, reads the output, edits a file, runs `npm test`, reads the result. When an agent deploys your service, it runs `kubectl apply`. When it creates a pull request, it runs `gh pr create`.

The agent works in the terminal. Always has.

This matters because if you're managing agents, evaluating their work, or building workflows around them -- you're working with CLIs whether you planned to or not. And the better you understand that interface, the more you can do with it.

---

## Why CLIs Won the Agent Race

GUIs were designed for humans. Buttons, dropdown menus, hover states, confirmation dialogs. All of that assumes someone with eyes and a mouse.

AI agents have neither.

What they do have is the ability to read and produce text. Fast. And CLIs are text in, text out. That's not a coincidence -- it's a fifty-year design principle called the Unix philosophy: write programs that handle text streams, because text is a universal interface.

When a GUI app shows you a list of pull requests, it renders HTML, CSS, images, interactive widgets. When `gh pr list --json title,state` shows you the same list, it returns structured text that any program -- human or AI -- can read and act on.

Three things made CLIs the default agent interface:

1. **Text is native to LLMs.** A language model reading JSON output is doing what it was built to do. A language model interpreting screenshots is fighting against its architecture.

2. **Exit codes are machine-readable verdicts.** Every CLI returns `0` for success or non-zero for failure. An agent can branch its behavior on that single number. GUIs have no equivalent.

3. **CLIs are composable.** Chain them with pipes. Wrap them in scripts. Embed them in hooks. An agent can orchestrate ten CLI tools in sequence without any of those tools knowing about each other.

---

## The CLI Renaissance

CLIs used to be what you used before GUIs existed. Now they're what you use because agents exist.

Every major platform has figured this out:

**GitHub** built `gh` -- a CLI that does everything the GitHub website does, but in a format agents can use. List PRs, create issues, trigger workflows, review code. All text. All pipeable.

**Google** shipped [Google Workspace CLI](https://www.npmjs.com/package/@googleworkspace/cli) with explicit AI agent support. Not a REST API wrapper dressed up for humans. A CLI designed from the start for both humans and agents, with structured JSON output and runtime command discovery.

**Kubernetes** has `kubectl`. **AWS** has `aws`. **Terraform** has `terraform`. **Docker** has `docker`. Every infrastructure tool that matters has a CLI, and that CLI is the primary way agents interact with it.

**Vercel, Railway, Supabase, Stripe** -- the entire modern SaaS stack offers CLIs now. Not as afterthoughts. As first-class interfaces.

The pattern is consistent: companies are building CLIs because they serve two audiences at once. Humans who want efficiency. Agents who need it.

---

## How Agents Actually Use CLIs

When Claude Code runs a command, here's what happens:

1. The agent decides it needs to run `gh pr list --repo acme/api --json title,state`
2. It spawns that command as a subprocess -- same as if you typed it in Terminal
3. It reads stdout for the response data
4. It reads stderr for any warnings or errors
5. It checks the exit code to know if the command succeeded
6. It uses that information to decide what to do next

That's the tool use pattern. The agent has a library of tools -- Bash commands, file operations, web searches -- and it calls them one at a time, reading the results to inform the next step.

This is where observability comes in. If step 3 takes forever (the command hangs), the agent is stuck. If step 5 returns failure (exit code 1), the agent needs to retry or try something else. If the process dies at step 2 (network error, auth failure), you get a silent disappearance.

`agent-heart` wraps this cycle: `lock` before the command, `beat` while it runs, `unlock` when it finishes. Now you can see the lifecycle from the outside.

---

## MCP: The Standard That Made It Official

MCP -- Model Context Protocol -- is Anthropic's open standard for connecting AI agents to external tools. Think of it as USB-C for AI: a standardized way to plug any tool into any agent.

Here's the part that matters for this discussion: **MCP servers are CLI programs.**

When you configure an MCP server, you specify a command:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/files"]
    }
  }
}
```

That's `npx` running a Node package. It communicates over stdin and stdout -- the same text streams every CLI uses. The "protocol" is JSON-RPC messages flowing through those streams.

Over 50 applications now support MCP: Claude Code, Claude Desktop, ChatGPT, Cursor, VS Code Copilot, Amazon Q, and dozens more. Thousands of community-built MCP servers exist for Slack, Google Drive, databases, Sentry, and virtually every major service.

The entire ecosystem is built on the CLI paradigm. If you understand stdin, stdout, and how a command-line program works, you understand the foundation of how modern AI agents interact with the world.

---

## From User to Builder

Here's where it gets practical. You don't need to be an engineer to build a CLI. You need a problem that repeats and a willingness to automate it.

### Level 1: Shell Scripts

A shell script is a text file that runs commands in sequence. That's all.

```bash
#!/bin/bash
# deploy.sh -- deploy the latest version

echo "Building..."
npm run build

echo "Pushing image..."
docker push acme/api:latest

echo "Deploying..."
kubectl apply -f k8s/production.yaml

echo "Done."
```

Save it as `deploy.sh`, run `chmod +x deploy.sh`, and now `./deploy.sh` runs all four steps. You just built a CLI.

Wrap it with agent-heart and you get lifecycle tracking for free:

```bash
npx agent-heart exec --service deploy --tool bash --resource production -- ./deploy.sh
```

### Level 2: Parameterized Scripts

Add arguments so the script works for different inputs:

```bash
#!/bin/bash
# deploy.sh -- deploy a specific version
VERSION=$1
ENVIRONMENT=$2

echo "Deploying version $VERSION to $ENVIRONMENT..."
docker push "acme/api:$VERSION"
kubectl apply -f "k8s/$ENVIRONMENT.yaml"
```

Now `./deploy.sh v2.3.1 production` deploys that specific version to that specific environment. Same script, different inputs.

### Level 3: Real CLIs with Frameworks

When your scripts outgrow bash -- when you need flags, help text, validation, structured output -- you reach for a CLI framework.

**For Python:** Click or Typer. Write a function, add decorators, get a full CLI with `--help`, argument validation, and tab completion.

```python
import typer

app = typer.Typer()

@app.command()
def deploy(version: str, environment: str = "staging"):
    """Deploy a version to an environment."""
    typer.echo(f"Deploying {version} to {environment}...")
    # ... actual deploy logic

app()
```

```bash
python deploy.py --help
python deploy.py v2.3.1 --environment production
```

**For TypeScript/Node:** Commander or oclif. Same idea -- define commands, flags, and arguments in code. `agent-heart` itself is built with Commander.

**For Go:** Cobra. Used by `kubectl`, `gh`, `docker`, and most of the tools agents already rely on.

The framework handles the boring parts -- parsing flags, generating help text, validating input. You focus on what the tool actually does.

### Level 4: Making Your CLI Agent-Friendly

This is where it comes together. A CLI that agents can use well needs three things:

**Structured output.** Add a `--json` flag. Agents need to parse your output, and JSON is the universal format they understand. Human-readable tables are great for humans. JSON is great for machines. Support both.

```bash
# For humans
my-tool status
# SERVICE   STATUS    DURATION
# github    active    2m 14s
# deploy    stale     12m 3s

# For agents
my-tool status --json
# [{"service":"github","status":"active","duration_ms":134000},
#  {"service":"deploy","status":"stale","duration_ms":723000}]
```

**Clean exit codes.** Return `0` on success, `1` on failure. Agents use this to decide what to do next. A tool that always returns `0` even when it fails is invisible to automation.

**Stderr for humans, stdout for machines.** Progress messages, warnings, decorative output -- send it to stderr. Data and results -- send it to stdout. This way, when an agent pipes your output into `jq` or reads it programmatically, it gets clean data without "Loading... Done!" mixed in.

```bash
# This works because status goes to stderr, data goes to stdout
my-tool fetch --json 2>/dev/null | jq '.items'
```

`agent-heart` follows all three of these patterns. That's not an accident -- it's designed to be used by the same agents it observes.

---

## The Bigger Picture

The barrier between "uses technology" and "builds technology" is collapsing. And CLIs are the seam where that's happening.

Five years ago, building a CLI meant learning a programming language, understanding process management, handling edge cases. Today, an AI agent can help you write one. You describe what you want, the agent writes the code, you test it, iterate, ship it.

The loop looks like this:

1. You have a workflow you repeat manually
2. You describe it to an AI agent
3. The agent writes a script or CLI
4. You wrap it with `agent-heart` so you can see when it runs and whether it succeeds
5. Other agents can now call your CLI as a tool

That last step is the interesting one. Your CLI becomes a building block. Other agents can discover it, call it, chain it with other tools. The same composability that made Unix pipes powerful in 1973 makes agent tool chains powerful now.

You don't need to be an engineer to build that. You need to understand the grammar, the streams, and the lifecycle. The rest is iteration.

---

## What to Read Next

- [CLI Literacy](./cli-literacy.md) -- If you skipped ahead, go back for the fundamentals. The grammar model, the three streams, and how to read any command.
- [Scenarios](../scenarios.md) -- Real workflows showing CLIs and agent-heart in action together.
- [Why Agent Observability](../why-agent-observability.md) -- The market context for why this all matters now.
