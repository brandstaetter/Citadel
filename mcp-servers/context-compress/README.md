# context-compress MCP server

Provides `smart_read` and `smart_bash` tools that compress large file reads and
command outputs before they land in Claude's context window.

## Why

Context rot degrades all models as context grows (Morph, 2026). Raw file reads
and verbose command outputs are the primary blowout vectors in long campaign
sessions. This server intercepts those operations at the source, returning
structure instead of raw bytes.

## Compression tiers

| Output size | Strategy |
|---|---|
| < 300 lines (read) / < 100 lines (bash) | Full content -- no compression |
| 300-1000 lines / 100-500 lines | Head + tail + structural index |
| > 1000 lines / > 500 lines | Head + tail + index + section guide |

No LLM call needed -- compression uses structural heuristics (function/class
names, error lines, section headings).

## Required project-root boundary

`smart_read` requires `CITADEL_PROJECT_ROOT` to be set to one absolute,
existing project directory when the server starts. It fails closed when that
setting is missing, relative, or invalid. Relative read paths resolve against
that fixed root; absolute paths are accepted only when their canonical target
is still inside it.

Containment is checked again after resolving symlinks and Windows junctions.
The server also refuses every `.env*` variant and common credential, private
runtime-state, private-key, and keystore files. Protected names are omitted
from directory listings.

## Enable for a fixed project

Add to `~/.claude/settings.json`:

```json
"mcpServers": {
  "context-compress": {
    "command": "node",
    "args": ["/absolute/path/to/Citadel/mcp-servers/context-compress/index.js"],
    "env": {
      "CITADEL_PROJECT_ROOT": "C:/absolute/path/to/project"
    }
  }
}
```

A global registration is still bound to that one project root. Use separate
named registrations when you intentionally need the server for multiple
projects; do not omit the root and rely on the process working directory.

## Enable for one project only

Add the same server entry to `.claude/settings.json` in the project root
instead, with `CITADEL_PROJECT_ROOT` set to that project's absolute path.

## Usage

Claude will see `smart_read` and `smart_bash` as available tools. Prompt Claude
to prefer them for large-file reads and verbose commands:

> "When reading files that may be large, use smart_read. For commands that produce
> verbose output (typecheck, build, find, grep across many files), use smart_bash."

Or add to the project's CLAUDE.md (no global instruction needed if Claude Code
loads the tool description, which includes the "Use instead of..." guidance).

## When NOT to use

- Targeted reads where you know offset/limit: use native Read
- Short commands: use native Bash
- Any operation where you need exact raw output (e.g. checking a specific line)

## Security boundary

The read confinement above applies to `smart_read`. `smart_bash` remains an
explicit shell-execution capability, equivalent in trust to granting a native
shell tool; only enable this opt-in server for trusted local workflows.

## No dependencies

Pure Node.js, no npm install required.
