export interface GameHandler {
  handleGameMessage(data: any, player: any, partyState: any): Promise<void>;
} 