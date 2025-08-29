import { CodenamesState, CodenamesCard, CodenamesSetupState } from '../interfaces/GameState';
import { Player } from '../interfaces/Player';
import { WORD_BANKS, SupportedLanguage } from './WordBanks';

export class CodenamesGameLogic {

  static initializeGame(players: Player[], setupState: CodenamesSetupState): CodenamesState {
    if (!setupState.redSpymasterId || !setupState.blueSpymasterId) {
      throw new Error('Both spymasters must be selected before starting the game');
    }

    // Select 25 random words from the word bank
    const selectedWords = this.getRandomWords(25, setupState.wordBank as SupportedLanguage);
    
    // Create the word map (which cards belong to which team)
    const wordMap = this.createWordMap();
    
    // Create the board with cards
    const board: CodenamesCard[] = selectedWords.map((word, index) => ({
      word,
      revealed: false,
      type: wordMap.get(index)
    }));

    // Count remaining cards for each team
    const redTeamRemaining = Array.from(wordMap.values()).filter(type => type === 'red').length;
    const blueTeamRemaining = Array.from(wordMap.values()).filter(type => type === 'blue').length;

    return {
      phase: 'clue',
      currentTeam: 'red', // Red team goes first
      currentClue: null,
      board,
      redTeamRemaining,
      blueTeamRemaining,
      wordMap,
      redSpymasterId: setupState.redSpymasterId,
      blueSpymasterId: setupState.blueSpymasterId
    };
  }

  static handleClueSubmission(
    gameState: CodenamesState,
    clueWord: string,
    clueNumber: number,
    spymasterId: string
  ): CodenamesState {
    // Validate it's the correct spymaster's turn
    const currentSpymasterId = gameState.currentTeam === 'red' 
      ? gameState.redSpymasterId 
      : gameState.blueSpymasterId;
    
    if (spymasterId !== currentSpymasterId) {
      throw new Error('Not your turn to give a clue');
    }

    // Validate clue number doesn't exceed remaining cards
    const remainingCards = gameState.currentTeam === 'red' 
      ? gameState.redTeamRemaining 
      : gameState.blueTeamRemaining;
    
    if (clueNumber > remainingCards) {
      throw new Error(`Clue number cannot exceed remaining ${gameState.currentTeam} team cards (${remainingCards})`);
    }

    return {
      ...gameState,
      phase: 'guessing',
      currentClue: {
        word: clueWord.toUpperCase(),
        number: clueNumber
      }
    };
  }

  static handleCardGuess(
    gameState: CodenamesState,
    cardIndex: number,
    playerId: string
  ): CodenamesState {
    if (gameState.phase !== 'guessing') {
      throw new Error('Not in guessing phase');
    }

    const card = gameState.board[cardIndex];
    if (!card || card.revealed) {
      throw new Error('Invalid card or card already revealed');
    }

    // Reveal the card
    const newBoard = [...gameState.board];
    newBoard[cardIndex] = { ...card, revealed: true };

    const cardType = gameState.wordMap.get(cardIndex);
    let newState = { ...gameState, board: newBoard };

    // Handle different card types
    switch (cardType) {
      case gameState.currentTeam:
        // Correct guess - continue guessing
        if (gameState.currentTeam === 'red') {
          newState.redTeamRemaining--;
        } else {
          newState.blueTeamRemaining--;
        }
        
        // Check if team won
        if (newState.redTeamRemaining === 0) {
          return this.endGame(newState, 'red');
        } else if (newState.blueTeamRemaining === 0) {
          return this.endGame(newState, 'blue');
        }
        break;

      case 'neutral':
        // Neutral card - end turn
        newState = this.endTurn(newState);
        break;

      case 'assassin':
        // Assassin - other team wins immediately
        const winner = gameState.currentTeam === 'red' ? 'blue' : 'red';
        return this.endGame(newState, winner);

      default:
        // Wrong team's card - end turn
        newState = this.endTurn(newState);
        break;
    }

    return newState;
  }

  static endTurn(gameState: CodenamesState): CodenamesState {
    return {
      ...gameState,
      phase: 'clue',
      currentTeam: gameState.currentTeam === 'red' ? 'blue' : 'red',
      currentClue: null
    };
  }

  static endGame(gameState: CodenamesState, winner: 'red' | 'blue'): CodenamesState {
    return {
      ...gameState,
      phase: 'end',
      gameEnding: true,
      winner
    };
  }

  private static getRandomWords(count: number, language: SupportedLanguage = 'english'): string[] {
    const wordBank = WORD_BANKS[language] || WORD_BANKS['english'];
    const shuffled = [...wordBank].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  }

  private static createWordMap(): Map<number, 'red' | 'blue' | 'neutral' | 'assassin'> {
    const wordMap = new Map<number, 'red' | 'blue' | 'neutral' | 'assassin'>();
    
    // Standard Codenames distribution:
    // 9 red cards, 8 blue cards, 7 neutral cards, 1 assassin
    const distribution = [
      ...Array(9).fill('red'),
      ...Array(8).fill('blue'),
      ...Array(7).fill('neutral'),
      'assassin'
    ];
    
    // Shuffle the distribution
    const shuffled = distribution.sort(() => 0.5 - Math.random());
    
    // Assign to card indices
    shuffled.forEach((type, index) => {
      wordMap.set(index, type as 'red' | 'blue' | 'neutral' | 'assassin');
    });
    
    return wordMap;
  }

  static getClientVisibleState(gameState: CodenamesState, playerId: string): Partial<CodenamesState> {
    const isRedSpymaster = playerId === gameState.redSpymasterId;
    const isBlueSpymaster = playerId === gameState.blueSpymasterId;
    
    // Create a copy of the board for the client
    const clientBoard = gameState.board.map(card => ({
      word: card.word,
      revealed: card.revealed,
      // Only show type if card is revealed or player is the current team's spymaster
      type: card.revealed || 
            (isRedSpymaster && gameState.currentTeam === 'red') ||
            (isBlueSpymaster && gameState.currentTeam === 'blue') 
        ? card.type 
        : undefined
    }));

    return {
      phase: gameState.phase,
      currentTeam: gameState.currentTeam,
      currentClue: gameState.currentClue,
      board: clientBoard,
      redTeamRemaining: gameState.redTeamRemaining,
      blueTeamRemaining: gameState.blueTeamRemaining,
      gameEnding: gameState.gameEnding,
      winner: gameState.winner
    };
  }
}
