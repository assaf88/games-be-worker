import { GameState } from './interfaces/GameState';
import { Player } from './interfaces/Player';
import { GameHandlerFactory } from './handlers/GameHandlerFactory';
import { DatabaseManager } from './DatabaseManager';
import { AvalonGameLogic } from './gameLogic/AvalonGameLogic';

export class GamePartyState {
	state: DurableObjectState;
	connections: Map<WebSocket, Player> = new Map();
	gameState: GameState | null = null;
	env: any;
	hostId: string | null = null;
	firstHostId: string | null = null;
	pingInterval: any;
	gameId: string = 'unknown';
	partyCode: string = 'unknown';
	partyId: string = 'unknown';
	lastAccess: number = Date.now();
	private gameHandler: any = null;
	private dbManager: DatabaseManager;

	constructor(state: DurableObjectState, env: any) {
		this.state = state;
		this.env = env;
		this.dbManager = new DatabaseManager(env);
		this.connections = new Map(); // Clear all connections on worker restart
		this.startPingInterval();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'POST' && url.pathname === '/init') {
			try {
				const {id, name, partyCode, gameId} = await request.json() as {
					id: string,
					name: string,
					partyCode: string,
					gameId: string
				};

				if (!this.gameHandler) {
					this.gameHandler = GameHandlerFactory.createGameHandler(gameId);
				}

				if (!this.gameState) {
					this.gameState = {
						gameId,
						partyCode,
						players: [],
						gameStarted: false
					};
					this.firstHostId = id;
					this.hostId = id;
					this.state.storage.put('firstHostId', id).catch(console.error);
					this.state.storage.put('gameState', this.gameState).catch(console.error);
				}
				return new Response('OK', {status: 200});
			} catch (e) {
				return new Response('Bad Request', {status: 400});
			}
		}

		if (request.headers.get('upgrade') === 'websocket') {
			const {0: client, 1: server} = new WebSocketPair();
			let player: Player | null = null;

			server.accept();

			const urlParts = url.pathname.match(/\/game\/(\w+)\/party\/(\w+)/);
			if (urlParts) {
				this.gameId = urlParts[1];
				this.partyCode = urlParts[2];
				this.partyId = `${this.gameId}-${this.partyCode}`;
			}


			if (!this.firstHostId) {
				this.firstHostId = await this.state.storage.get<string>('firstHostId') || null;
			}

			// Load game state from storage
			if (!this.gameState) {
				this.gameState = await this.state.storage.get<GameState>('gameState') || null;
			}

			if (!this.gameState) {
				const gameState = await this.dbManager.loadGameStateFromD1(this.partyId);
				if (gameState) {
					this.gameState = gameState;
					this.state.storage.put('gameState', this.gameState).catch(console.error);
				} else {
					this.sendErrorAndClose(server, 'party_not_found');
					return new Response(null, {status: 101, webSocket: client});
				}
			}

			if (!this.gameHandler) {
				this.gameHandler = GameHandlerFactory.createGameHandler(this.gameId);
			}

			server.addEventListener('message', async (event: MessageEvent) => {
				try {
					const data = JSON.parse(event.data as string);

					if (data?.action === 'register' && data.id && data.name) {
						// console.log(`[DEBUG] Register attempt - Party: ${this.partyCode}, GameStarted: ${this.gameState?.gameStarted}, Player: ${data.id}, GameId: ${this.gameState?.gameId}`);
						this.lastAccess = Date.now(); // Update last access
						this.cleanupStaleConnections(data.id);

						// Prevent joining if game already started and not in players
						if (this.gameState?.gameId === 'avalon' && this.gameState.gameStarted &&
							!this.gameState.players.some(p => p.id === data.id)) {
							this.sendErrorAndClose(server, 'game_started');
							return;
						}

						// Handle connection replacement using client-provided tabId
						const incomingTabId = data.tabId; // Client sends tabId from sessionStorage
						for (const [ws, p] of this.connections.entries()) {
							if (p && p.id === data.id && this.shouldReplaceConnection(ws, p, incomingTabId)) {
								ws.send(JSON.stringify({
									action: 'error',
									reason: 'connection_replaced',
									message: 'A newer tab has connected to this party. You can close this page.'
								}));
								try {
									ws.close();
								} catch {
								}
								this.connections.delete(ws);
							}
						}

						player = {
							id: data.id,
							name: data.name,
							connected: true,
							tabId: incomingTabId // Store the tab ID to distinguish between tabs
						};
						this.connections.set(server, player);

						// Add player if not already present
						if (this.gameState && !this.gameState.players.some(p => p.id === data.id)) {
							this.gameState.players.push(player);
							this.state.storage.put('gameState', this.gameState).catch(console.error);
							this.updateHostId();
						} else {
							const p = this.gameState?.players.find(pl => pl.id === data.id);
							if (p) {
								p.connected = true;
								p.disconnectTime = undefined;
								p.tabId = incomingTabId; // Update tab ID
							}
						}

						if (!this.hostId && player?.id) {
							this.hostId = player.id;
						}

						this.broadcastGameState();
						return;
					}

					// Handle pong from client
					if (data?.action === 'pong' && player?.id) {
						this.lastAccess = Date.now(); // Update last access
						const p = this.gameState?.players.find(pl => pl.id === player?.id);
						if (p) {
							p.connected = true;
							p.disconnectTime = undefined;
						}
						return;
					}

					// Handle game-specific messages
					if (this.gameHandler) {
						await this.gameHandler.handleGameMessage(data, player, this);
					}
				} catch (error) {
					// Ignore non-JSON messages
				}
			});

			const cleanup = async () => {
				const player = this.connections.get(server);
				this.connections.delete(server);

				if (this.gameState && player) {
					if (this.gameState.gameStarted) {
						const p = this.gameState.players.find(p => p.id === player.id);
						if (p) {
							p.connected = false;
							p.disconnectTime = Date.now();
						}
					} else {
						this.gameState.players = this.gameState.players.filter(p => p.id !== player.id);
					}
					this.state.storage.put('gameState', this.gameState).catch(console.error);
					this.updateHostId();
					this.broadcastGameState();
				}
			};

			server.addEventListener('close', cleanup);
			server.addEventListener('error', cleanup);


			return new Response(null, {status: 101, webSocket: client});
		}
		return new Response('Expected websocket', {status: 400});
	}


	/////HELPER FUNCTIONS/////

	private sendErrorAndClose(server: WebSocket, reason: string): void {
		try {
			server.send(JSON.stringify({action: 'error', reason}));
		} catch (e) {
		}
		try {
			server.close();
		} catch (e) {
		}
	}

	private cleanupStaleConnections(playerId: string): void {
		for (const [ws, p] of this.connections.entries()) {
			if (p && p.id === playerId && ws.readyState !== 1) {
				this.connections.delete(ws);
			}
		}
	}

	private shouldReplaceConnection(ws: WebSocket, p: Player, incomingTabId?: string): boolean {
		if (ws.readyState === 3) return true; // Closed connection

		if (ws.readyState === 1) {
			// If we have tab IDs, only replace if it's a different tab
			if (incomingTabId !== p.tabId) {
				return true; // Different tab, replace
			}
		}
		return false;
	}

	private updateHostId(): void {
		if (this.firstHostId && this.gameState?.players?.some(p => p.id === this.firstHostId)) {
			this.hostId = this.firstHostId;
		} else if (this.gameState?.players && this.gameState.players.length > 0) {
			const connectedPlayer = this.gameState.players.find(p =>
				Array.from(this.connections.values()).some(connP => connP.id === p.id)
			);
			this.hostId = connectedPlayer?.id || null;
		} else {
			this.hostId = null;
		}
	}

	private async cleanupOrphanedPartyAfter24h() {
		if (!this.gameState) {
			return;
		}

		const allDisconnected = this.gameState.players.every(p => p.connected === false);
		const timeSinceLastAccess = Date.now() - this.lastAccess;
		const twentyFourHours = 12 * 60 * 60 * 1000;

		if (allDisconnected && timeSinceLastAccess > twentyFourHours) {
			// Clear storage and let DO be garbage collected
			this.state.storage.deleteAll().catch(console.error);

			// Stop ping interval
			if (this.pingInterval) {
				clearInterval(this.pingInterval);
				this.pingInterval = null;
			}

			// Close all connections
			for (const [ws, p] of this.connections.entries()) {
				try {
					ws.close();
				} catch {
				}
			}
			this.connections.clear();

			if (this.gameState.gameStarted) {
				await this.dbManager.markGameAsInactive(this.partyId);
			}
		}
	}

	broadcastGameState(options: { gameStarting?: boolean, gameEnding?: boolean } = {}) {
		if (!this.gameState) return;

		// For Avalon game, send player-specific views
		if (this.gameId === 'avalon' && this.gameState.gameStarted && this.gameState.state && 'phase' in this.gameState.state) {
			this.broadcastAvalonGameState(options);
			return;
		}

		// Default broadcast for other games or pre-game state
		const state: any = {action: 'update_state', ...this.gameState, hostId: this.hostId};
		if (options.gameStarting) {
			state.gameStarting = true;
		}

		const msg = JSON.stringify(state, (key, value) => {
			if (key === 'tabId') return undefined;
			return value;
		});
		for (const ws of this.connections.keys()) {
			if (ws.readyState === 1) {
				ws.send(msg);
			}
		}
	}

	private broadcastAvalonGameState(options: { gameStarting?: boolean, gameEnding?: boolean } = {}) {
		if (!this.gameState || !this.gameState.state) return;

		// Pre-calculate common data to avoid repeated calculations
		const votesView = AvalonGameLogic.getVotesView(this.gameState.state as any, this.gameState.players.length);
		const resultsView = AvalonGameLogic.getResultsView(this.gameState.state as any);
		const baseState = {
			action: 'update_state',
			gameId: this.gameState.gameId,
			partyCode: this.gameState.partyCode,
			gameStarted: this.gameState.gameStarted,
			hostId: this.hostId,
			...(options.gameStarting ? { gameStarting: true } : {})
		};

		const { questResults, questVotes, ...stateWithoutResults } = this.gameState.state as any; // cause ...votesView & ...resultsView below cannot override if empty

		for (const [ws, player] of this.connections.entries()) {
			if (ws.readyState === 1) {
				try {
					// Get player-specific view
					const playerView = AvalonGameLogic.getPlayerView(this.gameState.state as any, player.id, this.gameState.players);

					const state: any = {
						...baseState,
						state: {
							...stateWithoutResults,
							...votesView,
							...resultsView,
							...(options.gameEnding ? { gameEnding: true } : {})
						},
						players: playerView.players
					};

					const msg = JSON.stringify(state, (key, value) => {
						if (key === 'tabId') return undefined;
						return value;
					});

					ws.send(msg);
				} catch (error) {
					console.error(`Error sending player view to ${player.id}:`, error);
					// Fallback to default broadcast
					const state: any = { ...baseState, ...this.gameState };
					const msg = JSON.stringify(state, (key, value) => {
						if (key === 'tabId') return undefined;
						return value;
					});
					ws.send(msg);
				}
			}
		}
	}

	startPingInterval() {
		if (this.pingInterval) return;

		this.pingInterval = setInterval(async () => {
			if (!this.gameState) {
				return;
			}

			if (this.connections.size === 0) {
				return;
			}

			const now = Date.now();
			let stateChanged = false;

			// Early exit if no connected players and game not started
			const connectedPlayers = this.gameState.players.filter(p =>
				Array.from(this.connections.values()).some(connP => connP.id === p.id)
			);
			if (connectedPlayers.length === 0 && !this.gameState.gameStarted) {
				return; // Skip work if no active players and game idle
			}

			const connectionMap = new Map<string, WebSocket>();
			for (const [ws, p] of this.connections.entries()) {
				connectionMap.set(p.id, ws);
			}

			for (const player of this.gameState.players) {
				const isConnected = connectionMap.has(player.id);

				if (!isConnected && player.connected !== false) {
					const gracePeriod = 45000;

					if (!player.disconnectTime || (now - player.disconnectTime) > gracePeriod) {
						player.connected = false;
						player.disconnectTime = now;
						stateChanged = true;
					}
				} else if (isConnected) {
					const ws = connectionMap.get(player.id);
					if (ws) {
						const serverVersion = this.env.appVersion || '1.3.0';
						try {
							ws.send(JSON.stringify({
								action: 'ping',
								appVersion: serverVersion
							}));
						} catch {
							// Connection might be closed, remove it
							this.connections.delete(ws);
						}
					}
				}
			}

			// Remove players who have been disconnected for 60s (only if game not started)
			if (!this.gameState.gameStarted) {
				const removedIds: string[] = [];
				this.gameState.players = this.gameState.players.filter(p => {
					if (p.connected === false && p.disconnectTime && now - p.disconnectTime > 60000) {
						removedIds.push(p.id);
						return false;
					}
					return true;
				});

				if (removedIds.length > 0) {
					for (const playerId of removedIds) {
						const ws = connectionMap.get(playerId);
						if (ws) {
							try {
								ws.close();
							} catch {
							}
							this.connections.delete(ws);
						}
					}
					stateChanged = true;
				}
			}

			// Cleanup orphaned parties - MOST PROBABLY REPLACED BY cleanupOrphanedPartyAfter24h BELOW. DO NOT REMOVE THIS!
			// if (this.gameState && !this.gameState.gameStarted && this.gameState.players.length === 0 && this.connections.size === 0) {
			//   fetch('https://internal/cleanup-party', {
			//     method: 'POST',
			//     headers: { 'Content-Type': 'application/json' },
			//     body: JSON.stringify({ partyId: this.partyId })
			//   }).catch(console.error);

			//   if (this.pingInterval) {
			//     clearInterval(this.pingInterval);
			//     this.pingInterval = null;
			//   }
			// }


			if (stateChanged) {
				this.broadcastGameState();
			}

			// Cleanup orphaned parties after 24 hours of inactivity
			this.cleanupOrphanedPartyAfter24h().catch(console.error);
		}, 60000); // Increased from 45s to 60s to reduce CPU usage
	}
}

export default GamePartyState;
