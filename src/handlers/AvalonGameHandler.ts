import { GameHandler } from './GameHandler';
import { Player } from '../interfaces/Player';
import { AvalonState, AvalonSetupState } from '../interfaces/GameState';
import { AvalonGameLogic } from '../gameLogic/AvalonGameLogic';

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

      // Get setup state from current state
      const setupState: AvalonSetupState = {
        specialIds: data.selectedCharacters || ['merlin', 'assassin'],
        isPlayer1Lead1st: data.firstPlayerFlagActive !== undefined ? data.firstPlayerFlagActive : true
      };

      // Initialize the actual game state using AvalonGameLogic
      const gameState = AvalonGameLogic.initializeGame(partyState.gameState.players, setupState);
      partyState.gameState.state = gameState;

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

      partyState.broadcastGameState();
    }

    // Handle avalon_setup_update action - Avalon specific
    if (data && data.action === 'avalon_setup_update' && typeof player.id === 'string' && partyState.hostId && player.id === partyState.hostId) {
      if (!partyState.gameState.state) {
        partyState.gameState.state = {
          specialIds: ['merlin', 'assassin'], // Default selected characters
          isPlayer1Lead1st: true // Default flag state
        } as AvalonSetupState;
      }

      const setupState = partyState.gameState.state as AvalonSetupState;

      // Update special character selections
      if (data.selectedCharacters && Array.isArray(data.selectedCharacters)) {
        setupState.specialIds = data.selectedCharacters;
      }

      // Update flag state
      if (typeof data.firstPlayerFlagActive === 'boolean') {
        setupState.isPlayer1Lead1st = data.firstPlayerFlagActive;
      }

      partyState.broadcastGameState();
    }

    // Handle in-game actions (only after game has started)
    if (partyState.gameState.gameStarted && partyState.gameState.state && 'phase' in partyState.gameState.state) {
      const gameState = partyState.gameState.state as AvalonState;

      // Handle quest team selection
      if (data && data.action === 'select_quest_team' && gameState.phase === 'quest' && player.id === gameState.questLeader) {
        try {
          const newGameState = AvalonGameLogic.handleQuestTeamSelection(
            gameState,
            data.selectedPlayers,
            partyState.gameState.players.length,
            partyState.gameState.players
          );
          partyState.gameState.state = newGameState;
          partyState.broadcastGameState();
        } catch (error) {
          console.error('Quest team selection error:', error);
        }
      }

      // Handle quest voting
      if (data && data.action === 'quest_vote' && gameState.phase === 'voting') {
        const { newState, updatedPlayers } = AvalonGameLogic.handleQuestVoteAndCheckComplete(gameState, player.id, data.approve, partyState.gameState.players);
        partyState.gameState.state = newState;
        partyState.gameState.players = updatedPlayers;
        const isGameEnding = newState.phase === 'end';
        partyState.broadcastGameState({ gameEnding: isGameEnding });
      }

      // Handle quest result submission
      if (data && data.action === 'quest_result' && gameState.phase === 'results' && gameState.questTeam.includes(player.id)) {
        const { newState, updatedPlayers } = AvalonGameLogic.handleQuestResultAndCheckComplete(gameState, player.id, data.success, partyState.gameState.players);
        partyState.gameState.state = newState;
        partyState.gameState.players = updatedPlayers;
        partyState.broadcastGameState();
      }

      // Handle revealing results completion. Any client can send this (in case host is away)
      if (data && data.action === 'reveal_results' && gameState.phase === 'revealing') {
        // Prevent duplicate processing by checking if we've already moved past revealing
        if (partyState.revealResultsProcessed) {
          return; // Already processed, ignore duplicate messages
        }
        
        partyState.revealResultsProcessed = true; // Mark as processed
        
        const { newState, updatedPlayers } = AvalonGameLogic.nextQuest(gameState, partyState.gameState.players);
        partyState.gameState.state = newState;
        if (updatedPlayers) {
          partyState.gameState.players = updatedPlayers;
        }
        const isGameEnding = newState.phase === 'end';
        partyState.broadcastGameState({ gameEnding: isGameEnding });
      }

      // Handle assassination attempt
      if (data && data.action === 'assassinate' && gameState.phase === 'assassinating') {
        const playerRole = gameState.playerRoles.get(player.id);
        if (playerRole === 'assassin') {
          const { newState, updatedPlayers } = AvalonGameLogic.handleAssassination(gameState, data.targetPlayerId);
          partyState.gameState.state = newState;
          if (updatedPlayers) {
            partyState.gameState.players = updatedPlayers;
          }
          partyState.broadcastGameState({ gameEnding: true });
        }
      }
    }

    await partyState.state.storage.put('gameState', partyState.gameState);//save gameState to storage for server restarts
  }
}
