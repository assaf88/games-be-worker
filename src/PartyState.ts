interface Player {
  id: string;
  name: string;
}

interface GameState {
  gameId: string;
  partyId: string;
  players: Player[];
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

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
  }

  // Helper to upsert game state into D1
  async saveGameStateToD1() {
    if (!this.env || !this.env.DB || !this.gameState) {
      console.error("D1 env or gameState missing", {
        hasEnv: !!this.env,
        hasDB: !!(this.env && this.env.DB),
        hasGameState: !!this.gameState
      });
      return;
    }
    try {
      const { gameId, partyId } = this.gameState;
      const stateJson = JSON.stringify(this.gameState);
      const status = 'active';
      const updatedAt = new Date().toISOString();
      console.log("Attempting to save game state to D1 for party_id:", partyId);
      await this.env.DB.prepare(
        `INSERT INTO games (party_id, game_id, state_json, status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(party_id) DO UPDATE SET game_id=excluded.game_id, state_json=excluded.state_json, status=excluded.status, updated_at=excluded.updated_at`
      ).bind(partyId, gameId, stateJson, status, updatedAt).run();
      console.log("Saved game state to D1 for party_id:", partyId);
    } catch (err) {
      console.error("Failed to save game state to D1:", err);
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();

      // Load or initialize game state
      if (!this.gameState) {
        const stored = await this.state.storage.get<GameState>('gameState');
        if (stored) {
          this.gameState = stored;
        } else {
          // Extract partyId from URL
          const url = new URL(request.url);
          const match = url.pathname.match(/party\/(\w+)/);
          const partyId = match ? match[1] : 'unknown';
          this.gameState = {
            gameId: 'avalon',
            partyId,
            players: []
          };
          await this.state.storage.put('gameState', this.gameState);
          await this.saveGameStateToD1();
        }
      }

      // Generate player id and name
      const player: Player = {
        id: generatePlayerId(),
        name: generatePlayerName()
      };
      this.connections.set(server, player);
      this.gameState.players.push(player);
      await this.state.storage.put('gameState', this.gameState);
      await this.saveGameStateToD1();
      this.broadcastGameState();

      server.addEventListener('message', async (event) => {
        try {
          const data = JSON.parse(event.data as string);
          // Handle ping from client - respond with pong and broadcast state
          if (data.action === 'ping') {
            server.send(JSON.stringify({ 
              action: 'pong', 
              timestamp: Date.now() 
            }));
            this.broadcastGameState();
            return;
          }
          // Handle other actions (e.g., play_card, join_game, etc.)
          // For now, just broadcast state on any message
          await this.state.storage.put('gameState', this.gameState);
          await this.saveGameStateToD1();
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
          await this.saveGameStateToD1();
          this.broadcastGameState();
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
    const msg = JSON.stringify({ action: 'update_state', ...this.gameState });
    for (const ws of this.connections.keys()) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}

export default PartyState;
