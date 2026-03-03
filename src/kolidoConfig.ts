// ==========================================================================
// Kolido Mode — Agent Configuration
//
// Defines the 6 fixed Kolido agents, their display names, and the set of
// audit events we bridge into Pixel Agents webview messages.
// ==========================================================================

export interface KolidoAgentConfig {
	/** Kolido agent_id from audit.jsonl (e.g. "agent_media_dev") */
	agentId: string;
	/** Human-readable name shown in labels */
	displayName: string;
}

/** Fixed agent roster — order determines Pixel Agents character assignment (0-5) */
export const KOLIDO_AGENTS: KolidoAgentConfig[] = [
	{ agentId: 'agent_media_dev', displayName: 'Media Dev' },
	{ agentId: 'agent_audio', displayName: 'Audio' },
	{ agentId: 'agent_artist', displayName: 'Artist' },
	{ agentId: 'agent_toolsmith', displayName: 'Toolsmith' },
	{ agentId: 'agent_pipeline', displayName: 'Pipeline' },
	{ agentId: 'agent_researcher', displayName: 'Researcher' },
];

/** Audit events that Kolido mode processes */
export const KOLIDO_BRIDGED_EVENTS = new Set([
	'agent_chat_received',
	'agent_message_routed',
	'chat_model_selected',
	'chat_boost_timeout_fallback',
	'llm_request',
	'llm_response',
	'agent_chat_response',
	'agent_message_delivered',
	'llm_error',
	'agent_chat_error',
	'agent_message_delivery_failed',
]);

/** Fields that must be stripped from detail before embedding in status text */
export const KOLIDO_REDACTED_FIELDS = new Set([
	'bot_token', 'webhook_url', 'discord_token', 'api_key',
	'secret', 'password', 'authorization',
]);
