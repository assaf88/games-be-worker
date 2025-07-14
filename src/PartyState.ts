interface Player {
  id: string;
  name: string;
}

interface GameState {
  gameId: string;
  partyId: string;
  players: Player[];
  gameStarted: boolean; // Added gameStarted to GameState
}

function generatePlayerId(): string {
  // Simple GUID-like generator
  return 'xxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function generatePlayerName(): string {
  return `nocookiesyet${Date.now()}`;
}

export class PartyState {
  state: DurableObjectState;
  connections: Map<WebSocket, Player> = new Map();
  gameState: GameState | null = null;
  env: any;
  hostId: string | null = null;
  firstHostId: string | null = null;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  // Helper to upsert game state into D1
  async saveGameStateToD1() {
    // No-op except for start_game
    return;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/init') {
      // Internal initialization request
      try {
        const { id, name, partyId } = await request.json();
        if (!this.gameState) {
          this.gameState = {
            gameId: 'avalon',
            partyId,
            players: [{ id, name }],
            gameStarted: false // Initialize gameStarted
          };
          this.firstHostId = id;
          this.hostId = id;
          await this.state.storage.put('gameState', this.gameState);
          await this.saveGameStateToD1();
          console.log('Party initialized via /init:', partyId, id, name);
        }
        return new Response('OK', { status: 200 });
      } catch (e) {
        return new Response('Bad Request', { status: 400 });
      }
    }
    if (request.headers.get('upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      // Only allow connection if gameState exists in storage or D1
      if (!this.gameState) {
        let stored = await this.state.storage.get<GameState>('gameState');
        if (!stored && this.env && this.env.DB) {
          // Try to load from D1
          const url = new URL(request.url);
          const match = url.pathname.match(/party\/(\w+)/);
          const partyId = match ? match[1] : 'unknown';
          const result = await this.env.DB.prepare('SELECT state_json FROM games WHERE party_id = ? LIMIT 1').bind(partyId).first();
          if (result && result.state_json) {
            stored = JSON.parse(result.state_json);
            await this.state.storage.put('gameState', stored);
          }
        }
        if (stored) {
          this.gameState = stored;
        } else {
          // Party does not exist, block connection
          return new Response('Party not found', { status: 404 });
        }
      }
      server.accept();

      // Remove backend-generated player id and name
      // Wait for client to send 'register' message
      let player: Player | null = null;
      server.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data as string);
          // Handle register action
          if (data.action === 'register' && data.id && data.name) {
            // If gameState does not exist, initialize it now
            if (!this.gameState) {
              const url = new URL(request.url);
              const match = url.pathname.match(/party\/(\w+)/);
              const partyId = match ? match[1] : 'unknown';
              this.gameState = {
                gameId: 'avalon',
                partyId,
                players: []
              };
            }
            // Always add the connection to the map
            player = { id: data.id, name: data.name };
            this.connections.set(server, player);
            // Only add player if not already present
            if (!this.gameState.players.some(p => p.id === data.id)) {
              this.gameState.players.push(player);
              await this.state.storage.put('gameState', this.gameState);
              if (!this.firstHostId) this.firstHostId = player.id;
              if (this.firstHostId && this.gameState.players.some(p => p.id === this.firstHostId)) {
                this.hostId = this.firstHostId;
              } else if (this.gameState.players.length > 0) {
                this.hostId = this.gameState.players[0].id;
              } else {
                this.hostId = null;
              }
              await this.saveGameStateToD1();
            }

            if (!this.hostId && player.id) {
              this.hostId = player.id;
            }

            // Always send the current state to the registering socket
            server.send(JSON.stringify({ action: 'update_state', ...this.gameState, hostId: this.hostId }));
            // And broadcast to all others
            this.broadcastGameState();
            return;
          }
          // Handle ping from client - respond with pong and broadcast state
          if (data.action === 'ping') {
            server.send(JSON.stringify({
              action: 'pong',
              timestamp: Date.now()
            }));
            this.broadcastGameState();
            //console.log('Current open connections for party', this.gameState?.partyId, ':', Array.from(this.connections.values()).map(p => p.id));
            return;
          }
          // Handle start_game action (only host can start)
          if (data.action === 'start_game' && player && player.id && player.id === this.hostId) {
            // Set gameStarted: true and broadcast
            this.gameState.gameStarted = true;
            // Save to DB only on start, and do NOT include hostId/firstHostId in the saved state
            const { hostId, firstHostId, ...stateToSave } = this;
            await this.env.DB.prepare(
              `INSERT INTO games (party_id, game_id, state_json, status, updated_at) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(party_id) DO UPDATE SET game_id=excluded.game_id, state_json=excluded.state_json, status=excluded.status, updated_at=excluded.updated_at`
            ).bind(
              this.gameState.partyId,
              this.gameState.gameId,
              JSON.stringify(this.gameState), // hostId/firstHostId are not in gameState
              'active',
              new Date().toISOString()
            ).run();
            this.broadcastGameState();
            return;
          }
          // For now, just broadcast state on any message
          this.broadcastGameState();
        } catch (error) {
          // Ignore non-JSON messages
        }
      });

      const cleanup = async () => {
        const player = this.connections.get(server);
        this.connections.delete(server);
        if (this.gameState && player) {
          this.gameState.players = this.gameState.players.filter(p => p.id !== player.id);
          await this.state.storage.put('gameState', this.gameState);
          // If the first host is present, they are always the host
          if (this.firstHostId && this.gameState && this.gameState.players && Array.isArray(this.gameState.players) && this.gameState.players.some(p => p.id === this.firstHostId)) {
            this.hostId = this.firstHostId;
          } else if (this.gameState && this.gameState.players && Array.isArray(this.gameState.players) && this.gameState.players.length > 0) {
            this.hostId = this.gameState.players[0].id;
          } else {
            this.hostId = null;
          }
          this.broadcastGameState();
          console.log('Player left and broadcasted:', player.id);
        }
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Expected websocket', { status: 400 });
  }

  broadcastGameState() {
    if (!this.gameState) return;
    const msg = JSON.stringify({ action: 'update_state', ...this.gameState, hostId: this.hostId });
    for (const ws of this.connections.keys()) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}

export default PartyState;
