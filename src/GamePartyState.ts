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
  gameId: string = 'unknown';
  partyCode: string = 'unknown';
  partyId: string = 'unknown';
  lastAccess: number = Date.now();
  private gameHandler: any = null;

  constructor(state: DurableObjectState, env: any) {
    this.state = state;
    this.env = env;
    this.connections = new Map(); // Clear all connections on worker restart
    this.startPingInterval();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
        
    if (request.method === 'POST' && url.pathname === '/init') {
      try {
        const { id, name, partyCode, gameId } = await request.json() as { id: string, name: string, partyCode: string, gameId: string };
        
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
          await this.state.storage.put('gameState', this.gameState);
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
      
      const urlParts = url.pathname.match(/\/game\/(\w+)\/party\/(\w+)/);
      if (urlParts) {
        this.gameId = urlParts[1];
        this.partyCode = urlParts[2];
        this.partyId = `${this.gameId}-${this.partyCode}`;
      }

      // Load game state from storage
      this.gameState = await this.state.storage.get('gameState');
      
      if (this.gameState) {
        if (!this.gameHandler) {
          this.gameHandler = GameHandlerFactory.createGameHandler(this.gameState.gameId);
          this.gameId = this.gameState.gameId;
        }
      } else {
        // Try to load from D1 database
        if (await this.loadGameStateFromD1()) {
          // Successfully loaded from D1
        } else {
          this.sendErrorAndClose(server, 'party_not_found');
          return new Response(null, { status: 101, webSocket: client });
        }
      }
      
      // Try D1 loading if game state exists but gameStarted is false (stale storage)
      if (this.gameState && !this.gameState.gameStarted) {
        const result = await this.env.DB.prepare('SELECT state_json FROM games WHERE party_id = ? AND status = ? LIMIT 1')
          .bind(this.partyId, 'active').first();
        
        if (result?.state_json) {
          const d1GameState = JSON.parse(result.state_json);
          if (d1GameState?.gameStarted) {
            this.gameState = d1GameState;
            await this.state.storage.put('gameState', this.gameState);
            if (!this.gameHandler) {
              this.gameHandler = GameHandlerFactory.createGameHandler(this.gameState.gameId);
              this.gameId = this.gameState.gameId;
            }
          }
        }
      }

      server.addEventListener('message', async (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data as string);

          if (data?.action === 'register' && data.id && data.name) {
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
                try { ws.close(); } catch {}
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
              await this.state.storage.put('gameState', this.gameState);
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
            const p = this.gameState?.players.find(pl => pl.id === player.id);
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
          await this.state.storage.put('gameState', this.gameState);
          this.updateHostId();
          this.broadcastGameState();
        }
      };

      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);

      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Expected websocket', { status: 400 });
  }

  
  /////HELPER FUNCTIONS/////

  private async loadGameStateFromD1(): Promise<boolean> {
    const result = await this.env.DB.prepare('SELECT state_json FROM games WHERE party_id = ? AND status = ? LIMIT 1')
      .bind(this.partyId, 'active').first();
    
    if (result && result.state_json) {
      this.gameState = JSON.parse(result.state_json);
      await this.state.storage.put('gameState', this.gameState);
      if (!this.gameHandler && this.gameState) {
        this.gameHandler = GameHandlerFactory.createGameHandler(this.gameState.gameId);
        this.gameId = this.gameState.gameId;
      }
      return true;
    }
    return false;
  }

  private sendErrorAndClose(server: WebSocket, reason: string): void {
    try {
      server.send(JSON.stringify({ action: 'error', reason }));
    } catch (e) {}
    try { server.close(); } catch (e) {}
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
      if (incomingTabId && p.tabId && incomingTabId !== p.tabId) {
        return true; // Different tab, replace
      }
      
      // Check if this is likely a post-restart scenario
      const isPostRestart = p.disconnectTime && (Date.now() - p.disconnectTime) < 60000;
      return !isPostRestart; // Replace if not post-restart
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

  private async cleanupOrphanedPartyAfter24h(): Promise<boolean> {
    if (!this.gameState || this.gameState.gameStarted) {
      return false;
    }

    const allDisconnected = this.gameState.players.every(p => p.connected === false);
    const timeSinceLastAccess = Date.now() - this.lastAccess;
    const twentyFourHours = 24 * 60 * 60 * 1000;
    
    if (allDisconnected && timeSinceLastAccess > twentyFourHours) {
      // Clear storage and let DO be garbage collected
      await this.state.storage.deleteAll();
      
      // Stop ping interval
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }
      
      // Close all connections
      for (const [ws, p] of this.connections.entries()) {
        try { ws.close(); } catch {}
      }
      this.connections.clear();
      
      return true; // Indicates cleanup was performed
    }
    
    return false; // No cleanup needed
  }

  broadcastGameState(options: { gameStarting?: boolean } = {}) {
    if (!this.gameState) return;
    
    const state: any = { action: 'update_state', ...this.gameState, hostId: this.hostId };
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

  startPingInterval() {
    if (this.pingInterval) return;
    this.pingInterval = setInterval(async () => {
      if (!this.gameState) return;
      
      let stateChanged = false;
      for (const player of this.gameState.players) {
        const isConnected = Array.from(this.connections.values()).some(p => p.id === player.id);
        
        if (!isConnected && player.connected !== false) {
          const now = Date.now();
          const gracePeriod = 30000;
          
          if (!player.disconnectTime || (now - player.disconnectTime) > gracePeriod) {
            player.connected = false;
            player.disconnectTime = now;
            stateChanged = true;
          }
        } else if (isConnected) {
          // Send ping to connected player
          for (const [ws, p] of this.connections.entries()) {
            if (p.id === player.id) {
              try { ws.send(JSON.stringify({ action: 'ping' })); } catch {}
            } 
          }
        }
      }
      
      // Remove players who have been disconnected for 60s (only if game not started)
      const now = Date.now();
      const removedIds: string[] = [];
      this.gameState.players = this.gameState.players.filter(p => {
        if (this.gameState?.gameStarted) return true;
        if (p.connected === false && p.disconnectTime && now - p.disconnectTime > 60000) {
          removedIds.push(p.id);
          return false;
        }
        return true;
      });
      
      if (removedIds.length > 0) {
        for (const [ws, p] of this.connections.entries()) {
          if (removedIds.includes(p.id)) {
            try { ws.close(); } catch {}
            this.connections.delete(ws);
          }
        }
        stateChanged = true;
      }
      
      // Cleanup orphaned parties - MOST PROBABY REPLACED BY cleanupOrphanedPartyAfter24h BELOW. DO NOT REMOVE THIS!
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
    }, 30000);
  }

  async saveGameStateToD1() {
    if (!this.gameState) return;
    this.env.DB.prepare(
      `INSERT INTO games (party_id, game_id, state_json, status, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(party_id) DO UPDATE SET game_id=excluded.game_id, state_json=excluded.state_json, status=excluded.status, updated_at=excluded.updated_at`
    ).bind(
      this.partyId,
      this.gameState.gameId,
      JSON.stringify(this.gameState),
      'active',
      new Date().toISOString()
    ).run();
  }
}

export default GamePartyState; 