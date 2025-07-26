import { Player } from './Player';

export interface GameState {
  gameId: string;
  partyId: string;
  players: Player[];
  gameStarted: boolean;
} 