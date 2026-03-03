# Pixel Agents — Kolido Mode (Option A)

## What Is This?

A fork of [pixel-agents](https://github.com/pablodelucca/pixel-agents) with native Kolido support.
When **Kolido mode** is enabled, the extension reads `C:\KolidoAgentWorkspace\logs\audit.jsonl`
directly and renders the same agent-activity animations that normally come from Claude Code terminals.

Six fixed agents are created automatically — no terminals needed:

| # | Agent ID             | Display Name |
|---|----------------------|-------------|
| 1 | agent_media_dev      | Media Dev   |
| 2 | agent_audio          | Audio       |
| 3 | agent_artist         | Artist      |
| 4 | agent_toolsmith      | Toolsmith   |
| 5 | agent_pipeline       | Pipeline    |
| 6 | agent_researcher     | Researcher  |

## One-Time Setup

```bash
cd C:\KolidoAgentWorkspace\pixel-agents-fork
npm install
cd webview-ui && npm install && cd ..
npm run build
```

## Enable Kolido Mode

In VS Code **Settings** (`Ctrl+,`), search for `pixel-agents.kolidoMode` and enable it.
Optionally change `pixel-agents.kolidoAuditLogPath` if your log is in a different location.

## Daily Use

1. Open VS Code
2. Open the **Pixel Agents** panel (View → Pixel Agents)
3. Make sure Kolido bridge is running and writing to `audit.jsonl`
4. Agents appear automatically and animate based on audit events

## Event → Animation Mapping

| Audit Event                    | Animation         | Status Prefix |
|--------------------------------|-------------------|---------------|
| agent_chat_received            | 📖 Reading        | Reading       |
| agent_message_routed           | 📖 Reading        | Reading       |
| llm_request                    | ⌨️ Typing         | Running       |
| agent_chat_response            | ⌨️ Typing         | Writing       |
| llm_response                   | Tool done         | —             |
| agent_message_delivered        | Idle (waiting)    | —             |
| llm_error                      | Idle (waiting)    | —             |
| agent_chat_error               | Idle (waiting)    | —             |
| agent_message_delivery_failed  | Idle (waiting)    | —             |
| chat_model_selected            | Metadata only     | —             |
| chat_boost_timeout_fallback    | Metadata only     | —             |

## Display Name + Tier Badge

**Display name** is sourced from `kolidoConfig.ts` → `createKolidoAgents()` where each
agent's `displayName` is stored as `folderName` on the backend `AgentState`.
The data flow is: `sendExistingAgents(folderNames)` → webview `existingAgents` handler →
`os.addAgent(..., folderName)` → `ch.folderName`. The `AgentLabels` component renders
`ch.folderName` as the persistent floating label above each character.

**Tier badge** is sourced exclusively from `agentMeta` messages, which are emitted by
`chat_model_selected` and `chat_boost_timeout_fallback` audit events (never from status
strings). The badge shows `TIER SIZE` (e.g., `BOOST 14b`) and is driven by two fields:

| Field       | Source                                           | Example           |
|-------------|--------------------------------------------------|-------------------|
| `modelTier` | `detail.tier` uppercased (or `BASELINE` for fallback) | `BOOST`          |
| `modelTag`  | `detail.model_tag` (or `detail.fallback_model_tag`)   | `qwen2.5-coder:14b` |

The short size (e.g., `14b`) is extracted from `modelTag` at display time via
`tag.slice(tag.lastIndexOf(':') + 1)`.

The tier badge appears in two places:
- **AgentLabels** (always visible): inline after the display name
- **ToolOverlay** (on hover/select): in the detail card

## Verify Integration

```bash
npx tsx scripts/verify-kolido-integration.ts
```

Expected: **47 passed, 0 failed**

## Build

```bash
npm run build
```

Expected: 0 TypeScript errors, 0 ESLint errors (warnings are pre-existing upstream style issues).

## Architecture

```
src/kolidoConfig.ts          — 6 agents, bridged events, redacted fields
src/kolidoAuditReader.ts     — Tail audit.jsonl, map events → webview messages
src/agentManager.ts          — createKolidoAgents() (folderName + no terminals)
src/PixelAgentsViewProvider.ts — Kolido mode branch on webviewReady
src/types.ts                 — Kolido fields on AgentState
src/constants.ts             — Kolido timing/setting constants
webview-ui/.../useExtensionMessages.ts — agentMeta state + layout-first agent ordering fix
webview-ui/.../AgentLabels.tsx   — Persistent name + tier badge (always visible)
webview-ui/.../ToolOverlay.tsx   — Detail card + tier badge (on hover/select)
```

When `kolidoMode` is off, the extension behaves identically to upstream pixel-agents.
