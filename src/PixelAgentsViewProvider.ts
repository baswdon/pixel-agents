import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { AgentState } from './types.js';
import {
	launchNewTerminal,
	removeAgent,
	restoreAgents,
	persistAgents,
	sendExistingAgents,
	sendLayout,
	getProjectDirPath,
	createKolidoAgents,
} from './agentManager.js';
import { ensureProjectScan } from './fileWatcher.js';
import { loadFurnitureAssets, sendAssetsToWebview, loadFloorTiles, sendFloorTilesToWebview, loadWallTiles, sendWallTilesToWebview, loadCharacterSprites, sendCharacterSpritesToWebview, loadDefaultLayout } from './assetLoader.js';
import { WORKSPACE_KEY_AGENT_SEATS, GLOBAL_KEY_SOUND_ENABLED, KOLIDO_SETTING_MODE, KOLIDO_SETTING_AUDIT_LOG, KOLIDO_SETTING_REPLAY_LAST_N, KOLIDO_DEFAULT_AUDIT_LOG } from './constants.js';
import { writeLayoutToFile, readLayoutFromFile, watchLayoutFile } from './layoutPersistence.js';
import type { LayoutWatcher } from './layoutPersistence.js';
import { startKolidoReader, replayFixture } from './kolidoAuditReader.js';
import type { KolidoReaderHandle } from './kolidoAuditReader.js';
import { KOLIDO_AGENTS } from './kolidoConfig.js';

export class PixelAgentsViewProvider implements vscode.WebviewViewProvider {
	nextAgentId = { current: 1 };
	nextTerminalIndex = { current: 1 };
	agents = new Map<number, AgentState>();
	webviewView: vscode.WebviewView | undefined;

	// Per-agent timers
	fileWatchers = new Map<number, fs.FSWatcher>();
	pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
	waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
	jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();
	permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

	// /clear detection: project-level scan for new JSONL files
	activeAgentId = { current: null as number | null };
	knownJsonlFiles = new Set<string>();
	projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };

	// Bundled default layout (loaded from assets/default-layout.json)
	defaultLayout: Record<string, unknown> | null = null;

	// Cross-window layout sync
	layoutWatcher: LayoutWatcher | null = null;

	// Kolido mode
	kolidoReader: KolidoReaderHandle | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Check if Kolido mode is enabled in VS Code settings */
	private get isKolidoMode(): boolean {
		return vscode.workspace.getConfiguration().get<boolean>(KOLIDO_SETTING_MODE, false);
	}

	/** Get the configured audit log path */
	private get kolidoAuditLogPath(): string {
		return vscode.workspace.getConfiguration().get<string>(KOLIDO_SETTING_AUDIT_LOG, KOLIDO_DEFAULT_AUDIT_LOG);
	}

	/** How many audit lines to replay on startup (0 = tail new events only) */
	private get kolidoReplayLastN(): number {
		return vscode.workspace.getConfiguration().get<number>(KOLIDO_SETTING_REPLAY_LAST_N, 0);
	}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	private get webview(): vscode.Webview | undefined {
		return this.webviewView?.webview;
	}

	private persistAgents = (): void => {
		persistAgents(this.agents, this.context);
	};

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this.webviewView = webviewView;
		webviewView.webview.options = { enableScripts: true };
		webviewView.webview.html = getWebviewContent(webviewView.webview, this.extensionUri);

		webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.type === 'openClaude') {
				if (this.isKolidoMode) return; // Kolido mode: no manual terminal launch
				await launchNewTerminal(
					this.nextAgentId, this.nextTerminalIndex,
					this.agents, this.activeAgentId, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanTimer,
					this.webview, this.persistAgents,
					message.folderPath as string | undefined,
				);
			} else if (message.type === 'focusAgent') {
				const agent = this.agents.get(message.id);
				if (agent && !agent.isKolido) {
					agent.terminalRef.show();
				}
			} else if (message.type === 'closeAgent') {
				const agent = this.agents.get(message.id);
				if (agent && !agent.isKolido) {
					agent.terminalRef.dispose();
				}
			} else if (message.type === 'saveAgentSeats') {
				// Store seat assignments in a separate key (never touched by persistAgents)
				console.log(`[Pixel Agents] saveAgentSeats:`, JSON.stringify(message.seats));
				this.context.workspaceState.update(WORKSPACE_KEY_AGENT_SEATS, message.seats);
			} else if (message.type === 'saveLayout') {
				this.layoutWatcher?.markOwnWrite();
				writeLayoutToFile(message.layout as Record<string, unknown>);
			} else if (message.type === 'setSoundEnabled') {
				this.context.globalState.update(GLOBAL_KEY_SOUND_ENABLED, message.enabled);
			} else if (message.type === 'webviewReady') {
				// ── Common setup (both modes) ────────────────────────
				const soundEnabled = this.context.globalState.get<boolean>(GLOBAL_KEY_SOUND_ENABLED, true);
				this.webview?.postMessage({ type: 'settingsLoaded', soundEnabled });

				const wsFolders = vscode.workspace.workspaceFolders;
				if (wsFolders && wsFolders.length > 1) {
					this.webview?.postMessage({
						type: 'workspaceFolders',
						folders: wsFolders.map(f => ({ name: f.name, path: f.uri.fsPath })),
					});
				}

				// ── Kolido mode branch ───────────────────────────────
				if (this.isKolidoMode) {
					console.log('[Kolido] Kolido mode enabled — creating fixed agents');
					createKolidoAgents(this.nextAgentId, this.agents, this.webview);

					// Load assets + layout (same as normal mode)
					await this.loadAssetsAndLayout();

					// Send agents to webview
					sendExistingAgents(this.agents, this.context, this.webview);

					// Start tailing audit log
					const auditPath = this.kolidoAuditLogPath;
					const replayLastN = this.kolidoReplayLastN;
					console.log(`[Kolido] Starting audit reader: ${auditPath}`);
					this.kolidoReader = startKolidoReader(auditPath, this.agents, this.webview, replayLastN);
					return; // skip normal terminal-based restore
				}

				// ── Normal (terminal) mode ───────────────────────────
				restoreAgents(
					this.context,
					this.nextAgentId, this.nextTerminalIndex,
					this.agents, this.knownJsonlFiles,
					this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
					this.jsonlPollTimers, this.projectScanTimer, this.activeAgentId,
					this.webview, this.persistAgents,
				);

				const projectDir = getProjectDirPath();
				const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
				console.log('[Extension] workspaceRoot:', workspaceRoot);
				console.log('[Extension] projectDir:', projectDir);
				if (projectDir) {
					ensureProjectScan(
						projectDir, this.knownJsonlFiles, this.projectScanTimer, this.activeAgentId,
						this.nextAgentId, this.agents,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.webview, this.persistAgents,
					);
				}

				await this.loadAssetsAndLayout();
				sendExistingAgents(this.agents, this.context, this.webview);
			} else if (message.type === 'openSessionsFolder') {
				const projectDir = getProjectDirPath();
				if (projectDir && fs.existsSync(projectDir)) {
					vscode.env.openExternal(vscode.Uri.file(projectDir));
				}
			} else if (message.type === 'exportLayout') {
				const layout = readLayoutFromFile();
				if (!layout) {
					vscode.window.showWarningMessage('Pixel Agents: No saved layout to export.');
					return;
				}
				const uri = await vscode.window.showSaveDialog({
					filters: { 'JSON Files': ['json'] },
					defaultUri: vscode.Uri.file(path.join(os.homedir(), 'pixel-agents-layout.json')),
				});
				if (uri) {
					fs.writeFileSync(uri.fsPath, JSON.stringify(layout, null, 2), 'utf-8');
					vscode.window.showInformationMessage('Pixel Agents: Layout exported successfully.');
				}
			} else if (message.type === 'importLayout') {
				const uris = await vscode.window.showOpenDialog({
					filters: { 'JSON Files': ['json'] },
					canSelectMany: false,
				});
				if (!uris || uris.length === 0) return;
				try {
					const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
					const imported = JSON.parse(raw) as Record<string, unknown>;
					if (imported.version !== 1 || !Array.isArray(imported.tiles)) {
						vscode.window.showErrorMessage('Pixel Agents: Invalid layout file.');
						return;
					}
					this.layoutWatcher?.markOwnWrite();
					writeLayoutToFile(imported);
					this.webview?.postMessage({ type: 'layoutLoaded', layout: imported });
					vscode.window.showInformationMessage('Pixel Agents: Layout imported successfully.');
				} catch {
					vscode.window.showErrorMessage('Pixel Agents: Failed to read or parse layout file.');
				}
			}
		});

		vscode.window.onDidChangeActiveTerminal((terminal) => {
			this.activeAgentId.current = null;
			if (!terminal) return;
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === terminal) {
					this.activeAgentId.current = id;
					webviewView.webview.postMessage({ type: 'agentSelected', id });
					break;
				}
			}
		});

		vscode.window.onDidCloseTerminal((closed) => {
			for (const [id, agent] of this.agents) {
				if (agent.terminalRef === closed) {
					if (this.activeAgentId.current === id) {
						this.activeAgentId.current = null;
					}
					removeAgent(
						id, this.agents,
						this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
						this.jsonlPollTimers, this.persistAgents,
					);
					webviewView.webview.postMessage({ type: 'agentClosed', id });
				}
			}
		});
	}

	/** Load all assets (furniture, sprites, tiles) and send layout to webview */
	private async loadAssetsAndLayout(): Promise<void> {
		try {
			const extensionPath = this.extensionUri.fsPath;
			const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

			const bundledAssetsDir = path.join(extensionPath, 'dist', 'assets');
			let assetsRoot: string | null = null;
			if (fs.existsSync(bundledAssetsDir)) {
				assetsRoot = path.join(extensionPath, 'dist');
			} else if (workspaceRoot) {
				assetsRoot = workspaceRoot;
			}

			if (assetsRoot) {
				this.defaultLayout = loadDefaultLayout(assetsRoot);

				const charSprites = await loadCharacterSprites(assetsRoot);
				if (charSprites && this.webview) {
					sendCharacterSpritesToWebview(this.webview, charSprites);
				}

				const floorTiles = await loadFloorTiles(assetsRoot);
				if (floorTiles && this.webview) {
					sendFloorTilesToWebview(this.webview, floorTiles);
				}

				const wallTiles = await loadWallTiles(assetsRoot);
				if (wallTiles && this.webview) {
					sendWallTilesToWebview(this.webview, wallTiles);
				}

				const assets = await loadFurnitureAssets(assetsRoot);
				if (assets && this.webview) {
					sendAssetsToWebview(this.webview, assets);
				}
			}
		} catch (err) {
			console.error('[Extension] Error loading assets:', err);
		}
		if (this.webview) {
			sendLayout(this.context, this.webview, this.defaultLayout);
			this.startLayoutWatcher();
		}
	}

	/** Export current saved layout to webview-ui/public/assets/default-layout.json (dev utility) */
	exportDefaultLayout(): void {
		const layout = readLayoutFromFile();
		if (!layout) {
			vscode.window.showWarningMessage('Pixel Agents: No saved layout found.');
			return;
		}
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) {
			vscode.window.showErrorMessage('Pixel Agents: No workspace folder found.');
			return;
		}
		const targetPath = path.join(workspaceRoot, 'webview-ui', 'public', 'assets', 'default-layout.json');
		const json = JSON.stringify(layout, null, 2);
		fs.writeFileSync(targetPath, json, 'utf-8');
		vscode.window.showInformationMessage(`Pixel Agents: Default layout exported to ${targetPath}`);
	}

	// ── Kolido Self-Test ─────────────────────────────────────────

	/**
	 * Run an in-memory fixture replay and verify EASY/BASELINE/BOOST tiers.
	 * Does NOT write to the real audit.jsonl — reads from fixtures/ only.
	 */
	kolidoSelfTest(): void {
		if (!this.isKolidoMode) {
			vscode.window.showErrorMessage('Kolido Self-Test requires kolidoMode to be enabled.');
			return;
		}

		// Resolve fixture path relative to extension root
		const fixturePath = path.join(this.extensionUri.fsPath, 'fixtures', 'kolido-audit-test.fixture.jsonl');
		let fixtureContent: string;
		try {
			fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
		} catch (e) {
			vscode.window.showErrorMessage(`Kolido Self-Test: Cannot read fixture at ${fixturePath}`);
			return;
		}

		// Build agent configs from the canonical roster
		const agentConfigs = KOLIDO_AGENTS.map((cfg, i) => ({
			kolidoAgentId: cfg.agentId,
			pixelId: i + 1,
			displayName: cfg.displayName,
		}));

		// Pure replay — no file I/O, no network
		const { messages, totalEvents } = replayFixture(fixtureContent, agentConfigs);

		// Collect observed tiers from agentMeta messages
		const observedTiers = new Set<string>();
		for (const agentMsgs of messages.values()) {
			for (const msg of agentMsgs) {
				if (msg.type === 'agentMeta' && typeof msg.modelTier === 'string') {
					observedTiers.add(msg.modelTier);
				}
			}
		}

		// Verify all 3 tiers
		const required = ['EASY', 'BASELINE', 'BOOST'];
		const missing = required.filter(t => !observedTiers.has(t));

		if (missing.length === 0) {
			vscode.window.showInformationMessage(
				`✓ Kolido Self-Test PASSED: EASY/BASELINE/BOOST observed (${totalEvents} events)`
			);
		} else {
			vscode.window.showErrorMessage(
				`✗ Kolido Self-Test FAILED: missing tiers [${missing.join(', ')}]`
			);
		}

		// Dispatch replayed messages to webview for visual feedback
		if (this.webview) {
			for (const agentMsgs of messages.values()) {
				for (const msg of agentMsgs) {
					this.webview.postMessage(msg);
				}
			}
		}
	}

	private startLayoutWatcher(): void {
		if (this.layoutWatcher) return;
		this.layoutWatcher = watchLayoutFile((layout) => {
			console.log('[Pixel Agents] External layout change — pushing to webview');
			this.webview?.postMessage({ type: 'layoutLoaded', layout });
		});
	}

	dispose() {
		this.layoutWatcher?.dispose();
		this.layoutWatcher = null;
		// Dispose Kolido reader if active
		if (this.kolidoReader) {
			this.kolidoReader.dispose();
			this.kolidoReader = null;
		}
		for (const id of [...this.agents.keys()]) {
			removeAgent(
				id, this.agents,
				this.fileWatchers, this.pollingTimers, this.waitingTimers, this.permissionTimers,
				this.jsonlPollTimers, this.persistAgents,
			);
		}
		if (this.projectScanTimer.current) {
			clearInterval(this.projectScanTimer.current);
			this.projectScanTimer.current = null;
		}
	}
}

export function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
	const distPath = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
	const indexPath = vscode.Uri.joinPath(distPath, 'index.html').fsPath;

	let html = fs.readFileSync(indexPath, 'utf-8');

	html = html.replace(/(href|src)="\.\/([^"]+)"/g, (_match, attr, filePath) => {
		const fileUri = vscode.Uri.joinPath(distPath, filePath);
		const webviewUri = webview.asWebviewUri(fileUri);
		return `${attr}="${webviewUri}"`;
	});

	return html;
}
