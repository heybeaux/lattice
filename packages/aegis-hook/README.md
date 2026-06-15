# @heybeaux/aegis-hook

A [Claude Code](https://docs.claude.com/en/docs/claude-code) **PreToolUse** hook that runs the [Aegis](../aegis) governance engine live on every tool call. Before Claude Code executes a tool, it pipes the call's JSON to this hook on stdin. The hook maps that payload into an Aegis `ToolCall`, evaluates the bundled rule packs (bash / file / injection / pii / secrets), and signals the verdict back via the exit-code contract below.

## Exit-code contract

Claude Code reads the hook's **exit code** to decide what to do, and feeds whatever the hook prints to **stderr** back to the model as the block reason.

| Aegis verdict | Exit code | stderr | Effect in Claude Code |
| ------------- | --------- | ------ | --------------------- |
| `deny`        | `2`       | reason (`[Aegis DENY] …`) | Tool call is **blocked**; reason returned to the model |
| `ask`         | `2`       | reason (`[Aegis ASK] …`)  | Blocked-with-reason — PreToolUse has no native "ask", so the model/human must reconsider |
| `allow`       | `0`       | empty  | Tool call proceeds |
| empty / unparseable stdin, or any hook error | `0` | breadcrumb | **Fail-open** — a hook fault never bricks the session |

Exit `0` = allow, exit `2` = block. Any other nonzero is treated by Claude Code as a non-blocking error.

## Install

```bash
aegis-hook install                       # writes .claude/settings.json in cwd
aegis-hook install <settingsPath> <bin>  # explicit paths
```

This writes the **correct nested schema** into `settings.json`, merging into any existing config (other keys and other PreToolUse matchers are preserved; installing twice is idempotent):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "/abs/path/to/dist/cli.js" }
        ]
      }
    ]
  }
}
```

## Why the nested schema matters

The `matcher` + `hooks: [{ type, command }]` nesting is **mandatory**. AutoHarness shipped a flat `{ type, command }` array under `PreToolUse` — that schema **never fires**, so the harness silently governed nothing. This package writes the nested matcher shape that Claude Code actually invokes, and merges rather than clobbers so it composes with hooks you already have.

## Programmatic API

```ts
import { toToolCall, loadAllPacks, verdictToExit, installHook } from '@heybeaux/aegis-hook';
```

All four are pure/testable: `toToolCall` (payload → `ToolCall`), `loadAllPacks` (compile the shipped rule packs), `verdictToExit` (`Evaluation` → `{ code, stderr }`), and `installHook` (merge the hook into a settings.json path).
