import { GameHandler } from './GameHandler';
import { Player } from '../interfaces/Player';

export class AvalonGameHandler implements GameHandler {
  async handleGameMessage(data: any, player: Player | null, partyState: any): Promise<void> {
    if (!partyState.gameState || !player) return;

    // Handle start_game action (only host can start) - Avalon specific
    if (data && data.action === 'start_game' && typeof player.id === 'string' && partyState.hostId && player.id === partyState.hostId) {
      if (partyState.gameState) {
        // Normalize player order: sort by current order (nulls last), then assign 1..N
        const sorted = [...partyState.gameState.players].sort((a: any, b: any) => {
          const ao = typeof a.order === 'number' ? a.order : 9999;
          const bo = typeof b.order === 'number' ? b.order : 9999;
          return ao - bo;
        });
        let order = 1;
        for (const p of sorted) {
          p.order = order++;
        }
        // Re-apply sorted order to gameState.players
        partyState.gameState.players = sorted;
        partyState.gameState.gameStarted = true;
        // Save to DB only on start, and do NOT include hostId/firstHostId in the saved state
        await partyState.saveGameStateToD1();
        partyState.broadcastGameState({ gameStarting: true });
      }
      return;
    }

    // Handle update_order action - Avalon specific
    if (data && data.action === 'update_order' && Array.isArray(data.players)) {
      if (partyState.gameState) {
        // Update order for each player in gameState.players
        for (const update of data.players) {
          const player = partyState.gameState.players.find((p: any) => p.id === update.id);
          if (player && typeof update.order === 'number') {
            player.order = update.order;
          }
        }
        // Save to storage and DB
        await partyState.state.storage.put('gameState', partyState.gameState);
        await partyState.saveGameStateToD1();
        partyState.broadcastGameState();
      }
      return;
    }
  }
} 