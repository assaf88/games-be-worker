import { AvalonGameHandler } from './AvalonGameHandler';
import { GameHandler } from './GameHandler';

export class GameHandlerFactory {
  private static gameHandlerMap: Map<string, new () => GameHandler> = new Map([
    ['avalon', AvalonGameHandler],
    // Future games will be added here:
    // ['codenames', CodenamesGameHandler],
  ]);

  static createGameHandler(gameId: string): GameHandler {
    const GameHandlerClass = this.gameHandlerMap.get(gameId);
    
    if (!GameHandlerClass) {
      throw new Error(`Game type '${gameId}' not found`);
    }
    
    return new GameHandlerClass();
  }

  static isValidGameId(gameId: string): boolean {
    return this.gameHandlerMap.has(gameId);
  }

  static getSupportedGames(): string[] {
    return Array.from(this.gameHandlerMap.keys());
  }
} 