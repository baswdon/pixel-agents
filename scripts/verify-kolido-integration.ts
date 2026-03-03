#!/usr/bin/env npx tsx
// ==========================================================================
// Kolido Integration Verifier
//
// Runs the audit-event mapper against a fixture JSONL and asserts the
// webview message stream is correct.  Pure function tests — no vscode,
// no React, no file I/O at test time.
//
// Usage:  npx tsx scripts/verify-kolido-integration.ts
// ==========================================================================

import * as fs from 'fs';
import * as path from 'path';
import { replayFixture } from '../src/kolidoAuditReader.js';
import type { WebviewMessage } from '../src/kolidoAuditReader.js';
import { KOLIDO_AGENTS } from '../src/kolidoConfig.js';

// ── Helpers ─────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		passed++;
		console.log(`  ✅ ${label}`);
	} else {
		failed++;
		console.log(`  ❌ FAIL: ${label}`);
	}
}

function findMsg(msgs: WebviewMessage[], type: string, predicate?: (m: WebviewMessage) => boolean): WebviewMessage | undefined {
	return msgs.find(m => m.type === type && (!predicate || predicate(m)));
}

function countMsg(msgs: WebviewMessage[], type: string): number {
	return msgs.filter(m => m.type === type).length;
}

// ── Load fixture ────────────────────────────────────────────

const fixturePath = path.join(__dirname, '..', 'fixtures', 'kolido-audit-test.fixture.jsonl');
if (!fs.existsSync(fixturePath)) {
	console.error(`Fixture not found: ${fixturePath}`);
	process.exit(1);
}

const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');

// Build agent configs (same as createKolidoAgents would)
const agentConfigs = KOLIDO_AGENTS.map((cfg, i) => ({
	kolidoAgentId: cfg.agentId,
	pixelId: i + 1,
	displayName: cfg.displayName,
}));

console.log('═══════════════════════════════════════════════════');
console.log('  Kolido Integration Verifier');
console.log('═══════════════════════════════════════════════════');
console.log('');

// ── Run replay ──────────────────────────────────────────────

const { messages, totalEvents } = replayFixture(fixtureContent, agentConfigs);

console.log(`Replayed ${totalEvents} bridged events across ${messages.size} agents`);
console.log('');

// ── Test 1: Event count ─────────────────────────────────────

console.log('Test 1: Event counting');
// 32 fixture lines: 30 bridged events for known agents + 1 unbridged event + 1 bridged event for unknown agent
// totalEvents counts lines that pass bridged-events filter (before agent lookup) = 31
assert(totalEvents === 31, `totalEvents === 31 (got ${totalEvents})`);

// ── Test 2: Agent message counts ────────────────────────────

console.log('Test 2: All 6 agents received messages');
for (const cfg of agentConfigs) {
	const agentMsgs = messages.get(cfg.kolidoAgentId);
	assert(agentMsgs !== undefined && agentMsgs.length > 0, `${cfg.displayName} (${cfg.kolidoAgentId}) has messages`);
}

// ── Test 3: Unknown agent / unbridged events filtered ───────

console.log('Test 3: Unknown agent and unbridged events filtered');
const unknownMsgs = messages.get('unknown_agent');
assert(unknownMsgs === undefined, 'unknown_agent has no messages (not in roster)');
// invalid_event_not_bridged for agent_media_dev should be skipped
const mediaDevMsgs = messages.get('agent_media_dev')!;
const hasInvalid = mediaDevMsgs.some(m => JSON.stringify(m).includes('invalid_event'));
assert(!hasInvalid, 'invalid_event_not_bridged filtered out');

// ── Test 4: Media Dev lifecycle (full cycle) ────────────────

console.log('Test 4: Media Dev lifecycle');
// Should see: agentStatus(active) + agentToolStart(Read) → agentToolDone → agentToolStart(Bash) → agentToolDone → agentToolStart(Write) → agentToolDone → agentStatus(waiting)
assert(findMsg(mediaDevMsgs, 'agentToolStart', m => (m.status as string).startsWith('Reading')) !== undefined,
	'Media Dev has Reading tool start (from agent_chat_received)');
assert(findMsg(mediaDevMsgs, 'agentToolStart', m => (m.status as string).startsWith('Running')) !== undefined,
	'Media Dev has Running tool start (from llm_request)');
assert(findMsg(mediaDevMsgs, 'agentToolStart', m => (m.status as string).startsWith('Writing')) !== undefined,
	'Media Dev has Writing tool start (from agent_chat_response)');
assert(findMsg(mediaDevMsgs, 'agentStatus', m => m.status === 'waiting') !== undefined,
	'Media Dev goes to waiting (from agent_message_delivered)');

// ── Test 5: agentMeta messages (tier/tag) ───────────────────

console.log('Test 5: agentMeta messages (separate from status)');
const mediaMetaMsgs = mediaDevMsgs.filter(m => m.type === 'agentMeta');
assert(mediaMetaMsgs.length === 1, `Media Dev has 1 agentMeta (got ${mediaMetaMsgs.length})`);
assert(mediaMetaMsgs[0]?.modelTier === 'BOOST', `Media Dev tier is BOOST (got ${mediaMetaMsgs[0]?.modelTier})`);
assert(mediaMetaMsgs[0]?.modelTag === 'qwen2.5-coder:14b', `Media Dev tag is qwen2.5-coder:14b (got ${mediaMetaMsgs[0]?.modelTag})`);

// Audio gets BASELINE
const audioMsgs = messages.get('agent_audio')!;
const audioMeta = audioMsgs.filter(m => m.type === 'agentMeta');
assert(audioMeta.length === 1, `Audio has 1 agentMeta (got ${audioMeta.length})`);
assert(audioMeta[0]?.modelTier === 'BASELINE', `Audio tier is BASELINE (got ${audioMeta[0]?.modelTier})`);
assert(audioMeta[0]?.modelTag === 'qwen2.5-coder:7b', `Audio tag is qwen2.5-coder:7b (got ${audioMeta[0]?.modelTag})`);

// Artist gets EASY
const artistMsgs = messages.get('agent_artist')!;
const artistMeta = artistMsgs.filter(m => m.type === 'agentMeta');
assert(artistMeta.length === 1, `Artist has 1 agentMeta (got ${artistMeta.length})`);
assert(artistMeta[0]?.modelTier === 'EASY', `Artist tier is EASY (got ${artistMeta[0]?.modelTier})`);
assert(artistMeta[0]?.modelTag === 'qwen2.5-coder:3b', `Artist tag is qwen2.5-coder:3b (got ${artistMeta[0]?.modelTag})`);

// ── Test 6: chat_boost_timeout_fallback → agentMeta BASELINE ─

console.log('Test 6: Boost timeout fallback → BASELINE');
const toolsmithMsgs = messages.get('agent_toolsmith')!;
const toolsmithMeta = toolsmithMsgs.filter(m => m.type === 'agentMeta');
assert(toolsmithMeta.length === 1, `Toolsmith has 1 agentMeta (boost timeout)`);
assert(toolsmithMeta[0]?.modelTier === 'BASELINE', `Toolsmith tier is BASELINE after fallback`);
assert(toolsmithMeta[0]?.modelTag === 'qwen2.5-coder:7b', `Toolsmith fallback tag is qwen2.5-coder:7b (got ${toolsmithMeta[0]?.modelTag})`);

// ── Test 7: Redaction ───────────────────────────────────────

console.log('Test 7: Redaction of sensitive fields');
// Toolsmith's agent_chat_received had bot_token — check no tool status contains the secret
const toolsmithStatuses = toolsmithMsgs
	.filter(m => m.type === 'agentToolStart')
	.map(m => m.status as string);
const hasSecret = toolsmithStatuses.some(s => s.includes('SECRET_TOKEN'));
assert(!hasSecret, 'bot_token value not present in any status string');

// ── Test 8: Error events → idle ─────────────────────────────

console.log('Test 8: Error events produce idle transitions');
// Audio: llm_error → waiting
assert(findMsg(audioMsgs, 'agentStatus', m => m.status === 'waiting') !== undefined,
	'Audio goes waiting after llm_error');

// Toolsmith: agent_chat_error → waiting
assert(findMsg(toolsmithMsgs, 'agentStatus', m => m.status === 'waiting') !== undefined,
	'Toolsmith goes waiting after agent_chat_error');

// Pipeline: agent_message_delivery_failed → waiting
const pipelineMsgs = messages.get('agent_pipeline')!;
assert(findMsg(pipelineMsgs, 'agentStatus', m => m.status === 'waiting') !== undefined,
	'Pipeline goes waiting after agent_message_delivery_failed');

// ── Test 9: agent_message_routed → Read tool ────────────────

console.log('Test 9: agent_message_routed → Read tool');
// formatToolStatus('Read', { file_path: 'routed/pipeline' }) uses path.basename → "pipeline"
assert(findMsg(artistMsgs, 'agentToolStart', m => (m.status as string) === 'Reading pipeline') !== undefined,
	'Artist has "Reading pipeline" tool (from agent_message_routed channel=pipeline)');

// ── Test 10: Tool IDs are deterministic ─────────────────────

console.log('Test 10: Deterministic tool IDs');
const mediaToolIds = mediaDevMsgs
	.filter(m => m.type === 'agentToolStart')
	.map(m => m.toolId as string);
assert(mediaToolIds.length > 0, 'Media Dev has tool starts');
assert(mediaToolIds[0] === 'kolido_agent_media_dev_0001', `First tool ID is kolido_agent_media_dev_0001 (got ${mediaToolIds[0]})`);
assert(mediaToolIds[1] === 'kolido_agent_media_dev_0002', `Second tool ID is kolido_agent_media_dev_0002 (got ${mediaToolIds[1]})`);

// ── Test 11: agentToolDone emitted before new tool starts ───

console.log('Test 11: Tool close before new tool');
// For Media Dev: the sequence should be toolStart → toolDone → toolStart...
let lastToolStart = -1;
let lastToolDone = -1;
let orderCorrect = true;
for (let i = 0; i < mediaDevMsgs.length; i++) {
	const m = mediaDevMsgs[i];
	if (m.type === 'agentToolStart') {
		if (lastToolStart > lastToolDone && lastToolStart >= 0) {
			// A new tool started without closing the previous
			// This is OK only if we also see a toolDone for the previous before this
		}
		lastToolStart = i;
	}
	if (m.type === 'agentToolDone') {
		lastToolDone = i;
	}
}
// Check that every toolStart (except the first) was preceded by a toolDone
const toolStarts = mediaDevMsgs
	.map((m, i) => ({ m, i }))
	.filter(({ m }) => m.type === 'agentToolStart');
const toolDones = mediaDevMsgs
	.map((m, i) => ({ m, i }))
	.filter(({ m }) => m.type === 'agentToolDone');
if (toolStarts.length > 1) {
	for (let j = 1; j < toolStarts.length; j++) {
		const prevDone = toolDones.find(d => d.i > toolStarts[j - 1].i && d.i < toolStarts[j].i);
		if (!prevDone) orderCorrect = false;
	}
}
assert(orderCorrect, 'Each tool is closed before the next one starts');

// ── Test 12: Researcher full lifecycle ──────────────────────

console.log('Test 12: Researcher lifecycle');
const researcherMsgs = messages.get('agent_researcher')!;
assert(researcherMsgs.length > 0, 'Researcher has messages');
const researcherToolCount = countMsg(researcherMsgs, 'agentToolStart');
assert(researcherToolCount === 3, `Researcher has 3 tool starts (chat_received + llm_request + chat_response) (got ${researcherToolCount})`);
assert(findMsg(researcherMsgs, 'agentStatus', m => m.status === 'waiting') !== undefined,
	'Researcher goes waiting at end');

// ── Test 13: Status strings do NOT contain tier text ────────

console.log('Test 13: Status strings are tier-free');
let tierLeaked = false;
for (const [, agentMsgs] of messages) {
	for (const m of agentMsgs) {
		if (m.type === 'agentToolStart') {
			const s = (m.status as string).toUpperCase();
			if (s.includes('BOOST') || s.includes('BASELINE') || s.includes('EASY')) {
				tierLeaked = true;
			}
		}
	}
}
assert(!tierLeaked, 'No tier text (BOOST/BASELINE/EASY) in any agentToolStart status');

// ── Test 14: agentMeta is NOT agentStatus ───────────────────

console.log('Test 14: agentMeta type isolation');
for (const [, agentMsgs] of messages) {
	for (const m of agentMsgs) {
		if (m.type === 'agentStatus') {
			assert(m.modelTier === undefined, `agentStatus has no modelTier field`);
			break; // only need to check one
		}
	}
}

// ── Test 15: All three tiers represented ─────────────────────

console.log('Test 15: All tier levels present in fixture');
const allTiers = new Set<string>();
for (const [, agentMsgs] of messages) {
	for (const m of agentMsgs) {
		if (m.type === 'agentMeta' && m.modelTier) {
			allTiers.add((m.modelTier as string).toUpperCase());
		}
	}
}
assert(allTiers.has('BOOST'), 'Fixture contains BOOST tier');
assert(allTiers.has('BASELINE'), 'Fixture contains BASELINE tier');
assert(allTiers.has('EASY'), 'Fixture contains EASY tier');

// ── Summary ─────────────────────────────────────────────────

console.log('');
console.log('═══════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═══════════════════════════════════════════════════');

if (failed > 0) {
	process.exit(1);
}
