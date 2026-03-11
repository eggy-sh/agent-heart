# Framework Integrations

This reference covers integrating agent-heart with popular agentic frameworks
that don't have built-in hook support. The pattern is the same across all of
them: wrap tool execution with agent-heart lifecycle events.

---

## LangChain / LangGraph

LangChain's callback system is the natural integration point. Create a custom
callback handler that sends lifecycle events to agent-heart.

### Callback Handler

```python
"""agent_pulse_callback.py — LangChain callback handler for agent-heart."""

import subprocess
import json
import time
from typing import Any, Dict, List, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler


class AgentPulseCallbackHandler(BaseCallbackHandler):
    """Track LangChain tool calls via agent-heart lifecycle events."""

    def __init__(self, service_prefix: str = "langchain", session_id: Optional[str] = None):
        self.service_prefix = service_prefix
        self.session_id = session_id or f"langchain-{int(time.time())}"
        self._active_runs: Dict[str, str] = {}  # run_id -> service_name

    def _pulse_cmd(self, args: List[str]) -> None:
        """Fire-and-forget agent-heart CLI call."""
        try:
            subprocess.run(
                ["npx", "agent-heart", "hook", "generic"] + args,
                capture_output=True,
                timeout=5,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    def on_tool_start(
        self,
        serialized: Dict[str, Any],
        input_str: str,
        *,
        run_id: UUID,
        parent_run_id: Optional[UUID] = None,
        **kwargs: Any,
    ) -> None:
        tool_name = serialized.get("name", "unknown")
        service = f"{self.service_prefix}/{tool_name}"
        self._active_runs[str(run_id)] = service

        self._pulse_cmd([
            "--action", "lock",
            "--service", service,
            "--tool", tool_name,
            "--session", self.session_id,
            "--command", input_str[:500],
            "--message", f"LangChain tool call: {tool_name}",
        ])

    def on_tool_end(
        self,
        output: str,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "0",
            "--message", f"Tool completed successfully",
        ])

    def on_tool_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "1",
            "--message", str(error)[:200],
        ])

    def on_chain_start(
        self,
        serialized: Dict[str, Any],
        inputs: Dict[str, Any],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        chain_name = serialized.get("name", serialized.get("id", ["unknown"])[-1])
        service = f"{self.service_prefix}/chain/{chain_name}"
        self._active_runs[str(run_id)] = service

        self._pulse_cmd([
            "--action", "lock",
            "--service", service,
            "--tool", chain_name,
            "--session", self.session_id,
            "--message", f"Chain started: {chain_name}",
        ])

    def on_chain_end(
        self,
        outputs: Dict[str, Any],
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/chain/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "0",
        ])

    def on_chain_error(
        self,
        error: BaseException,
        *,
        run_id: UUID,
        **kwargs: Any,
    ) -> None:
        service = self._active_runs.pop(str(run_id), f"{self.service_prefix}/chain/unknown")

        self._pulse_cmd([
            "--action", "unlock",
            "--service", service,
            "--session", self.session_id,
            "--exit-code", "1",
            "--message", str(error)[:200],
        ])
```

### Usage

```python
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_tool_calling_agent
from agent_pulse_callback import AgentPulseCallbackHandler

pulse_handler = AgentPulseCallbackHandler(
    service_prefix="langchain",
    session_id="my-session-001",
)

llm = ChatOpenAI(model="gpt-4o", callbacks=[pulse_handler])
agent = create_tool_calling_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, callbacks=[pulse_handler])

result = executor.invoke({"input": "What PRs are open?"})
```

### LangGraph

For LangGraph, attach the callback at the graph execution level:

```python
from langgraph.graph import StateGraph
from agent_pulse_callback import AgentPulseCallbackHandler

pulse = AgentPulseCallbackHandler(service_prefix="langgraph")

graph = StateGraph(MyState)
# ... build graph ...
app = graph.compile()

result = app.invoke(initial_state, config={"callbacks": [pulse]})
```

---

## CrewAI

CrewAI tools have a `_run` method. Wrap it with agent-heart tracking.

### Tool Wrapper

```python
"""agent_pulse_crewai.py — CrewAI tool wrapper with agent-heart tracking."""

import subprocess
import functools
from typing import Any


def tracked_tool(service_prefix: str = "crewai", session_id: str = "crewai-session"):
    """Decorator that wraps a CrewAI tool's _run with agent-heart tracking."""

    def decorator(tool_class):
        original_run = tool_class._run

        @functools.wraps(original_run)
        def wrapped_run(self, *args, **kwargs):
            tool_name = getattr(self, "name", type(self).__name__)
            service = f"{service_prefix}/{tool_name}"

            # Lock
            try:
                subprocess.run(
                    ["agent-heart", "hook", "generic",
                     "--action", "lock",
                     "--service", service,
                     "--tool", tool_name,
                     "--session", session_id,
                     "--message", f"CrewAI tool: {tool_name}"],
                    capture_output=True, timeout=5,
                )
            except Exception:
                pass

            # Execute
            try:
                result = original_run(self, *args, **kwargs)

                # Unlock success
                try:
                    subprocess.run(
                        ["agent-heart", "hook", "generic",
                         "--action", "unlock",
                         "--service", service,
                         "--session", session_id,
                         "--exit-code", "0"],
                        capture_output=True, timeout=5,
                    )
                except Exception:
                    pass

                return result

            except Exception as e:
                # Unlock failure
                try:
                    subprocess.run(
                        ["agent-heart", "hook", "generic",
                         "--action", "unlock",
                         "--service", service,
                         "--session", session_id,
                         "--exit-code", "1",
                         "--message", str(e)[:200]],
                        capture_output=True, timeout=5,
                    )
                except Exception:
                    pass
                raise

        tool_class._run = wrapped_run
        return tool_class

    return decorator
```

### Usage

```python
from crewai import Agent, Task, Crew
from crewai_tools import SerperDevTool
from agent_pulse_crewai import tracked_tool

# Apply tracking to a tool
@tracked_tool(service_prefix="crewai", session_id="research-crew")
class TrackedSerperTool(SerperDevTool):
    pass

search_tool = TrackedSerperTool()

agent = Agent(
    role="Researcher",
    tools=[search_tool],
    # ...
)

crew = Crew(agents=[agent], tasks=[task])
result = crew.kickoff()
```

---

## OpenAI Agents SDK

The OpenAI Agents SDK uses function tools. Wrap the function execution with
agent-heart tracking.

### Function Tool Wrapper

```python
"""agent_pulse_openai.py — OpenAI Agents SDK wrapper with agent-heart."""

import subprocess
import functools
from typing import Callable, Any


def pulse_tracked(
    service_prefix: str = "openai-agent",
    session_id: str = "openai-session",
    resource_kind: str | None = None,
):
    """Decorator for OpenAI agent function tools with agent-heart tracking."""

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            tool_name = func.__name__
            service = f"{service_prefix}/{tool_name}"

            # Lock
            _pulse_fire([
                "--action", "lock",
                "--service", service,
                "--tool", tool_name,
                "--session", session_id,
                *(["--metadata", f'{{"resource_kind":"{resource_kind}"}}'] if resource_kind else []),
            ])

            try:
                result = await func(*args, **kwargs)

                _pulse_fire([
                    "--action", "unlock",
                    "--service", service,
                    "--session", session_id,
                    "--exit-code", "0",
                ])

                return result

            except Exception as e:
                _pulse_fire([
                    "--action", "unlock",
                    "--service", service,
                    "--session", session_id,
                    "--exit-code", "1",
                    "--message", str(e)[:200],
                ])
                raise

        return wrapper
    return decorator


def _pulse_fire(args: list[str]) -> None:
    try:
        subprocess.run(
            ["npx", "agent-heart", "hook", "generic"] + args,
            capture_output=True, timeout=5,
        )
    except Exception:
        pass
```

### Usage

```python
from agents import Agent, Runner, function_tool
from agent_pulse_openai import pulse_tracked

@function_tool
@pulse_tracked(service_prefix="openai-agent", resource_kind="weather")
async def get_weather(city: str) -> str:
    """Get current weather for a city."""
    # ... implementation
    return f"72°F in {city}"

agent = Agent(
    name="weather-assistant",
    tools=[get_weather],
)

result = await Runner.run(agent, "What's the weather in SF?")
```

---

## Anthropic Agent SDK (Claude Agent SDK)

The Anthropic Agent SDK uses tool callbacks. Integration follows the same
wrapper pattern.

### Tool Wrapper

```typescript
// agent-heart-anthropic.ts — Anthropic Agent SDK wrapper

import { PulseClient } from "agent-heart";

const pulse = new PulseClient({ sessionId: "anthropic-agent-session" });

/**
 * Wrap a tool handler function with agent-heart tracking.
 */
export function trackedTool<TInput, TOutput>(
  toolName: string,
  handler: (input: TInput) => Promise<TOutput>,
  options?: { servicePrefix?: string; resourceKind?: string }
): (input: TInput) => Promise<TOutput> {
  const prefix = options?.servicePrefix ?? "anthropic-agent";
  const service = `${prefix}/${toolName}`;

  return async (input: TInput): Promise<TOutput> => {
    const { run_id } = await pulse.lock(service, {
      tool_name: toolName,
      resource_kind: options?.resourceKind,
      message: `Tool call: ${toolName}`,
    });

    try {
      const result = await handler(input);

      await pulse.unlock(service, {
        run_id,
        exit_code: 0,
        message: `Tool completed: ${toolName}`,
      });

      return result;
    } catch (error) {
      await pulse.unlock(service, {
        run_id,
        exit_code: 1,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
}
```

### Usage

```typescript
import { trackedTool } from "./agent-heart-anthropic";

const getWeather = trackedTool(
  "get_weather",
  async (input: { city: string }) => {
    // ... fetch weather
    return { temp: 72, city: input.city };
  },
  { resourceKind: "weather" }
);

// Use with Anthropic Agent SDK tool definitions
```

---

## Generic Shell-Based Integration

For any framework that can shell out, use the `agent-heart exec` wrapper or
the generic hook CLI. This works for Python, Ruby, Go, Rust, or any language.

### exec wrapper (simplest)

```bash
npx agent-heart exec \
  --service my-agent/github \
  --tool gh \
  --resource pulls \
  -- gh pr list --repo myorg/myrepo
```

### Generic hook CLI

```bash
# Before tool execution
npx agent-heart hook generic \
  --action lock \
  --service my-agent/tool \
  --tool mytool \
  --command "the command being run" \
  --session my-session-id

# After tool execution
npx agent-heart hook generic \
  --action unlock \
  --service my-agent/tool \
  --exit-code 0 \
  --session my-session-id
```

### Python subprocess wrapper

```python
import subprocess
import json


def run_with_pulse(
    command: list[str],
    service: str,
    tool: str | None = None,
    resource: str | None = None,
    session_id: str | None = None,
) -> subprocess.CompletedProcess:
    """Run a command wrapped with agent-heart observability."""
    pulse_args = [
        "npx", "agent-heart", "exec",
        "--service", service,
    ]
    if tool:
        pulse_args.extend(["--tool", tool])
    if resource:
        pulse_args.extend(["--resource", resource])
    if session_id:
        pulse_args.extend(["--session", session_id])

    pulse_args.append("--")
    pulse_args.extend(command)

    return subprocess.run(pulse_args, capture_output=True, text=True)


# Usage
result = run_with_pulse(
    ["gh", "pr", "list", "--repo", "myorg/myrepo"],
    service="my-agent/github",
    tool="gh",
    resource="pulls",
    session_id="session-001",
)
```

### Node.js/TypeScript SDK

For deeper integration without shelling out, use `PulseClient` directly:

```typescript
import { PulseClient } from "agent-heart";

const pulse = new PulseClient({ sessionId: "my-session" });

// trackRun handles the full lifecycle automatically
const result = await pulse.trackRun(
  "my-agent/github",
  async (runId) => {
    // Your tool execution here
    const output = await execGitHubCommand("pr list");
    return output;
  },
  {
    tool_name: "gh",
    resource_kind: "pulls",
    metadata: { heartbeat_interval_ms: "10000" },
  }
);
```

`trackRun` is the recommended programmatic approach. It:
- Sends `lock` before your function runs
- Sends periodic `beat` while it's running
- Sends `unlock` with exit code 0 on success
- Sends `unlock` with exit code 1 and error message on failure
- Cleans up the heartbeat interval in all cases
