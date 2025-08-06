import { AvalonState, AvalonSetupState } from '../interfaces/GameState';
import { Player } from '../interfaces/Player';
import { AVALON_RULES, getQuestRequirement, getQuestFailRequirement, getEvilPlayerCount, getGoodPlayerCount } from '../gameRules/AvalonRules';

export class AvalonGameLogic {

  /**
   * Initialize the game state after start_game action
   */
  static initializeGame(players: Player[], setupState: AvalonSetupState): AvalonState {
    const playerCount = players.length;
    const evilCount = getEvilPlayerCount(playerCount);
    const goodCount = getGoodPlayerCount(playerCount);

    // Assign roles to players
    const playerRoles = this.assignRoles(players, setupState.specialIds, evilCount, goodCount);

    // Determine first quest leader
    const questLeader = setupState.isPlayer1Lead1st
      ? players.find(p => p.order === 1)?.id || players[0].id
      : players[Math.floor(Math.random() * players.length)].id;

    // Create initial game state
    const gameState: AvalonState = {
      instructionText: this.generateInstruction('quest', questLeader, 1, playerCount, undefined, players),
      phase: 'quest',
      questNumber: 1,
      questLeader: questLeader,
      questTeam: [],
      questSkips: 0,
      completedQuests: [],
      playerRoles: playerRoles,
      questVotes: new Map(),
      questResults: []
    };

    return gameState;
  }

  /**
   * Assign roles to players based on selected special characters
   */
  private static assignRoles(players: Player[], selectedSpecials: string[], evilCount: number, goodCount: number): Map<string, string> {
    const playerRoles = new Map<string, string>();
    const shuffledPlayers = [...players].sort(() => Math.random() - 0.5);

    // Separate special characters
    const specialGood = selectedSpecials.filter(s => AVALON_RULES.goodCharacters.includes(s));
    const specialEvil = selectedSpecials.filter(s => AVALON_RULES.evilCharacters.includes(s));

    // Calculate remaining roles needed
    const remainingGood = goodCount - specialGood.length;
    const remainingEvil = evilCount - specialEvil.length;

    // Assign special characters first
    let playerIndex = 0;

    // Assign special good characters
    for (const special of specialGood) {
      if (playerIndex < shuffledPlayers.length) {
        playerRoles.set(shuffledPlayers[playerIndex].id, special);
        playerIndex++;
      }
    }

    // Assign special evil characters
    for (const special of specialEvil) {
      if (playerIndex < shuffledPlayers.length) {
        playerRoles.set(shuffledPlayers[playerIndex].id, special);
        playerIndex++;
      }
    }

    // Fill remaining good roles
    for (let i = 0; i < remainingGood; i++) {
      if (playerIndex < shuffledPlayers.length) {
        playerRoles.set(shuffledPlayers[playerIndex].id, 'servant');
        playerIndex++;
      }
    }

    // Fill remaining evil roles
    for (let i = 0; i < remainingEvil; i++) {
      if (playerIndex < shuffledPlayers.length) {
        playerRoles.set(shuffledPlayers[playerIndex].id, 'minion');
        playerIndex++;
      }
    }

    return playerRoles;
  }

  /**
   * Generate instruction text based on current phase
   */
  static generateInstruction(phase: string, questLeader: string, questNumber: number, playerCount: number, questTeam?: string[], players?: Player[]): string {
    const getPlayerName = (playerId: string) => {
      if (!players) return playerId;
      const player = players.find(p => p.id === playerId);
      return player ? player.name : playerId;
    };

    const leaderName = getPlayerName(questLeader);

    switch (phase) {
      case 'quest':
        return `${leaderName}, choose your team for quest ${questNumber}`;
      case 'voting':
        return `Everybody vote! Approve or reject the quest team`;
      case 'results':
        if (questTeam && questTeam.length > 0) {
          const teamNames = questTeam.map(getPlayerName).join(', ');
          return `${teamNames}, choose to succeed or fail the quest`;
        }
        return `Choose to succeed or fail the quest`;
      case 'revealing':
        return `Host reveals quest results...`;
      case 'assassinating':
        return `Assassin, choose who you think is Merlin`;
      case 'end':
        return `Game Over!`;
      default:
        return `Unknown phase`;
    }
  }

    /**
   * Get filtered game state for a specific player (with visibility rules applied)
   */
  static getPlayerView(gameState: AvalonState, playerId: string, players: Player[]): any {
    const playerRole = gameState.playerRoles.get(playerId);
    if (!playerRole) {
      throw new Error(`Player ${playerId} not found in game state`);
    }

    // Create a copy of the game state without server-only data
    const clientState = {
      instructionText: gameState.instructionText,
      phase: gameState.phase,
      questNumber: gameState.questNumber,
      questLeader: gameState.questLeader,
      questTeam: gameState.questTeam,
      questSkips: gameState.questSkips,
      completedQuests: gameState.completedQuests
    };

    // Apply visibility rules to players
    const visiblePlayers = players.map(player => {
      const otherPlayerRole = gameState.playerRoles.get(player.id);
      if (!otherPlayerRole || player.id === playerId) {
        return { ...player, specialId: undefined }; // Don't show own role or unknown roles
      }

      const visibilityRule = AVALON_RULES.visibilityRules[playerRole as keyof typeof AVALON_RULES.visibilityRules];
      if (visibilityRule && visibilityRule.canSee.includes(otherPlayerRole)) {
        return { ...player, specialId: visibilityRule.appearsAs };
      }

      return { ...player, specialId: undefined };
    });

    return {
      ...clientState,
      players: visiblePlayers
    };
  }

  /**
   * Get votes view for all players (only when all have voted)
   */
  static getVotesView(gameState: AvalonState, players: Player[]): any {
    const connectedPlayers = players.filter(p => p.connected !== false);
    const votedPlayers = gameState.questVotes.size;
    
    if (votedPlayers >= connectedPlayers.length) {
      // Convert Map to object for JSON serialization
      const votesObject: Record<string, boolean> = {};
      for (const [playerId, vote] of gameState.questVotes.entries()) {
        votesObject[playerId] = vote;
      }
      return { questVotes: votesObject };
    }
    
    return {};
  }

  /**
   * Get results view for all players (only when all quest team members have decided)
   */
  static getResultsView(gameState: AvalonState): any {
    if (gameState.questResults.length >= gameState.questTeam.length) {
      return { questResults: [...gameState.questResults] };
    }
    
    return {};
  }

  /**
   * Handle quest team selection
   */
  static handleQuestTeamSelection(gameState: AvalonState, selectedPlayers: string[], playerCount: number, players: Player[]): AvalonState {
    const requiredPlayers = getQuestRequirement(playerCount, gameState.questNumber);

    if (selectedPlayers.length !== requiredPlayers) {
      throw new Error(`Invalid team size. Need ${requiredPlayers} players, got ${selectedPlayers.length}`);
    }

    return {
      ...gameState,
      questTeam: selectedPlayers,
      phase: 'voting',
      instructionText: this.generateInstruction('voting', gameState.questLeader, gameState.questNumber, playerCount, undefined, players)
    };
  }

  /**
   * Handle quest voting and check if all players have voted, transitioning state if so.
   */
  static handleQuestVoteAndCheckComplete(gameState: AvalonState, playerId: string, vote: boolean, players: Player[]): AvalonState {
    // Add/update the vote
    const newVotes = new Map(gameState.questVotes);
    newVotes.set(playerId, vote);

    // Mark voted:true for this player
    let updatedPlayers = players.map(player =>
      newVotes.has(player.id) ? { ...player, voted: true } : { ...player, voted: false }
    );

    const votedPlayers = newVotes.size;
    if (votedPlayers === players.length) {
      // All players have voted, clear voted:true for all
      updatedPlayers = updatedPlayers.map(p => ({ ...p, voted: false }));

      // Count votes
      let approveVotes = 0;
      let rejectVotes = 0;
      for (const v of newVotes.values()) {
        if (v) approveVotes++;
        else rejectVotes++;
      }

      // Check if quest was rejected (tie goes to rejection)
      if (rejectVotes >= approveVotes) {
        const newSkips = gameState.questSkips + 1;
        if (newSkips >= 5) {
          // Evil wins by quest rejection
          return {
            ...gameState,
            phase: 'end',
            questSkips: newSkips,
            instructionText: 'Evil wins! Too many quest rejections.'
          };
        }
        // Quest rejected - move to next leader, same quest
        const currentLeaderOrder = players.find(p => p.id === gameState.questLeader)?.order || 1;
        const nextLeader = players.find(p => p.order === (currentLeaderOrder + 1) % players.length)?.id || players[0].id;
        return {
          ...gameState,
          questLeader: nextLeader,
          questTeam: [],
          questSkips: newSkips,
          phase: 'quest',
          instructionText: this.generateInstruction('quest', nextLeader, gameState.questNumber, players.length, undefined, players),
          questVotes: new Map(),
          questResults: []
        };
      }
      // Quest approved, move to results phase
      return {
        ...gameState,
        phase: 'results',
        instructionText: this.generateInstruction('results', gameState.questLeader, gameState.questNumber, players.length, gameState.questTeam, players),
        questVotes: newVotes
      };
    }
    // Not all have voted, keep voted:true for those who have voted
    return {
      ...gameState,
      questVotes: newVotes
    };
  }

  /**
   * Handle quest result submission
   */
  static handleQuestResult(gameState: AvalonState, playerId: string, success: boolean, players: Player[]): AvalonState {
    const newResults = [...gameState.questResults];
    newResults.push(success);

    // Update player decided status
    const updatedPlayers = players.map(player => 
      player.id === playerId 
        ? { ...player, decided: true }
        : player
    );

    return {
      ...gameState,
      questResults: newResults
    };
  }

  /**
   * Check if all quest team members have submitted results
   */
  static checkResultsComplete(gameState: AvalonState, players: Player[]): AvalonState {
    if (gameState.questResults.length >= gameState.questTeam.length) {
      // Count results
      let successCount = 0;
      let failCount = 0;

      for (const result of gameState.questResults) {
        if (result) successCount++;
        else failCount++;
      }

      const requiredFails = getQuestFailRequirement(gameState.questTeam.length, gameState.questNumber);
      const questSuccess = failCount < requiredFails;

      // Update completed quests
      const newCompletedQuests = [...gameState.completedQuests];
      newCompletedQuests[gameState.questNumber - 1] = questSuccess;

      return {
        ...gameState,
        completedQuests: newCompletedQuests,
        phase: 'revealing',
        instructionText: this.generateInstruction('revealing', gameState.questLeader, gameState.questNumber, gameState.questTeam.length, undefined, players)
      };
    }

    return gameState;
  }

  /**
   * Move to next quest or end game
   */
  static nextQuest(gameState: AvalonState, players: Player[]): AvalonState {
    const nextQuestNumber = gameState.questNumber + 1;

    // Check win conditions
    const successCount = gameState.completedQuests.filter(q => q === true).length;
    const failCount = gameState.completedQuests.filter(q => q === false).length;

    if (successCount >= 3) {
      // Good team wins, move to assassination
      return {
        ...gameState,
        phase: 'assassinating',
        instructionText: this.generateInstruction('assassinating', gameState.questLeader, gameState.questNumber, players.length)
      };
    }

    if (failCount >= 3) {
      return {
        ...gameState,
        phase: 'end',
        instructionText: 'Evil wins! Three quests failed.'
      };
    }

    if (nextQuestNumber > 5) {
      // Game should have ended by now, but just in case
      return {
        ...gameState,
        phase: 'end',
        instructionText: 'Game Over!'
      };
    }

    // Move to next quest
    const nextLeaderIndex = (gameState.questNumber) % players.length;
    const nextLeader = players[nextLeaderIndex].id;

            return {
          ...gameState,
          questNumber: nextQuestNumber,
          questLeader: nextLeader,
          questTeam: [],
          questSkips: 0, // Reset skips for new quest
          phase: 'quest',
          instructionText: this.generateInstruction('quest', nextLeader, nextQuestNumber, players.length, undefined, players),
          questVotes: new Map(),
          questResults: []
        };
  }

  /**
   * Handle assassination attempt
   */
  static handleAssassination(gameState: AvalonState, targetPlayerId: string): AvalonState {
    const targetRole = gameState.playerRoles.get(targetPlayerId);
    const assassinWins = targetRole === 'merlin';

    return {
      ...gameState,
      phase: 'end',
      instructionText: assassinWins ? 'Evil wins! Merlin was assassinated.' : 'Good wins! Merlin survived.'
    };
  }
}
