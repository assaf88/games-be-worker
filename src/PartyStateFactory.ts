import { PartyState } from './PartyState';
import { AvalonPartyState } from './AvalonPartyState';

export class PartyStateFactory {
  private static gameStateMap: Map<string, typeof PartyState> = new Map([
    ['avalon', AvalonPartyState],
    // Future games will be added here:
    // ['codenames', CodenamesPartyState],
  ]);

  static createPartyState(gameId: string, state: DurableObjectState, env: any): PartyState {
    const PartyStateClass = this.gameStateMap.get(gameId);
    
    if (!PartyStateClass) {
      throw new Error(`Game type '${gameId}' not found`);
    }
    
    return new PartyStateClass(state, env);
  }

  static isValidGameId(gameId: string): boolean {
    return this.gameStateMap.has(gameId);
  }

  static getSupportedGames(): string[] {
    return Array.from(this.gameStateMap.keys());
  }
} 