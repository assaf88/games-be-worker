import { Player } from './Player';

export interface GameState {
  gameId: string;
  partyCode: string;
  players: Player[];
  gameStarted: boolean;
} 