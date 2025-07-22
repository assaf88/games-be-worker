interface Player {
  id: string;
  name: string;
  order?: number;
  connected?: boolean;
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
  pingInterval: any;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.startPingInterval();
  }

  startPingInterval() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (!this.gameState) return;
      let stateChanged = false;
      for (const player of this.gameState.players) {
        // If not in connections, mark as disconnected
        const isConnected = Array.from(this.connections.values()).some(p => p.id === player.id);
        if (!isConnected) {
          if (player.connected !== false) {
            player.connected = false;
            player.disconnectTime = Date.now();
            stateChanged = true;
          }
        } else {
          // Send ping to connected player
          for (const [ws, p] of this.connections.entries()) {
            if (p.id === player.id) {
              try { ws.send(JSON.stringify({ action: 'ping' })); } catch {}
            } 
          }
        }
      }
      // Remove players who have been disconnected for 60s
      const removedIds = [];
      const now = Date.now();
      const beforePlayers = this.gameState.players.map(p => p.id);
      this.gameState.players = this.gameState.players.filter(p => {
        if (p.connected === false && p.disconnectTime && now - p.disconnectTime > 60000) {
          removedIds.push(p.id);
          return false;
        }
        return true;
      });
      if (removedIds.length > 0) {
        // Remove from connections map as well
        for (const [ws, p] of this.connections.entries()) {
          if (removedIds.includes(p.id)) {
            try { ws.close(); } catch {}
            this.connections.delete(ws);
          }
        }
        console.log('[REMOVE] Players removed after 60s disconnected:', removedIds);
        console.log('[REMOVE] Remaining players:', this.gameState.players.map(p => p.id));
        console.log('[REMOVE] Remaining connections:', Array.from(this.connections.values()).map(p => p.id));
        stateChanged = true;
      }
      if (stateChanged) {
        this.broadcastGameState();
      }
    }, 30000); // Ping every 30s
  }

  // upsert game state into D1
  async saveGameStateToD1() {
    // await this.env.DB.prepare(
    this.env.DB.prepare(
      `INSERT INTO games (party_id, game_id, state_json, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(party_id) DO UPDATE SET game_id=excluded.game_id, state_json=excluded.state_json, status=excluded.status, updated_at=excluded.updated_at`
    ).bind(
      this.gameState.partyId,
      this.gameState.gameId,
      JSON.stringify(this.gameState), // hostId/firstHostId are not in gameState
      'active',
      new Date().toISOString()
    ).run();
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
            players: [{ id, name, connected: true }],
            gameStarted: false // Initialize gameStarted
          };
          this.firstHostId = id;
          this.hostId = id;
          await this.state.storage.put('gameState', this.gameState);
          console.log('[INIT] firstHostId set to', this.firstHostId);
          // await this.saveGameStateToD1();
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
          let data: any = {};
          if (typeof event.data === 'string') {
            try {
              data = JSON.parse(event.data);
            } catch {}
          }
          // Handle register action
          if (data.action === 'register' && typeof data.id === 'string' && typeof data.name === 'string') {
            // If gameState does not exist, initialize it now
            if (!this.gameState) {
              const url = new URL(request.url);
              const match = url.pathname.match(/party\/(\w+)/);
              const partyId = match && match[1] ? match[1] : 'unknown';
              this.gameState = {
                gameId: 'avalon',
                partyId,
                players: [],
                gameStarted: false
              };
            }
            // Ensure only one active connection per player id
            for (const [ws, p] of this.connections.entries()) {
              if (p.id === data.id) {
                try { ws.close(); } catch {}
                this.connections.delete(ws);
              }
            }
            player = { id: data.id, name: data.name, connected: true };
            this.connections.set(server, player);
            // Only add player if not already present
            let stateChanged = false;
            if (this.gameState && !this.gameState.players.some(p => p.id === data.id)) {
              this.gameState.players.push(player);
              await this.state.storage.put('gameState', this.gameState);
              stateChanged = true;
              
              // REMOVE: if (!this.firstHostId) this.firstHostId = player.id;

              // Only set hostId to firstHostId if it is present in players and connections
              const firstHostPresent = this.gameState.players.some(p => p.id === this.firstHostId);
              const firstHostConnected = Array.from(this.connections.values()).some(p => p.id === this.firstHostId);
              if (this.firstHostId && firstHostPresent && firstHostConnected) {
                this.hostId = this.firstHostId;
              } else if (this.gameState.players.length > 0) {
                // Pick first connected player as host
                const connectedPlayer = this.gameState.players.find(p => Array.from(this.connections.values()).some(connP => connP.id === p.id));
                this.hostId = connectedPlayer ? connectedPlayer.id : null;
              } else {
                this.hostId = null;
              }
              console.log('[HOST ASSIGN] firstHostId:', this.firstHostId, 'hostId:', this.hostId);
            }
            if (!this.hostId && player && player.id) {
              this.hostId = player.id;
            }
            // Only broadcast if state changed (player joined)
            if (stateChanged) {
              this.broadcastGameState();
            }
            return;
          }
          // Handle ping from client - respond with pong only
          if (data.action === 'ping') {
            server.send(JSON.stringify({
              action: 'pong',
              timestamp: Date.now()
            }));
            // Do NOT broadcast state on ping
            return;
          }
          // Handle pong from client
          if (data.action === 'pong' && player && player.id) {
            const p = this.gameState.players.find(pl => pl.id === player.id);
            if (p) {
              p.connected = true;
              p.disconnectTime = undefined;
            }
            return;
          }
          // Handle start_game action (only host can start)
          if (data.action === 'start_game' && player && typeof player.id === 'string' && this.hostId && player.id === this.hostId) {
            if (this.gameState) {
              // Normalize player order: sort by current order (nulls last), then assign 1..N
              const sorted = [...this.gameState.players].sort((a, b) => {
                const ao = typeof a.order === 'number' ? a.order : 9999;
                const bo = typeof b.order === 'number' ? b.order : 9999;
                return ao - bo;
              });
              let order = 1;
              for (const p of sorted) {
                p.order = order++;
              }
              // Re-apply sorted order to gameState.players
              this.gameState.players = sorted;
              this.gameState.gameStarted = true;
              // Save to DB only on start, and do NOT include hostId/firstHostId in the saved state
              const { hostId, firstHostId, ...stateToSave } = this;
              this.saveGameStateToD1();
              this.broadcastGameState({ gameStarting: true });
            }
            return;
          }
          if (data.action === 'update_order' && Array.isArray(data.players)) {
            if (this.gameState) {
              // Update order for each player in gameState.players
              for (const update of data.players) {
                const player = this.gameState.players.find(p => p.id === update.id);
                if (player && typeof update.order === 'number') {
                  player.order = update.order;
                }
              }
              // Save to storage and DB
              await this.state.storage.put('gameState', this.gameState);
              await this.saveGameStateToD1();
              this.broadcastGameState();
            }
            return;
          }
          // For now, just broadcast state on any message (except ping)
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

  broadcastGameState(options: { gameStarting?: boolean } = {}) {
    if (!this.gameState) return;
    const state = { action: 'update_state', ...this.gameState, hostId: this.hostId };
    if (options.gameStarting) state.gameStarting = true;
    const msg = JSON.stringify(state);
    for (const ws of this.connections.keys()) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}

export default PartyState;
