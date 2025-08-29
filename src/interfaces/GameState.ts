import { Player } from './Player';



export interface GameState {
  gameId: string;
  partyCode: string;
  players: Player[];
  gameStarted: boolean;
  state?: State; // Optional since it's only for games with specific state
}

export interface State {}

// Pre-game setup state (before game starts)
export interface AvalonSetupState extends State {
  specialIds: string[];
  isPlayer1Lead1st: boolean;
}

// Main game state (after game starts)
export interface AvalonState extends State {
  // Client-visible state
  instructionText: string;
  phase: 'quest' | 'voting' | 'results' | 'revealing' | 'assassinating' | 'end';
  questNumber: number;
  questLeader: string;
  questTeamSizes: number[];
  questTeam: string[];
  questSkips: number; // When reaches 5 for this questNumber evil win. resets on the next quest.
  completedQuests: boolean[]; // true is success and false is failed. this is a max 5 array size

  // Server-only data (not sent to clients)
  playerRoles: Map<string, string>; // playerId -> role
  questVotes: Map<string, boolean>; // Team approval votes (true for approved, false for rejected)
  questResults: boolean[]; // Success/fail (true for success, false for fail) - relevant for 'results' stage
  
  // Optional fields
  assassinatedPlayerId?: string; // ID of the player assassinated by the assassin
  gameEnding?: boolean; // Indicates the game is ending and identities should be revealed
}

// Codenames setup state
export interface CodenamesSetupState extends State {
  redSpymasterId: string | null;
  blueSpymasterId: string | null;
  wordBank: string;
}

// Codenames game state
export interface CodenamesState extends State {
  // Client-visible state
  phase: 'clue' | 'guessing' | 'end';
  currentTeam: 'red' | 'blue';
  currentClue: {
    word: string;
    number: number;
  } | null;
  board: CodenamesCard[];
  redTeamRemaining: number;
  blueTeamRemaining: number;
  gameEnding?: boolean;
  winner?: 'red' | 'blue';
  
  // Server-only data
  wordMap: Map<number, 'red' | 'blue' | 'neutral' | 'assassin'>; // cardIndex -> type
  redSpymasterId: string;
  blueSpymasterId: string;
}

export interface CodenamesCard {
  word: string;
  revealed: boolean;
  type?: 'red' | 'blue' | 'neutral' | 'assassin'; // Only revealed to spymasters initially
}
