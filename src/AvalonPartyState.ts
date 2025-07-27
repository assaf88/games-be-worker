import { PartyState } from './PartyState';
// import { GameState } from './GameState';
import { Player } from './Player';

export class AvalonPartyState extends PartyState {
  constructor(state: DurableObjectState, env: any) {
    super(state, env);
    this.gameId = 'avalon';
  }

  // Override the message handler to add Avalon-specific logic
  protected async handleGameMessage(data: any, player: Player | null): Promise<void> {
    if (!this.gameState || !player) return;

    // Handle start_game action (only host can start) - Avalon specific
    if (data && data.action === 'start_game' && typeof player.id === 'string' && this.hostId && player.id === this.hostId) {
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
        await this.saveGameStateToD1();
        this.broadcastGameState({ gameStarting: true });
      }
      return;
    }

    // Handle update_order action - Avalon specific
    if (data && data.action === 'update_order' && Array.isArray(data.players)) {
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

    // Call parent handler for other actions
    // await super.handleGameMessage(data, player);
  }
} 