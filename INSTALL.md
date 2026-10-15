# Install Citadel
<!-- citadel:ignore cross-reference -->

The canonical stable installation guide. Citadel supports four runtimes:

| Runtime | How Citadel installs |
|---|---|
| Claude Code | Native plugin marketplace |
| OpenAI Codex | Native plugin marketplace |
| OpenCode | `scripts/install.js --runtime opencode` from a verified release (since v1.4.0) |
| GitHub Copilot CLI | `scripts/install.js --runtime copilot`, native Agent Plugin (not yet in a tagged release) |

GitHub Releases remain the version and high-assurance artifact boundary; source
`main` is development-only, and the public npm package named `citadel` is
unrelated to this project.

## Prerequisites

- A supported runtime: **Claude Code**, **OpenAI Codex**, **OpenCode** 1.18.x,
  or **GitHub Copilot CLI**.
- **[Node.js 22+](https://nodejs.org/)**: a supported LTS release required for hooks and scripts.
- A git repository you want Citadel to manage.

Authentication depends on the runtime you use. Citadel layers on top of the runtime you already have configured. There is no build step and no `npm install`; Citadel runs directly on Node.js.

## Recommended: Native Plugin Marketplace

This path applies to Claude Code and Codex. OpenCode and Copilot CLI have no
marketplace install for Citadel; use the [manual install](#manual-install) and
then the [OpenCode](#opencode-plugin) or
[Copilot](#github-copilot-native-plugin) section.

The commands below pin `v1.4.4`. If that tag is not present on
[GitHub Releases](https://github.com/SethGammon/Citadel/releases), stop rather
than substituting floating `main`.

### OpenAI Codex

```bash
codex plugin marketplace add SethGammon/Citadel --ref v1.4.4
codex plugin add citadel@citadel-local
```

Start a new Codex task and review the installed hooks through `/hooks` when
Codex asks. That native trust decision is intentional; Citadel must not bypass
or duplicate it.

### Claude Code

```bash
claude plugin marketplace add SethGammon/Citadel@v1.4.4 --scope local
claude plugin install citadel@citadel-local --scope local
```

Use `/reload-plugins` if Claude Code is already open. Local scope makes the
plugin available only for you in this repository.

### Prefer to have your agent install it?

Open the target repository in Claude Code or Codex and paste this:

<!-- This prompt is copied verbatim from README.md. Keep the two copies identical. -->

```text
Citadel is an open-source operating layer for Claude Code and OpenAI Codex. It
adds one /do entry point, repository-local state that survives sessions,
guarded multi-step workflows, and reviewable evidence with explicit Needs You
and Resume boundaries.

Install Citadel v1.4.4 from https://github.com/SethGammon/Citadel using this
runtime's native plugin marketplace, then enable it for this repository. Use
project-local defaults and preserve removal evidence for every change. Do not clone main or change shared
configuration, sandbox settings, permissions, or user-wide settings without
asking me.

Only interrupt me for a platform-required trust or reload action, or for a real
configuration conflict. Verify the result, then tell me the single next action.
```

The prompt supplies the product definition, official source, exact version,
scope, safety boundary, and completion condition. The agent should use the
platform installer rather than recreate a package manager from prose.

## Manual Install

Run the commands below from the project you want Citadel to manage. Do not run
them from the extracted Citadel directory unless Citadel itself is the target.

### Acquire and verify a stable release

From [GitHub Releases](https://github.com/SethGammon/Citadel/releases), choose
one explicit `vX.Y.Z` tag and download all three matching assets into the same
directory:

- `citadel-vX.Y.Z.tar.gz`
- `citadel-vX.Y.Z.tar.gz.manifest.json`
- `citadel-vX.Y.Z.tar.gz.sha256`

Before extraction, compute the archive SHA-256 and require it to match both the
sidecar and `artifact.sha256` in the external manifest. For example, on
PowerShell:

```powershell
$citadelArchive = (Resolve-Path '.\citadel-vX.Y.Z.tar.gz').Path
$citadelActual = (Get-FileHash $citadelArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$citadelSidecar = ((Get-Content "${citadelArchive}.sha256").Trim() -split '\s+')[0].ToLowerInvariant()
$citadelManifest = (Get-Content "${citadelArchive}.manifest.json" -Raw | ConvertFrom-Json).artifact.sha256.ToLowerInvariant()
if ($citadelActual -ne $citadelSidecar -or $citadelActual -ne $citadelManifest) { throw 'Citadel release digest mismatch' }
```

After that check succeeds, Windows users can extract, verify, and enter the
supported governed lifecycle without translating Bash paths:

```powershell
tar -xzf "$citadelArchive"
$env:CITADEL_ROOT = (Resolve-Path '.\citadel-X.Y.Z').Path
node "$env:CITADEL_ROOT\scripts\release-verify.js" "$citadelArchive" --ref vX.Y.Z --version X.Y.Z

Set-Location 'C:\absolute\path\to\target-project'
node "$env:CITADEL_ROOT\scripts\adopt.js" plan "$env:CITADEL_ROOT" --target . --project-runtime codex --out ..\citadel-adoption.plan.json --json
node "$env:CITADEL_ROOT\scripts\adopt.js" apply ..\citadel-adoption.plan.json --confirm <plan-token> --json
node "$env:CITADEL_ROOT\scripts\adopt.js" doctor --target . --json
node "$env:CITADEL_ROOT\scripts\install.js" --runtime codex --install
```

Use `--project-runtime claude` plus the Claude installer flags shown below when
Claude Code is the intended runtime. For OpenCode, skip `adopt.js` and run the
[OpenCode installer](#opencode-plugin). For Copilot CLI, see
[GitHub Copilot native plugin](#github-copilot-native-plugin).

On Linux or macOS, verify the sidecar with `sha256sum -c` (or compare
`shasum -a 256` output on macOS), then independently compare the result with
the external manifest. A missing asset or mismatch is a blocked install.

Optionally verify GitHub's signed provenance before running release code:

```bash
gh attestation verify citadel-vX.Y.Z.tar.gz -R SethGammon/Citadel
gh attestation verify citadel-vX.Y.Z.tar.gz.manifest.json -R SethGammon/Citadel
gh attestation verify citadel-vX.Y.Z.tar.gz.sha256 -R SethGammon/Citadel
```

On Linux or macOS, extract the archive only after those checks. It contains one
`citadel-X.Y.Z/` root. Point `CITADEL_ROOT` at that directory, then run its
structural verifier:

```bash
tar -xzf citadel-vX.Y.Z.tar.gz
CITADEL_ROOT=/absolute/path/to/citadel-X.Y.Z
node "$CITADEL_ROOT/scripts/release-verify.js" citadel-vX.Y.Z.tar.gz \
  --ref vX.Y.Z --version X.Y.Z
```

The verifier requires the archive, external manifest, sidecar, embedded
manifest, file list, and hashes to agree.

### Development source (not a stable install)

Contributors may use
`git clone --branch main https://github.com/SethGammon/Citadel.git` for source
testing. Floating `main` has no immutable release boundary and must not be used
or described as a stable install. `npm install citadel`, `npx citadel`, and npm
registry tarballs are unsupported acquisition paths.

### Create the governed project adoption

From the target repository, create a saved no-write plan:

```bash
node "$CITADEL_ROOT/scripts/adopt.js" plan "$CITADEL_ROOT" \
  --target . \
  --project-runtime codex \
  --out ../citadel-adoption.plan.json \
  --json
```

Write the plan outside the target repository. Creating a plan inside the target
changes the target after its preflight snapshot and invalidates apply with
`TARGET_DRIFT`.

Use `--project-runtime claude` or `--project-runtime copilot` for a single
runtime. Use `--project-runtime both` only when Claude and Codex projections
are both intentional, and `--project-runtime all` to add Copilot as well.
OpenCode is not a governed-adoption runtime; it uses its own installer. Review the
owned/shared footprint and every external registration whose removal evidence
is `unknown`. Then apply the exact saved plan:

```bash
node "$CITADEL_ROOT/scripts/adopt.js" apply ../citadel-adoption.plan.json \
  --confirm <plan-token> \
  --json

node "$CITADEL_ROOT/scripts/adopt.js" doctor --target . --json
```

Planning writes only when `--out` is explicitly requested. Apply rechecks the
target, source, pre-images, and plan digest; a changed input is rejected.

The runtime-specific scripts below are the one-major bootstrap compatibility
adapters for marketplace/plugin registration. They are still useful where the
runtime has no project-scoped registration API, but their external effects
remain `unknown` until observed. Receipt-owned project files, update, rollback,
restore, and leave use `scripts/adopt.js`.

`scripts/install.js` is a dispatcher: `--runtime claude` runs
`scripts/claude-install.js` and `--runtime codex` runs
`scripts/codex-install.js`; `--runtime opencode` runs
`scripts/opencode-install.js`; `--runtime copilot` runs
`scripts/copilot-install.js`. The commands below use the dispatcher; the
runtime-specific scripts accept the same flags if you prefer to call them
directly.

Installer output follows a shared versus machine-local contract. `AGENTS.md`,
`CLAUDE.md`, `.citadel/project.md`, `.mcp.json`, and project policy files are
shared and use relative paths. Runtime settings, delegates, projections, and
checkout pointers are machine-local and are protected in `.git/info/exclude`.
Use `--dry-run --json` to review `outputs`, `inventory`, `diagnostics`, and
`machineLocalExcludes`; a `DUPLICATE_CITADEL_REGISTRATION` diagnostic names the
roots that need reconciliation.

### OpenCode plugin

OpenCode has no command hooks. Citadel installs an in-process plugin that runs
the same Node hook scripts and blocks a tool call by throwing before it runs.
Requirements: OpenCode 1.18.x and a real Node.js on `PATH`. OpenCode runs on
Bun, so the plugin looks up Node separately; set `CITADEL_NODE` if it picks the
wrong binary.

From your target project root:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime opencode --dry-run
node "$CITADEL_ROOT/scripts/install.js" --runtime opencode
node "$CITADEL_ROOT/scripts/opencode-readiness-check.js" --project-root .
```

The readiness check exits 0 when the required checks pass. Its last check asks
the real hook to refuse a `.env` read. Add `--strict` to also fail on advisory
gaps.

The installer writes:

| Path | Purpose |
|---|---|
| `.opencode/plugin/citadel.js` | Stub that loads the adapter from `$CITADEL_ROOT` by absolute path |
| `opencode.json` | Merged key by key: `$schema`, `mcp.citadel-state`, and `skills.paths`; user keys are preserved |
| `.opencode/agent/*.md` | Citadel subagents |
| `.opencode/commands/*.md` | Wrappers that pass slash-command arguments into each skill |
| `.citadel/skills/` | Project-local skill projection |
| `.citadel/scripts/` | Delegates that run Citadel utilities from `$CITADEL_ROOT` |

Re-running the installer is idempotent and refreshes the skill projection after
an upgrade. Use `--skip-agents`, `--skip-skills`, or `--skip-guidance` to leave
those surfaces out, and `--overwrite-guidance` only if you want an existing
`AGENTS.md` replaced.

Because the stub points at `$CITADEL_ROOT`, keep the extracted release in a
stable location. If you move it, re-run the installer.

**Restart OpenCode after installing.** It discovers plugins once per process,
so a session that was already running stays ungated. A plugin that fails to
load is silent: OpenCode keeps running with no Citadel hooks. To confirm the
plugin loaded, run `opencode --print-logs --log-level DEBUG` and look for the
`[citadel] hooks ok` line in the startup log.

Known OpenCode limits, all upstream properties rather than Citadel defects:

- The stop event cannot block. Quality-gate findings are delivered on the next
  turn instead of preventing the turn from ending.
- `permission.ask` never fires, so Citadel gates on `tool.execute.before`.
- Shell commands a human types with `!` in the TUI are not gated. Shell
  commands the model issues are gated.

There is no OpenCode uninstall flag yet. To remove Citadel, delete the files in
the table above and remove the `citadel-state` MCP entry and the
`./.citadel/skills` path from `opencode.json`.

### GitHub Copilot native plugin

Copilot CLI support is newer than `v1.4.3` and not yet in a tagged release.
Until one includes it, use a development source checkout as `CITADEL_ROOT`.

From your target project root:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime copilot --install
node "$CITADEL_ROOT/scripts/copilot-readiness-check.js" --project-root .
```

The default integration registers the local `citadel-local` marketplace and
installs the native Agent Plugin. Its generated hooks use `${PLUGIN_ROOT}`, so
the plugin remains relocatable and does not add project-local hook entries.
To migrate an older fallback installation without removing unrelated user
hooks, use `--install --migrate-fallback`.

Use `--fallback` only when native plugins are unavailable. That mode merges
Citadel command hooks into `.github/copilot/settings.local.json`, preserves
unrelated user hooks, and sets `CITADEL_RUNTIME=copilot` on every generated
entry. The fallback file is machine-local because it contains the absolute
path to this Citadel checkout. The installer prevents native and fallback
Citadel hooks from being active together. Use `--uninstall` to remove the
native plugin while preserving project state and user-authored hooks.

Copilot hook crashes fail closed for the two security gates, but Copilot hook
timeouts fail open and are not a security boundary.

#### Copilot subagent models

Shared definitions live in `.citadel/agents/` and declare a model placeholder:
`xlarge`, `large`, `medium`, or `small`. Model mappings are configured separately
in `runtimes/claude-code/agent-settings.json`, `runtimes/copilot/agent-settings.json`,
and `runtimes/codex/agent-settings.json`. Edit the appropriate runtime's `models`
object to change a tier without editing individual agents or generator code.

Archon/Fleet use `large`, the arbiter uses `xlarge`, and validators use `small`.
Consult the runtime settings file for the current model IDs; all four placeholders
are independently configurable. These model IDs must be available to your Copilot account. Named agent calls
should omit a model override; explicit worker calls must resolve placeholders first.
Copilot loads generated definitions from `com.github.copilot/agents/`, selected
by root `plugin.json`. Claude loads the generated `agents/` directory.

After updating the package, start a fresh Copilot session with its `--plugin-dir`
pointing to the updated installation. In `/agents`, inspect `citadel:archon`:
its model should match `models.large` in the Copilot settings file. If it still shows `opus`, check for a stale
plugin path or a project/user agent override. See the
[Copilot custom agent reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#custom-agents-reference).

After editing shared definitions or mappings, run
`node scripts/generate-runtime-agents.js --project-root <project>` in a writable
source checkout. This generates Claude and Copilot plugin agents in the source
checkout and Codex agents in `<project>/.codex/agents/`. The project defaults to
the current directory. Use `--check` to verify all three projections without writing.
The older Codex-only command `node scripts/generate-agent-projections.js --project-root <project>` remains available;
existing Codex project model/effort overrides take precedence over runtime defaults.
Release packaging regenerates plugin agents from the shipped definitions and settings.
`node scripts/generate-copilot-plugin.js --check` verifies Copilot agents and hooks
without writing to the installed source.

#### Copilot interaction mode in a sandbox

Stay in Copilot's standard interactive (manual) mode rather than switching to
Copilot autopilot. For an isolated sandbox session where broad permissions are
intended, enter `/allow-all` in Copilot chat, then run your Citadel commands.
This grants Copilot tool, path, and URL permissions for the session; it does
not remove the sandbox's filesystem or network restrictions.

Autopilot with manual approval automatically denies requests that still need
approval because no interactive response is available. If you are already in
autopilot, press **Shift+Tab** to return to standard interactive mode before
entering `/allow-all`. This concerns Copilot's interaction mode, not Citadel's
`/autopilot` workflow. See [Copilot autopilot permissions](https://docs.github.com/en/copilot/concepts/agents/copilot-cli/autopilot).

#### Enable the plain `/do` command

If Copilot exposes the plugin router as `/citadel:do` but does not recognize
`/do`, add a project-local forwarding skill at `.github/skills/do/SKILL.md`.
Preserve any existing file at that path. Replace `/absolute/path/to/citadel`
below with the installed Citadel root **as seen by Copilot** (for example,
`/opt/agent-sandbox/citadel-local` in an AgentSandbox local-dev installation):

```markdown
---
name: do
description: Invoke the installed Citadel router.
user-invocable: true
---

When invoked, load and follow /absolute/path/to/citadel/skills/do/SKILL.md.
The Citadel plugin root is /absolute/path/to/citadel.
Preserve the complete request following /do, including arguments, flags,
quotes, and line breaks. Apply the canonical router's activation checks and
routing instructions. Do not invoke this alias recursively. If the canonical
skill is unavailable, report that error rather than inventing instructions.
```

Inside Copilot chat, run `/skills reload`, then test `/do status`.
This alias needs only project write access: it neither modifies the installed
Citadel source nor installs hooks. It also works when `/skills add` cannot
persist its registration in a sandbox. `/citadel:do` remains available.
The absolute path is machine-specific; update it if the installation moves.

### Claude Code compatibility installer

From your target project root:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime claude --install --scope local
claude
```

The compatibility installer validates the marketplace, registers the extracted
release, and installs **Citadel Harness** in local scope. Native plugin hooks are
loaded by Claude Code; direct writes to `.claude/settings.json` require the
separate advanced `--install-hooks` flag.

Alternative manual install from inside Claude Code:

```text
/plugin marketplace add /absolute/path/to/citadel-X.Y.Z
/plugin install citadel@citadel-local --scope local
```

For a one-session trial without registering the marketplace:

```bash
claude --plugin-dir "$CITADEL_ROOT"
```

To preview what the installer would write without changing anything:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime claude --install --dry-run --json
```

The installer output names every Claude-specific external enable step and its
observed or unknown status.

### OpenAI Codex compatibility installer

From your target project root:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime codex --install
codex
```

This command validates the package, registers the extracted release as a local
marketplace, and runs `codex plugin add citadel@citadel-local`. It does not
generate fallback project files or change Codex sandbox settings. Start a new
task and review Citadel through `/hooks`.

To preview what the installer would write without changing anything:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime codex --dry-run --json
```

For a project where plugin installation is unavailable, use `--fallback` explicitly; it cannot be combined with plugin installation. `scripts/install-hooks-codex.js` is a legacy fallback-only hook path and must not be run alongside plugin-bundled hooks. Migration preserves unowned or modified project files for review.

The installer output names every Codex-specific external enable step and its
observed or unknown status.

## First Run

Start a fresh session in your project (restart OpenCode if it was already
running) and give Citadel a real request:

```text
/do review README.md
```

First-use state initializes automatically. Citadel reports `Needs You` only
when the platform requires trust/reload or when an existing or shared setting
would change. `/do setup` remains available later for optional profile, bundle,
integration, and guided-tour customization; it is not an installation gate.

### Setup modes

`/do setup` (without flags) opens with a mode selection:

- **Recommended**: detects the stack, previews Standard with Core +
  Persistence, applies only after the setup approval, reconciles the effective
  receipt, installs only bundle-owned hooks, and runs a bounded live demo.
- **Full Tour**: everything in Recommended, then offers separate plan/apply
  decisions for Parallel and Operations. Delivery remains off unless explicitly
  selected and supported.
- **Express**: zero questions after invocation. It applies the Standard Core +
  Persistence baseline, reconciles the effective receipt, installs the bounded
  hook projection, and exits.

Run `/do setup --express` to skip mode selection entirely.

### What setup does

In all modes, setup:

1. **Detects your stack and runtime capabilities** without writing project
   state.
2. **Builds the exact schema-v2 config plan** for Standard plus Core and
   Persistence. Recommended shows the plan; Express treats its explicit mode
   selection as approval of that bounded baseline.
3. **Applies and reconciles authority** into `.claude/harness.json` and
   `.citadel/effective-config/<runtime-id>.json`. Stale, malformed, or future receipts block
   non-Core execution.
4. **Installs only hooks owned by effective bundles**. A disabled skill or
   direct route is blocked with its activation plan instead of executing.
5. **Scaffolds project guidance without overwriting user content**.
6. **Runs a bounded live demo** in Recommended and Full Tour modes.

> **Why does the runtime-specific install still matter?**
> Each runtime has its own activation, reload, and hook-trust flow: Claude Code
> and Codex use native marketplaces, Copilot CLI uses a native Agent Plugin, and
> OpenCode loads an in-process plugin at startup. The runtime's own plugin
> remains the authority. Compatibility project projections are advanced
> migration tools, not the default install.

### Route your first task

```text
/do review src/main.ts              # 5-pass code review
/do generate tests for utils        # Tests that actually run
/do preview build a caching layer   # Exact/candidate preflight only; no execution
/do why is the login slow           # Root cause analysis
/do refactor the auth module        # Safe multi-file refactoring
```

Or describe what you want in plain English and let the `/do` router pick the tool:

```text
/do fix the login bug
/do what's wrong with the API
/do build a caching layer
```

Tier 0 is intentionally exact: `/do status` is deterministic only when the
whole request matches. `/do build`, `/do test`, and `/do typecheck` additionally
require the matching non-empty target `package.json` script. Larger requests
use generated built-in candidates as evidence for runtime semantic
classification. Preview does not inspect active state, discover custom project
skills, or run that classifier, so every natural-language preview is
non-executable. If you already know the route, override selection explicitly
without bypassing its activation or safety boundaries:

```text
/do --route /test-gen -- generate tests for utils
```

### Scale up when ready

```text
/marshal audit the codebase         # Multi-step, single session
/archon build the payment system    # Multi-session campaign
/fleet --quick overhaul all three services  # Parallel agents, shared discovery
/improve citadel --n=5              # Autonomous quality loops
```

Or let `/do` escalate automatically; it routes to orchestrators when the task requires it. Capture patterns you keep repeating with `/create-skill`.

## Verify

From the Citadel clone:

```bash
npm test
```

Success is a zero exit code; the suite covers hooks, skill structure, and installer checks.

To exercise the governed lifecycle exactly as a local user or adapter developer
would, including real scratch Git repositories, plan/apply/leave/restore, an
installed contracts tarball, NDJSON restart/replay, and proof suppression, run:

```bash
npm run test:governed-lifecycle
```

The resulting local proof is
`.planning/verification/governed-lifecycle.json`. It deliberately does not
stand in for an independently owned integration or a human cohort.

To verify the complete deterministic first-use seam for both runtime preparations:

```bash
node scripts/golden-path.js --runtime claude --fixture scripts/fixtures/golden-path/minimal-node.json
node scripts/golden-path.js --runtime codex --fixture scripts/fixtures/golden-path/minimal-node.json
```

These are isolated fixture runs, not proof of plugin registration or real-user
timing. The golden path covers Claude and Codex only; for OpenCode and Copilot
CLI, use their readiness checks.

In your target project, success looks like this scaffold, created by the `init-project` hook on first session start:

```
your-project/
  .planning/              # Campaign state, fleet sessions, intake, telemetry
    _templates/           # Campaign and fleet templates (copied from plugin)
    campaigns/            # Active + completed campaigns
    fleet/                # Fleet session state + discovery briefs
    coordination/         # Multi-instance scope claims
    intake/               # Work items pending processing
    telemetry/            # Agent run + hook timing logs (JSONL, stays local)
  .citadel/
    scripts/              # Utility scripts synced from plugin each session
    plugin-root.txt       # Pointer to plugin install location
  .claude/
    harness.json          # Project config (generated by /do setup)
    agent-context/        # Rules injected into sub-agents
```

The harness logs agent events, hook timing, and discovery compression to `.planning/telemetry/` in JSONL format. Logs never leave your machine.

## Update, rollback, restore, and leave

All lifecycle mutations consume saved plans:

```bash
node "$CITADEL_ROOT/scripts/adopt.js" update plan "$CITADEL_NEXT_ROOT" \
  --migration migration.json --target . --out ../citadel-update.plan.json --json
node "$CITADEL_ROOT/scripts/adopt.js" update apply ../citadel-update.plan.json \
  --confirm <plan-token> --json

node "$CITADEL_ROOT/scripts/adopt.js" rollback plan \
  --target . --out ../citadel-rollback.plan.json --json

node "$CITADEL_ROOT/scripts/adopt.js" leave plan \
  --target . --out ../citadel-leave.plan.json --json
node "$CITADEL_ROOT/scripts/adopt.js" leave apply ../citadel-leave.plan.json \
  --confirm <plan-token> --json
```

Every saved lifecycle plan stays outside the target repository. This prevents
the plan file itself from changing the target after preflight and causing
`TARGET_DRIFT` during apply.

Update switches immutable generations only after verification. Rollback uses
the retained predecessor receipt and declared state migration compatibility.
Leave creates a versioned portable archive, restores exact shared-file
pre-images, deletes only unchanged owned material, and retains modified or
ambiguous entries. OpenCode installs are not covered by these plans; see
[OpenCode plugin](#opencode-plugin) for removal. `citadel uninstall` is a compatibility alias for the same
leave plan/apply path. A legacy install without a receipt must first use
`adopt import plan`; the emergency `unharness --legacy-apply` path is explicitly
inexact and cannot support an exact-removal claim.

## Troubleshooting

**Hook not firing / "command not found" errors:**
Re-run the runtime-specific install step from your project root, then re-run `/do setup`:

```bash
node "$CITADEL_ROOT/scripts/install.js" --runtime claude --install --scope local
node "$CITADEL_ROOT/scripts/install.js" --runtime codex --install
node "$CITADEL_ROOT/scripts/install.js" --runtime opencode
node "$CITADEL_ROOT/scripts/install.js" --runtime copilot --install
```

On OpenCode, restart the process after reinstalling and confirm the
`[citadel] hooks ok` startup log line. On OpenCode and Copilot CLI, the readiness
checks name the failing piece.

**Wrong runtime detected:**
When several runtime directories coexist, set `CITADEL_RUNTIME` to
`claude-code`, `codex`, `opencode`, or `copilot`, or pass `--runtime` to the
installer explicitly.

Alternatively, run the hook installer directly from your project directory:

```bash
node "$CITADEL_ROOT/scripts/install-hooks.js"
```

**Moved the extracted Citadel directory:**
Resolved hook paths point at the old location. Refresh the runtime-specific
install step, then re-run `/do setup`.

**"[protect-files] Blocked" message:**
Citadel prevented an edit to a protected file. The message names the specific file and the pattern that triggered the block. To allow the edit, remove the pattern from `protectedFiles` in `.claude/harness.json`.

**"[Circuit Breaker] tool has failed N times" message:**
A tool failed repeatedly. This is Citadel suggesting you try a different approach, not an error in Citadel itself. The message names the specific tool and shows the last error. Read the suggestions and switch strategy.

**Campaign file in broken state:**
If a campaign file in `.planning/campaigns/` has corrupted YAML frontmatter or invalid status, delete the file and restart the campaign. Campaign logs in `.planning/improvement-logs/` and `.planning/telemetry/` are preserved independently.

**"/do setup" fails or produces empty harness.json:**
Ensure you are running from your project root (not the Citadel plugin directory). Setup needs to detect your project's language and framework from files like `package.json`, `tsconfig.json`, or `Cargo.toml`.

**Daemon won't start / "No active campaign" error:**
The daemon attaches to an active campaign. Check `.planning/campaigns/` for a file with `Status: active`. If none exists, start work first with `/improve`, `/archon`, or `/fleet --quick`, then attach the daemon.

**Daemon is paused (level-up-pending):**
An improve loop hit distribution saturation and needs human approval for the next quality level. Review the proposals at `.planning/rubrics/{target}-proposals.md`, edit the rubric with approved changes, and set the campaign status back to `active`. The daemon's watchdog will detect the change and resume automatically.

## Next Steps

- Add your project's conventions to `CLAUDE.md`; the more specific, the better.
- Add your project's conventions to `AGENTS.md` if you use Codex, OpenCode, or
  Copilot CLI.
- Run `/do --list` to see all <!-- GENERATED: skill-count -->48<!-- /GENERATED --> installed skills.
- Drop a task in `.planning/intake/` and run `/autopilot` for hands-off execution.
- Read [Routing Preview](docs/ROUTING_PREVIEW.md) before treating static candidate evidence as a selected route.
- Read [Architecture](docs/ARCHITECTURE.md) for the Request → Run → Evidence → Needs You / Resume boundary.
- Use the [CLI reference](docs/CLI.md) and [Releases](docs/RELEASES.md) for supported commands and artifact verification.

Citadel pairs well with [Superpowers](https://github.com/obra/superpowers), which teaches methodology: brainstorm before coding, write tests first, review before shipping. Citadel supplies the infrastructure to execute that methodology at scale with campaign persistence, fleet coordination, lifecycle hooks, and telemetry. They are complementary.
