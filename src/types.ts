import type * as vscode from 'vscode';

export interface AgentState {
	id: number;
	terminalRef: vscode.Terminal;
	projectDir: string;
	jsonlFile: string;
	fileOffset: number;
	lineBuffer: string;
	activeToolIds: Set<string>;
	activeToolStatuses: Map<string, string>;
	activeToolNames: Map<string, string>;
	activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
	activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
	isWaiting: boolean;
	permissionSent: boolean;
	hadToolsInTurn: boolean;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
	// ── Kolido-mode fields ──────────────────────────────────────
	/** True when this agent was created by Kolido mode (no real terminal) */
	isKolido?: boolean;
	/** Kolido agent_id from audit.jsonl (e.g. "agent_media_dev") */
	kolidoAgentId?: string;
	/** Display name for Kolido agents (e.g. "Media Dev") */
	kolidoDisplayName?: string;
	/** Current model tier: EASY | BASELINE | BOOST (from chat_model_selected) */
	kolidoModelTier?: string;
	/** Current model tag (e.g. "qwen2.5-coder:7b") */
	kolidoModelTag?: string;
}

export interface PersistedAgent {
	id: number;
	terminalName: string;
	jsonlFile: string;
	projectDir: string;
	/** Workspace folder name (only set for multi-root workspaces) */
	folderName?: string;
}
