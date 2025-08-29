import { GameHandler } from './GameHandler';
import { Player } from '../interfaces/Player';
import { CodenamesState, CodenamesSetupState } from '../interfaces/GameState';
import { CodenamesGameLogic } from '../gameLogic/CodenamesGameLogic';

export class CodenamesGameHandler implements GameHandler {
  async handleGameMessage(data: any, player: Player | null, partyState: any): Promise<void> {
    if (!partyState.gameState || !player) {
      return;
    }

    // Handle start_game action (only host can start) - Codenames specific
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

      // Get setup state from current state
      const setupState: CodenamesSetupState = {
        redSpymasterId: data.redSpymasterId || null,
        blueSpymasterId: data.blueSpymasterId || null,
        wordBank: data.wordBank || 'english'
      };

      // Initialize the actual game state using CodenamesGameLogic
      const gameState = CodenamesGameLogic.initializeGame(partyState.gameState.players, setupState);
      partyState.gameState.state = gameState;

      partyState.dbManager.saveGameStateToD1(partyState.partyId, partyState.gameId, partyState.gameState);
      partyState.broadcastGameState({ gameStarting: true });
    }

    // Handle update_order action - Codenames specific
    if (data && data.action === 'update_order' && Array.isArray(data.players)) {
      // Update order for each player in gameState.players
      for (const update of data.players) {
        const player = partyState.gameState.players.find((p: any) => p.id === update.id);
        if (player && typeof update.order === 'number') {
          player.order = update.order;
        }
      }

      partyState.broadcastGameState();
    }

    // Handle codenames_setup_update action - Codenames specific
    if (data && data.action === 'codenames_setup_update' && typeof player.id === 'string' && partyState.hostId && player.id === partyState.hostId) {
      if (!partyState.gameState.state) {
        partyState.gameState.state = {
          redSpymasterId: null,
          blueSpymasterId: null,
          wordBank: 'english'
        } as CodenamesSetupState;
      }

      const setupState = partyState.gameState.state as CodenamesSetupState;

      // Update spymaster selections
      if (data.redSpymasterId && typeof data.redSpymasterId === 'string') {
        setupState.redSpymasterId = data.redSpymasterId;
      }

      if (data.blueSpymasterId && typeof data.blueSpymasterId === 'string') {
        setupState.blueSpymasterId = data.blueSpymasterId;
      }

      // Update word bank
      if (data.wordBank && typeof data.wordBank === 'string') {
        setupState.wordBank = data.wordBank;
      }

      partyState.broadcastGameState();
    }

    // Handle in-game actions (only after game has started)
    if (partyState.gameState.gameStarted && partyState.gameState.state && 'phase' in partyState.gameState.state) {
      const gameState = partyState.gameState.state as CodenamesState;

      // Handle clue submission
      if (data && data.action === 'submit_clue' && gameState.phase === 'clue') {
        try {
          const newGameState = CodenamesGameLogic.handleClueSubmission(
            gameState,
            data.clueWord,
            data.clueNumber,
            player.id
          );
          partyState.gameState.state = newGameState;
          partyState.broadcastGameState();
        } catch (error) {
          console.error('Error handling clue submission:', error);
          // Could send error message back to player
        }
      }

      // Handle card guess
      if (data && data.action === 'guess_card' && gameState.phase === 'guessing') {
        try {
          const newGameState = CodenamesGameLogic.handleCardGuess(
            gameState,
            data.cardIndex,
            player.id
          );
          partyState.gameState.state = newGameState;
          partyState.broadcastGameState();
        } catch (error) {
          console.error('Error handling card guess:', error);
          // Could send error message back to player
        }
      }

      // Handle end turn action
      if (data && data.action === 'end_turn' && gameState.phase === 'guessing') {
        try {
          const newGameState = CodenamesGameLogic.endTurn(gameState);
          partyState.gameState.state = newGameState;
          partyState.broadcastGameState();
        } catch (error) {
          console.error('Error handling end turn:', error);
        }
      }
    }
  }

  getClientVisibleGameState(gameState: any, playerId: string): any {
    if (!gameState || !gameState.state || !('phase' in gameState.state)) {
      return gameState;
    }

    const codenamesState = gameState.state as CodenamesState;
    const clientVisibleState = CodenamesGameLogic.getClientVisibleState(codenamesState, playerId);

    return {
      ...gameState,
      state: clientVisibleState
    };
  }
}
