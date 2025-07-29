import { GameState } from './interfaces/GameState';
import { Player } from './interfaces/Player';
import { GameHandlerFactory } from './handlers/GameHandlerFactory';

export class GamePartyState {
  state: DurableObjectState;
  connections: Map<WebSocket, Player> = new Map();
  gameState: GameState | null = null;
  env: any;
  hostId: string | null = null;
  firstHostId: string | null = null;
  pingInterval: any;
  private gameId: string = 'unknown';
  private gameHandler: any = null; // Will hold the specific game handler

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.connections = new Map(); // Clear all connections on worker restart
    this.startPingInterval();
  }

  
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/init') {
      // Internal initialization request
      try {
        const requestData = await request.json() as { id: string, name: string, partyCode: string, gameId: string };
        const { id, name, partyCode, gameId } = requestData;
        
        // Initialize the game handler based on gameId
        if (!this.gameHandler) {
          this.gameHandler = GameHandlerFactory.createGameHandler(gameId);
          this.gameId = gameId;
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
          await this.state.storage.put('gameState', this.gameState);
          console.log('[INIT] firstHostId set to', this.firstHostId);
          console.log('Party initialized via /init:', partyCode, id, name);
        }
        return new Response('OK', { status: 200 });
      } catch (e) {
        return new Response('Bad Request', { status: 400 });
      }
    }

    if (request.headers.get('upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      let player: Player | null = null;

      server.accept();
      
      this.gameState = await this.state.storage.get('gameState');
      console.log('Loaded gameState from storage:', this.gameState);
      if (this.gameState) {
        //this part may look duplicate with the init, but it's necessary to have for old created parties
        if (!this.gameHandler) {
          this.gameHandler = GameHandlerFactory.createGameHandler(this.gameState.gameId);
          this.gameId = this.gameState.gameId;
        }
        // Only set connection if player is not null (will be set on register)
      } else {
        // Try to load from D1 database for started games
        // Extract partyId from the request URL
        const url = new URL(request.url);
        const gameMatch = url.pathname.match(/\/game\/(\w+)\/party\/(\w+)/);
        if (gameMatch) {
          const gameId = gameMatch[1];
          const partyCode = gameMatch[2];
          const partyId = `${gameId}-${partyCode}`;
          
          // Check if this is a started game (rate limiting: only query DB for started games)
          console.log('Trying to load from D1 for partyId:', partyId);
          const result = await this.env.DB.prepare('SELECT state_json FROM games WHERE party_id = ? AND status = ? LIMIT 1').bind(partyId, 'active').first();
          if (result && result.state_json) {
            console.log('Found game state in D1, restoring...');
            this.gameState = JSON.parse(result.state_json);
            console.log('Restored game state:', this.gameState);
            await this.state.storage.put('gameState', this.gameState);
            if (!this.gameHandler && this.gameState) {
              this.gameHandler = GameHandlerFactory.createGameHandler(this.gameState.gameId);
              this.gameId = this.gameState.gameId;
            }
          } else {
            // Party not found, return error so FE can show Disconnected banner
            try {
              server.send(JSON.stringify({ action: 'error', reason: 'party_not_found' }));
            } catch (e) {}
            try { server.close(); } catch (e) {}
            return new Response(null, { status: 101, webSocket: client });
          }
        } else {
          // Party not found, return error so FE can show Disconnected banner
          try {
            server.send(JSON.stringify({ action: 'error', reason: 'party_not_found' }));
          } catch (e) {}
          try { server.close(); } catch (e) {}
          return new Response(null, { status: 101, webSocket: client });
        }
      }
      
      // Also try D1 loading if game state exists but gameStarted is false (might be stale storage)
      if (this.gameState && !this.gameState.gameStarted) {
        const url = new URL(request.url);
        const gameMatch = url.pathname.match(/\/game\/(\w+)\/party\/(\w+)/);
        if (gameMatch) {
          const gameId = gameMatch[1];
          const partyCode = gameMatch[2];
          const partyId = `${gameId}-${partyCode}`;
          
          console.log('Game state exists but gameStarted is false, trying D1 for partyId:', partyId);
          const result = await this.env.DB.prepare('SELECT state_json FROM games WHERE party_id = ? AND status = ? LIMIT 1').bind(partyId, 'active').first();
          console.log('D1 query result:', result);
          if (result && result.state_json) {
            const d1GameState = JSON.parse(result.state_json);
            if (d1GameState && d1GameState.gameStarted) {
              console.log('Found started game in D1, overriding storage state');
              this.gameState = d1GameState;
              await this.state.storage.put('gameState', this.gameState);
              if (!this.gameHandler && this.gameState) {
                this.gameHandler = GameHandlerFactory.createGameHandler(this.gameState.gameId);
                this.gameId = this.gameState.gameId;
              }
            }
          }
        }
      }

      server.addEventListener('message', async (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          // console.log('WebSocket message received:', data);

          if (data && data.action === 'register' && data.id && data.name) {
            console.log('Before cleanup - connections:', Array.from(this.connections.entries()).map(([ws, p]) => ({ playerId: p?.id, readyState: ws.readyState })));
            // Clean up all connections for this player that are not open
            for (const [ws, p] of this.connections.entries()) {
              if (p && p.id === data.id && ws.readyState !== 1) {
                console.log('Removing stale connection for player:', p.id);
                this.connections.delete(ws);
              }
            }
            console.log('After cleanup - connections:', Array.from(this.connections.entries()).map(([ws, p]) => ({ playerId: p?.id, readyState: ws.readyState })));
            // Load existing game state if available
            // if (!this.gameState) {
            //   this.gameState = await this.state.storage.get('gameState');
            // }
            // // Check if this party was ever properly initialized
            // if (!this.gameState || this.gameState.partyCode === 'unknown') {
            //   server.send(JSON.stringify({ action: 'error', reason: 'party_not_found' }));
            //   try { server.close(); } catch {}
            //   return;
            // }
            console.log('[REGISTER] Incoming player_id:', data.id);
            if (this.gameState && this.gameState.players) {
              console.log('[REGISTER] Current players:', this.gameState.players.map(p => p.id));
            }
            // Prevent joining if game already started and not in players
            if (
              this.gameState &&
              this.gameState.gameId === 'avalon' &&
              this.gameState.gameStarted &&
              !this.gameState.players.some(p => p.id === data.id)
            ) {
              server.send(JSON.stringify({ action: 'error', reason: 'game_started' }));
              try { server.close(); } catch {}
              return;
            }
            // Allow multiple connections from same player, but make the newest connection primary
            for (const [ws, p] of this.connections.entries()) {
              console.log('Connection entry - ws.readyState:', ws.readyState, 'player:', p?.id, 'incoming player:', data.id);
              if (p && data && typeof data.id === 'string' && p.id === data.id) {
                console.log('MATCH FOUND - ws.readyState:', ws.readyState, 'player:', p.id, 'incoming player:', data.id);
                
                // Replace if connection is closed, OR if it's open but we're not in a post-restart scenario
                // Check if this is likely a post-restart scenario by looking at disconnectTime
                const isPostRestart = p.disconnectTime && (Date.now() - p.disconnectTime) < 60000; // Within 1 minute
                console.log('Replacement check - ws.readyState:', ws.readyState, 'isPostRestart:', isPostRestart, 'disconnectTime:', p.disconnectTime);
                
                if (ws.readyState === 3 || (ws.readyState === 1 && !isPostRestart)) {
                  console.log('Replacing connection - closed or legitimate new tab');
                  // Send message to old connection to refresh/close
                  ws.send(JSON.stringify({ 
                    action: 'error', 
                    reason: 'connection_replaced',
                    message: 'A newer tab has connected to this party. You can close this page.'
                  }));
                  try { ws.close(); } catch {}
                  this.connections.delete(ws);
                } else {
                  console.log('Connection is still open and likely post-restart, not replacing - browser might be throttling');
                  // Don't send replacement message, just continue
                }
              }
            }
            player = { id: data.id, name: data.name, connected: true };
            this.connections.set(server, player);
            // Only add player if not already present
            // let stateChanged = false;
            if (this.gameState && !this.gameState.players.some(p => p.id === data.id)) {
              this.gameState.players.push(player);
              await this.state.storage.put('gameState', this.gameState);
              // stateChanged = true;
              
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
            } else {
              const p = this.gameState.players.find(pl => pl.id === data.id);
              if (p) {
                p.connected = true;
                p.disconnectTime = undefined;
              }
            }
            if (!this.hostId && player && player.id) {
              this.hostId = player.id;
            }
            // Always broadcast state after registration, even if not newly added
            this.broadcastGameState();
            return;
          }
          // Handle ping from client - respond with pong only
          if (data && data.action === 'ping') {
            server.send(JSON.stringify({
              action: 'pong',
              timestamp: Date.now()
            }));
            return;
          }
          // Handle pong from client
          if (data && data.action === 'pong' && player && player.id) {
            const p = this.gameState.players.find(pl => pl.id === player.id);
            if (p) {
              p.connected = true;
              p.disconnectTime = undefined;
            }
            return;
          }
          
          // Handle game-specific messages using the game handler
          console.log('1');
          if (this.gameHandler) {
            console.log('2');
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
            // Just mark as disconnected
            const p = this.gameState.players.find(p => p.id === player?.id);
            if (p) {
              p.connected = false;
              p.disconnectTime = Date.now();
            }
          } else {
            // Only remove if game not started
            this.gameState.players = this.gameState.players.filter(p => p.id !== player?.id);
          }
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
          console.log('Player left and broadcasted:', player?.id);
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
    
    const state: any = { action: 'update_state', ...this.gameState, hostId: this.hostId };
    if (options.gameStarting) {
      (state as any).gameStarting = true;
      console.log('Broadcasting gameStarting: true');
    }
    const msg = JSON.stringify(state);
    console.log('Broadcasting message:', msg);
    for (const ws of this.connections.keys()) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }

  startPingInterval() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(() => {
      if (!this.gameState) return;
      let stateChanged = false;
      for (const player of this.gameState.players) {
        // If not in connections, mark as disconnected
        const isConnected = Array.from(this.connections.values()).some(p => p.id === player.id);
        console.log('PING: Checking player:', player.id, 'isConnected:', isConnected, 'connections:', Array.from(this.connections.values()).map(p => p.id));
        if (!isConnected) {
          if (player.connected !== false) {
            // Don't mark as disconnected immediately after server restart
            // Give players time to re-register (30 seconds grace period)
            const now = Date.now();
            const gracePeriod = 30000; // 30 seconds
            
            if (!player.disconnectTime || (now - player.disconnectTime) > gracePeriod) {
              console.log('PING: Marking player as disconnected:', player.id, 'connections count:', this.connections.size);
              player.connected = false;
              player.disconnectTime = now;
              stateChanged = true;
            } else {
              console.log('PING: Skipping disconnect for player:', player.id, 'within grace period');
            }
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
      const removedIds: string[] = [];
      const now = Date.now();
      this.gameState.players = this.gameState.players.filter(p => {
        // During an active game, never remove disconnected players
        if (this.gameState && this.gameState.gameStarted) {
          return true;
        }
        // Only remove if not in an active game
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
      
      // Cleanup orphaned parties (no players, no game started)
      if (this.gameState && !this.gameState.gameStarted && this.gameState.players.length === 0 && this.connections.size === 0) {
        const partyId = `${this.gameState.gameId}-${this.gameState.partyCode}`;
        console.log('[CLEANUP] Orphaned party detected:', partyId);
        
        // Call cleanup endpoint to remove from in-memory tracking
        fetch('https://internal/cleanup-party', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ partyId })
        }).catch(console.error);
        
        // Stop the ping interval for this orphaned party
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }
      }
      
      if (stateChanged) {
        this.broadcastGameState();
      }
    }, 30000); // Ping every 30s
  }

  // upsert game state into D1
  async saveGameStateToD1() {
    if (!this.gameState) return;
    const partyId = `${this.gameState.gameId}-${this.gameState.partyCode}`;
    console.log('Saving game state to D1 with partyId:', partyId);
    this.env.DB.prepare(
      `INSERT INTO games (party_id, game_id, state_json, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(party_id) DO UPDATE SET game_id=excluded.game_id, state_json=excluded.state_json, status=excluded.status, updated_at=excluded.updated_at`
    ).bind(
      partyId,
      this.gameState.gameId,
      JSON.stringify(this.gameState),
      'active',
      new Date().toISOString()
    ).run();
    return;
  }
}

export default GamePartyState; 