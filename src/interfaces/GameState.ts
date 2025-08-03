import { Player } from './Player';

export interface State {}

export interface AvalonState extends State {
  specialIds: string[];
  isPlayer1Lead1st: boolean;
}

export interface GameState {
  gameId: string;
  partyCode: string;
  players: Player[];
  gameStarted: boolean;
  state?: State; // Optional since it's only for games with specific state
}
