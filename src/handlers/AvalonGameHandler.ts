import { GameHandler } from './GameHandler';
import { Player } from '../interfaces/Player';
import { AvalonState } from '../interfaces/GameState';

export class AvalonGameHandler implements GameHandler {
  async handleGameMessage(data: any, player: Player | null, partyState: any): Promise<void> {
    if (!partyState.gameState || !player) {
      return;
    }
    
    // Handle start_game action (only host can start) - Avalon specific
    if (data && data.action === 'start_game' && typeof player.id === 'string' && partyState.hostId && player.id === partyState.hostId) {
      const playerOrderMap = new Map<string, number>();
      data.players.forEach((p: any) => {
        if (typeof p.id === 'string') {
          playerOrderMap.set(p.id, p.order);
        }
      })
      const sorted = [...partyState.gameState.players].sort((a: any, b: any) => {
        const aOrder = playerOrderMap.get(a.id) || 9999;
        const bOrder = playerOrderMap.get(b.id) || 9999;
        return aOrder - bOrder;
      });
      let order = 1;
      for (const p of sorted) {
        p.order = order++;
      }
      partyState.gameState.players = sorted;

      partyState.gameState.gameStarted = true;

      // Initialize AvalonState with setup data if provided
      if (data.selectedCharacters && data.firstPlayerFlagActive !== undefined) {
        partyState.gameState.state = {
          specialIds: data.selectedCharacters,
          isPlayer1Lead1st: data.firstPlayerFlagActive
        } as AvalonState;
      } else {
        // Default Avalon state if no setup data provided
        partyState.gameState.state = {
          specialIds: ['merlin', 'assassin'],
          isPlayer1Lead1st: true
        } as AvalonState;
      }

      partyState.dbManager.saveGameStateToD1(partyState.partyId, partyState.gameId, partyState.gameState);
      partyState.broadcastGameState({ gameStarting: true });
    }

    // Handle update_order action - Avalon specific
    if (data && data.action === 'update_order' && Array.isArray(data.players)) {
      // Update order for each player in gameState.players
      for (const update of data.players) {
        const player = partyState.gameState.players.find((p: any) => p.id === update.id);
        if (player && typeof update.order === 'number') {
          player.order = update.order;
        }
      }
      
      // await partyState.state.storage.put('gameState', partyState.gameState);
      partyState.broadcastGameState();
    }

    // Handle avalon_setup_update action - Avalon specific
    if (data && data.action === 'avalon_setup_update' && typeof player.id === 'string' /*&& partyState.hostId && player.id === partyState.hostId*/) {
      if (!partyState.gameState.state) {
        partyState.gameState.state = {
          specialIds: ['merlin', 'assassin'], // Default selected characters
          isPlayer1Lead1st: true // Default flag state
        } as AvalonState;
      }

      const avalonState = partyState.gameState.state as AvalonState;
      
      // Update special character selections
      if (data.selectedCharacters && Array.isArray(data.selectedCharacters)) {
        avalonState.specialIds = data.selectedCharacters;
      }
      
      // Update flag state
      if (typeof data.firstPlayerFlagActive === 'boolean') {
        avalonState.isPlayer1Lead1st = data.firstPlayerFlagActive;
      }
      
      partyState.broadcastGameState();
    }

    await partyState.state.storage.put('gameState', partyState.gameState);//save gameState to storage for server restarts

  }
} 