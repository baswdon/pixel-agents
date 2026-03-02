# Pixel Agents Kolido: LIVE INSTALL + PROOF Runbook

## Quick Start (3 steps)

1. **Start the Kolido bridge** via `START_ALL.bat` (or your existing launcher) so it writes to `C:\KolidoAgentWorkspace\logs\audit.jsonl`.
2. **Open VS Code** in `C:\KolidoAgentWorkspace\pixel-agents-fork`, enable `pixel-agents.kolidoMode` and set `pixel-agents.kolidoAuditLogPath` to `C:\KolidoAgentWorkspace\logs\audit.jsonl`.
3. **Open the Pixel Agents panel** (`Ctrl+Shift+P` → "Pixel Agents: Show Panel") and send the 3 Discord messages below to verify EASY / BASELINE / BOOST tier badges.

---

## Context

All code changes are complete. Build is clean, verifier passes (47/47). This runbook covers running the extension **live in VS Code** with `kolidoMode` tailing `C:\KolidoAgentWorkspace\logs\audit.jsonl` and proving animations + tier badges with 3 Discord messages.

**No code changes in this ticket.** Telegram remains approvals/alerts only.

---

## Prerequisites

- VS Code v1.107.0+ installed
- Node.js installed (for build)
- Kolido bridge running and writing to `C:\KolidoAgentWorkspace\logs\audit.jsonl`

---

## Step 1 — Build the Extension

**Working directory:** `C:\KolidoAgentWorkspace\pixel-agents-fork`

```cmd
npm run build
```

**Expected:** Build succeeds and creates:
- `dist\extension.js` (extension backend, esbuild bundle)
- `webview-ui\dist\` (React webview, Vite bundle)

---

## Step 2 — Launch in VS Code

### Option A: F5 Extension Development Host (recommended for testing)

The repo already has `.vscode\launch.json` with a "Run Extension" config.

1. Open the repo in VS Code:
   ```cmd
   code C:\KolidoAgentWorkspace\pixel-agents-fork
   ```

2. Press **F5** (or Run → Start Debugging).

3. A new VS Code window opens — this is the **Extension Development Host** with pixel-agents loaded.

> **If F5 fails** with "Cannot find task '${defaultBuildTask}'" — see Mini-Fix #5 below.

### Option B: VSIX install (persistent, no debug host needed)

```cmd
cd C:\KolidoAgentWorkspace\pixel-agents-fork
npx @vscode/vsce package --no-dependencies
```

Then install the resulting `.vsix`:

```cmd
code --install-extension pixel-agents-1.0.2.vsix
```

Restart VS Code after installing.

---

## Step 3 — Enable Kolido Mode Settings

In the target VS Code window (Extension Development Host if F5, or main VS Code if VSIX):

1. `Ctrl + ,` → search `pixel-agents.kolidoMode` → **check the box**
2. Search `pixel-agents.kolidoAuditLogPath` → set to:
   ```
   C:\KolidoAgentWorkspace\logs\audit.jsonl
   ```

Or add directly to `settings.json`:

```json
{
  "pixel-agents.kolidoMode": true,
  "pixel-agents.kolidoAuditLogPath": "C:\\KolidoAgentWorkspace\\logs\\audit.jsonl"
}
```

---

## Step 4 — Open the Pixel Agents Panel

1. `Ctrl + Shift + P` → type `Pixel Agents: Show Panel` → press Enter
2. The panel opens in the sidebar

**Expected:** 6 agents appear immediately with correct display names:
- Media Dev, Audio, Artist, Toolsmith, Pipeline, Researcher

All agents start idle (no tier badge yet — badges appear only after `chat_model_selected` events).

---

## Step 5 — Verify "Is the Kolido Reader Running?"

### Where to look: Extension Host console

**If using F5 (Extension Development Host):**
- In the **original** VS Code window (not the dev host), the **Debug Console** panel shows all `console.log` output from the extension.
- Look there for `[Kolido]` prefixed lines.

**If using VSIX install:**
- `Ctrl + Shift + P` → "Developer: Toggle Developer Tools"
- Switch to the **Console** tab
- Filter for `[Kolido]`

### Expected startup log lines (in order)

These match the exact `console.log` calls in the source code:

```
[Kolido] Kolido mode enabled — creating fixed agents          ← PixelAgentsViewProvider.ts:125
[Kolido] Created agent 1: Media Dev (agent_media_dev)          ← agentManager.ts:380
[Kolido] Created agent 2: Audio (agent_audio)                  ← agentManager.ts:380
[Kolido] Created agent 3: Artist (agent_artist)                ← agentManager.ts:380
[Kolido] Created agent 4: Toolsmith (agent_toolsmith)          ← agentManager.ts:380
[Kolido] Created agent 5: Pipeline (agent_pipeline)            ← agentManager.ts:380
[Kolido] Created agent 6: Researcher (agent_researcher)        ← agentManager.ts:380
[Pixel Agents] sendExistingAgents: agents=[1,2,3,4,5,6], ...  ← agentManager.ts:288
[Kolido] Starting audit reader: C:\KolidoAgentWorkspace\logs\audit.jsonl  ← PixelAgentsViewProvider.ts:136
[Kolido] Tailing C:\KolidoAgentWorkspace\logs\audit.jsonl from offset <number>  ← kolidoAuditReader.ts:94
```

> **Fallback:** If you don't see these lines, search the console for `kolido` (case-insensitive) and paste the first 20 lines here for diagnosis.

### If something is wrong

| You see | Meaning | Action |
|---------|---------|--------|
| No `[Kolido]` lines at all | `kolidoMode` not enabled, or panel not opened | Check settings, reopen panel |
| `[Kolido] Audit log not found, waiting: ...` | File doesn't exist yet | Start the Kolido bridge, or verify path |
| `[Kolido] Audit log not found, retrying...` | File still missing after initial check | Same as above — reader will auto-retry |
| `[Kolido] Read error: ...` | Permission or I/O issue | Check file permissions, close other readers |
| `[Kolido] Tailing ... from offset 0` | Normal — file exists but was empty or just created | Events will flow once bridge writes |
| `[Kolido] File truncated (X → Y), resetting` | Log was rotated/cleared — reader auto-recovers | Normal operation, no action needed |

---

## Step 6 — Verify with 3 Discord Messages

Send these 3 exact messages through Discord → Kolido pipeline (copy-paste):

| # | Copy-paste this Discord message | Expected Tier | Badge Text | Badge Color |
|---|------|---------------|------------|-------------|
| 1 | `hi` | EASY | `EASY 3b` | Green |
| 2 | `Summarize the last 3 commits on the main branch and list any files that changed.` | BASELINE | `BASELINE 7b` | Gray |
| 3 | `Review the entire audio pipeline module for performance bottlenecks. For each bottleneck found, propose an optimized implementation with before/after benchmarks, explain the tradeoff between latency and throughput, and write unit tests that verify the optimization doesn't change output quality. Output a markdown report.` | BOOST | `BOOST 14b` | Blue |

### What to watch per message (animation sequence)

1. `agent_chat_received` → agent starts **reading animation** (character opens book), status = "Reading"
2. `chat_model_selected` → **tier badge appears/updates** next to display name (e.g., `Media Dev BOOST 14b`)
3. `llm_request` → agent switches to **typing animation** (character sits at desk), status = "Running"
4. `llm_response` → tool done (brief transition)
5. `agent_chat_response` → **typing animation** continues, status = "Writing"
6. `agent_message_delivered` → agent goes **idle** (standing/waiting)

### Badge locations

- **AgentLabels** (always visible): inline after the floating display name above each character
- **ToolOverlay** (hover/click on agent): in the detail card popup

### Badge color reference

- **EASY** → green (`--vscode-charts-green`)
- **BASELINE** → gray (`--pixel-text-dim`)
- **BOOST** → blue (`--pixel-status-active`)

---

## Step 7 — Confirm Full Animation Mapping

Cross-reference live behavior against the event → animation table:

| Audit Event | Expected Animation | Visual Cue |
|---|---|---|
| `agent_chat_received` | Reading (character opens book) | Book sprite on message arrival |
| `agent_message_routed` | Reading (character opens book) | If message routes between agents |
| `llm_request` | Typing (character sits at desk) | Typing sprite during LLM call |
| `agent_chat_response` | Typing (character sits at desk) | Typing sprite while writing response |
| `llm_response` | Tool done (brief transition) | Brief flash before next state |
| `agent_message_delivered` | Idle (character stands) | Agent returns to idle after successful delivery |
| `llm_error` | Error (red) | LLM timeout or failure |
| `agent_chat_error` | Error (red) | Chat-level error |
| `agent_message_delivery_failed` | Error (red) | Delivery failure |

---

## Mini-Fix List: 5 Most Likely Issues

### 1. Panel shows "Loading..." and never renders agents

**Cause:** `kolidoMode` setting not enabled, or webview didn't receive ready acknowledgment.

**Fix:** Check Settings → `pixel-agents.kolidoMode` is checked. Then reload the panel:
- `Ctrl + Shift + P` → "Developer: Reload Webviews"

### 2. Agents appear but show "Agent #1" instead of "Media Dev"

**Cause:** Old build cached in `dist\`. The `folderName` fix isn't in the bundle.

**Fix:**

```cmd
cd C:\KolidoAgentWorkspace\pixel-agents-fork
rmdir /s /q dist
npm run build
```

Then restart the Extension Development Host (stop debug + F5 again), or reload VS Code if VSIX-installed.

### 3. No animations — agents stay idle even when audit events arrive

**Cause:** `audit.jsonl` path mismatch or file doesn't exist.

**Fix:** Verify path in settings matches exactly. Check the file exists and has recent entries:

```cmd
type C:\KolidoAgentWorkspace\logs\audit.jsonl | more
```

Check the Debug Console / Developer Tools for `[Kolido] Audit log not found` messages.

### 4. Tier badge never appears

**Cause:** Kolido bridge isn't emitting `chat_model_selected` events, or the `agent_id` in the event doesn't match one of the 6 known agent IDs.

**Fix:** Search the audit log for `chat_model_selected`:

```cmd
findstr "chat_model_selected" C:\KolidoAgentWorkspace\logs\audit.jsonl
```

Verify `agent_id` is one of: `agent_media_dev`, `agent_audio`, `agent_artist`, `agent_toolsmith`, `agent_pipeline`, `agent_researcher`.

### 5. F5 fails with "Cannot find task '${defaultBuildTask}'"

**Cause:** No default build task configured in VS Code.

**Fix (choose one):**

**(a)** Build manually first, then launch without pre-build:

```cmd
cd C:\KolidoAgentWorkspace\pixel-agents-fork
npm run build
```

Then in `launch.json`, remove or comment out the `"preLaunchTask"` line and press F5 again.

**(b)** Create `.vscode\tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "type": "npm",
      "script": "build",
      "group": { "kind": "build", "isDefault": true },
      "label": "npm: build"
    }
  ]
}
```

---

## Success Criteria

All of these must be true:

- [ ] 6 agents visible with correct display names (Media Dev, Audio, Artist, Toolsmith, Pipeline, Researcher)
- [ ] Debug Console / Dev Tools shows `[Kolido] Tailing ... from offset <number>`
- [ ] Sending a short Discord message → agent animates: reading → typing → idle
- [ ] Tier badge appears with correct color after `chat_model_selected` event
- [ ] 3 different tiers observed: EASY 3b (green), BASELINE 7b (gray), BOOST 14b (blue)
- [ ] No "Agent #1" fallback labels visible
- [ ] Non-Kolido mode unaffected (disable `kolidoMode` → normal pixel-agents behavior)
