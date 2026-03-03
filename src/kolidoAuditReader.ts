// ==========================================================================
// Kolido Mode — Audit Log Reader
//
// Tails C:\KolidoAgentWorkspace\logs\audit.jsonl and dispatches
// webview messages that drive Pixel Agents animations.
//
// The reader emits the SAME message types that the existing
// transcriptParser.ts produces from Claude Code JSONL, so the
// webview needs zero changes for core animations.
//
// Additionally emits `agentMeta` messages for tier/tag display.
// ==========================================================================

import * as fs from 'fs';
import type * as vscode from 'vscode';
import type { AgentState } from './types.js';
import { KOLIDO_BRIDGED_EVENTS, KOLIDO_REDACTED_FIELDS } from './kolidoConfig.js';
import { KOLIDO_AUDIT_POLL_INTERVAL_MS, KOLIDO_AUDIT_RETRY_INTERVAL_MS, TOOL_DONE_DELAY_MS } from './constants.js';
import { formatToolStatus } from './transcriptParser.js';

// ── Per-agent mutable state for the mapper ──────────────────

interface KolidoAgentMapState {
	/** Pixel Agents numeric ID for this agent */
	pixelId: number;
	/** Currently active tool ID (for closing before opening new) */
	activeToolId: string | null;
	/** Name of active tool (for formatToolStatus) */
	activeToolName: string | null;
	/** Monotonic counter for deterministic tool IDs */
	toolCounter: number;
}

// ── Parsed audit event ──────────────────────────────────────

interface RawAuditEvent {
	timestamp: string;
	event: string;
	agent_id?: string;
	detail?: Record<string, unknown>;
	[key: string]: unknown;
}

// ── Public: message collector (for verifier) ────────────────

export interface WebviewMessage {
	type: string;
	[key: string]: unknown;
}

// ── Reader lifecycle ────────────────────────────────────────

export interface KolidoReaderHandle {
	dispose(): void;
}

/**
 * Start tailing the audit log and dispatching webview messages.
 *
 * @param auditLogPath  Absolute path to audit.jsonl
 * @param agents        Map of pixelId → AgentState (already registered)
 * @param webview       Webview to post messages to
 * @returns             Handle with dispose() to stop tailing
 */
export function startKolidoReader(
	auditLogPath: string,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): KolidoReaderHandle {
	// Build kolidoAgentId → mapState lookup
	const mapStates = new Map<string, KolidoAgentMapState>();
	for (const agent of agents.values()) {
		if (agent.isKolido && agent.kolidoAgentId) {
			mapStates.set(agent.kolidoAgentId, {
				pixelId: agent.id,
				activeToolId: null,
				activeToolName: null,
				toolCounter: 0,
			});
		}
	}

	let fileOffset = 0;
	let lineBuffer = '';
	let disposed = false;
	let retryCount = 0;

	// Skip to end of existing file
	try {
		if (fs.existsSync(auditLogPath)) {
			const stat = fs.statSync(auditLogPath);
			fileOffset = stat.size;
			retryCount = 0;
			console.log(`[Kolido] Tailing ${auditLogPath} from offset ${fileOffset}`);
		} else {
			console.log(`[Kolido] Audit log not found, waiting: ${auditLogPath}`);
		}
	} catch {
		console.log(`[Kolido] Error checking audit log, will retry`);
	}

	const poll = setInterval(() => {
		if (disposed) return;
		try {
			if (!fs.existsSync(auditLogPath)) {
				if (retryCount === 0) {
					console.log(`[Kolido] Audit log not found, retrying...`);
				}
				retryCount++;
				return;
			}

			const stat = fs.statSync(auditLogPath);

			// Handle file truncation / rotation
			if (stat.size < fileOffset) {
				console.log(`[Kolido] File truncated (${fileOffset} → ${stat.size}), resetting`);
				fileOffset = 0;
				lineBuffer = '';
			}

			if (stat.size <= fileOffset) return;

			// Read new bytes
			const buf = Buffer.alloc(stat.size - fileOffset);
			const fd = fs.openSync(auditLogPath, 'r');
			fs.readSync(fd, buf, 0, buf.length, fileOffset);
			fs.closeSync(fd);
			fileOffset = stat.size;
			retryCount = 0;

			// Split into lines, keeping partial last line in buffer
			const text = lineBuffer + buf.toString('utf-8');
			const lines = text.split('\n');
			lineBuffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) continue;
				processAuditLine(line, mapStates, agents, webview);
			}
		} catch (e) {
			console.log(`[Kolido] Read error: ${e}`);
		}
	}, KOLIDO_AUDIT_POLL_INTERVAL_MS);

	return {
		dispose() {
			disposed = true;
			clearInterval(poll);
			console.log('[Kolido] Reader disposed');
		},
	};
}

// ── Line processing ─────────────────────────────────────────

function processAuditLine(
	line: string,
	mapStates: Map<string, KolidoAgentMapState>,
	agents: Map<number, AgentState>,
	webview: vscode.Webview | undefined,
): void {
	let event: RawAuditEvent;
	try {
		event = JSON.parse(line);
	} catch {
		return; // skip malformed JSON
	}

	if (!event.event || !event.agent_id) return;
	if (!KOLIDO_BRIDGED_EVENTS.has(event.event)) return;

	const ms = mapStates.get(event.agent_id);
	if (!ms) return; // unknown agent

	const agent = agents.get(ms.pixelId);
	if (!agent) return;

	const detail = redactDetail(event.detail);
	const messages = mapEventToMessages(event.event, detail, ms, agent);

	for (const msg of messages) {
		webview?.postMessage(msg);
	}
}

// ── Core mapper: audit event → webview messages ─────────────
//
// Produces the same message types that transcriptParser.ts
// would produce from Claude Code JSONL records.

export function mapEventToMessages(
	eventName: string,
	detail: Record<string, unknown>,
	ms: KolidoAgentMapState,
	agent: AgentState,
): WebviewMessage[] {
	const messages: WebviewMessage[] = [];
	const id = ms.pixelId;

	// Helper: close active tool (emit agentToolDone)
	const closeActiveTool = () => {
		if (ms.activeToolId) {
			const toolId = ms.activeToolId;
			messages.push({ type: 'agentToolDone', id, toolId });
			// Update AgentState tracking
			agent.activeToolIds.delete(toolId);
			agent.activeToolStatuses.delete(toolId);
			agent.activeToolNames.delete(toolId);
			ms.activeToolId = null;
			ms.activeToolName = null;
		}
	};

	// Helper: start new tool
	const startTool = (toolName: string, input: Record<string, unknown>) => {
		ms.toolCounter++;
		const toolId = `kolido_${agent.kolidoAgentId}_${String(ms.toolCounter).padStart(4, '0')}`;
		const status = formatToolStatus(toolName, input);

		messages.push({ type: 'agentStatus', id, status: 'active' });
		messages.push({ type: 'agentToolStart', id, toolId, status });

		// Track in AgentState
		agent.activeToolIds.add(toolId);
		agent.activeToolStatuses.set(toolId, status);
		agent.activeToolNames.set(toolId, toolName);
		agent.isWaiting = false;
		agent.hadToolsInTurn = true;
		ms.activeToolId = toolId;
		ms.activeToolName = toolName;
	};

	// Helper: go idle (close tool + waiting)
	const goIdle = () => {
		closeActiveTool();
		// Clear any remaining tools
		if (agent.activeToolIds.size > 0) {
			messages.push({ type: 'agentToolsClear', id });
			agent.activeToolIds.clear();
			agent.activeToolStatuses.clear();
			agent.activeToolNames.clear();
		}
		agent.isWaiting = true;
		agent.hadToolsInTurn = false;
		messages.push({ type: 'agentStatus', id, status: 'waiting' });
	};

	switch (eventName) {
		// ── Reading animations (Read/Grep → 📖) ──────────────

		case 'agent_chat_received': {
			closeActiveTool();
			const ch = (detail.channel as string) || 'chat';
			startTool('Read', { file_path: `chat/${ch}` });
			break;
		}

		case 'agent_message_routed': {
			closeActiveTool();
			const ch = (detail.channel as string) || 'unknown';
			startTool('Read', { file_path: `routed/${ch}` });
			break;
		}

		case 'chat_model_selected': {
			// Metadata only — do NOT change visual state
			const tier = (detail.tier as string) || '';
			const tag = (detail.model_tag as string) || '';
			agent.kolidoModelTier = tier.toUpperCase();
			agent.kolidoModelTag = tag;
			messages.push({
				type: 'agentMeta',
				id,
				modelTier: agent.kolidoModelTier,
				modelTag: agent.kolidoModelTag,
			});
			break;
		}

		case 'chat_boost_timeout_fallback': {
			// Metadata update to baseline
			const fallbackTag = (detail.fallback_model_tag as string) || 'baseline';
			agent.kolidoModelTier = 'BASELINE';
			agent.kolidoModelTag = fallbackTag;
			messages.push({
				type: 'agentMeta',
				id,
				modelTier: agent.kolidoModelTier,
				modelTag: agent.kolidoModelTag,
			});
			break;
		}

		// ── Typing animations (Bash/Write → ⌨️) ──────────────

		case 'llm_request': {
			closeActiveTool();
			const model = (detail.model as string) || 'llm';
			startTool('Bash', { command: `llm-request --model ${model}` });
			break;
		}

		case 'agent_chat_response': {
			closeActiveTool();
			const ch = (detail.channel as string) || 'chat';
			startTool('Write', { file_path: `response/${ch}` });
			break;
		}

		// ── Tool completion (no idle yet) ─────────────────────

		case 'llm_response': {
			closeActiveTool();
			break;
		}

		// ── Idle transitions ──────────────────────────────────

		case 'agent_message_delivered': {
			goIdle();
			break;
		}

		case 'llm_error': {
			goIdle();
			break;
		}

		case 'agent_chat_error': {
			goIdle();
			break;
		}

		case 'agent_message_delivery_failed': {
			goIdle();
			break;
		}

		default:
			break;
	}

	return messages;
}

// ── Redaction helper ────────────────────────────────────────

function redactDetail(detail: Record<string, unknown> | undefined): Record<string, unknown> {
	if (!detail) return {};
	const safe: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(detail)) {
		if (KOLIDO_REDACTED_FIELDS.has(k.toLowerCase())) {
			safe[k] = '[REDACTED]';
		} else {
			safe[k] = v;
		}
	}
	return safe;
}

// ── Replay mode (for verifier — no vscode dependency) ───────

/**
 * Replay a fixture JSONL and collect all messages that would be dispatched.
 * Pure function — no file I/O, no vscode.
 */
export function replayFixture(
	fixtureContent: string,
	agentConfigs: Array<{ kolidoAgentId: string; pixelId: number; displayName: string }>,
): { messages: Map<string, WebviewMessage[]>; totalEvents: number } {
	// Build states
	const mapStates = new Map<string, KolidoAgentMapState>();
	const agents = new Map<number, AgentState>();
	const messages = new Map<string, WebviewMessage[]>();

	for (const cfg of agentConfigs) {
		mapStates.set(cfg.kolidoAgentId, {
			pixelId: cfg.pixelId,
			activeToolId: null,
			activeToolName: null,
			toolCounter: 0,
		});
		// Minimal AgentState for the mapper
		const agent: AgentState = {
			id: cfg.pixelId,
			terminalRef: null as unknown as import('vscode').Terminal,
			projectDir: '',
			jsonlFile: '',
			fileOffset: 0,
			lineBuffer: '',
			activeToolIds: new Set(),
			activeToolStatuses: new Map(),
			activeToolNames: new Map(),
			activeSubagentToolIds: new Map(),
			activeSubagentToolNames: new Map(),
			isWaiting: false,
			permissionSent: false,
			hadToolsInTurn: false,
			isKolido: true,
			kolidoAgentId: cfg.kolidoAgentId,
			kolidoDisplayName: cfg.displayName,
		};
		agents.set(cfg.pixelId, agent);
		messages.set(cfg.kolidoAgentId, []);
	}

	let totalEvents = 0;
	const lines = fixtureContent.split('\n').filter(l => l.trim());

	for (const line of lines) {
		let event: RawAuditEvent;
		try {
			event = JSON.parse(line);
		} catch { continue; }

		if (!event.event || !event.agent_id) continue;
		if (!KOLIDO_BRIDGED_EVENTS.has(event.event)) continue;
		totalEvents++;

		const ms = mapStates.get(event.agent_id);
		if (!ms) continue;

		const agent = agents.get(ms.pixelId);
		if (!agent) continue;

		const detail = redactDetail(event.detail);
		const msgs = mapEventToMessages(event.event, detail, ms, agent);
		const agentMsgs = messages.get(event.agent_id)!;
		agentMsgs.push(...msgs);
	}

	return { messages, totalEvents };
}
