export class DatabaseManager {
  private env: any;

  constructor(env: any) {
    this.env = env;
  }

  async saveGameStateToD1(partyId: string, gameId: string, gameState: any): Promise<void> {
    try {
      //console.log('[DatabaseManager] Saving gameState:', JSON.stringify(gameState, null, 2));

      await this.env.DB.prepare(
        `INSERT INTO games (party_id, game_id, state_json, status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(party_id) DO UPDATE SET game_id=excluded.game_id, state_json=excluded.state_json, status=excluded.status, updated_at=excluded.updated_at`
      ).bind(
        partyId,
        gameId,
        JSON.stringify(gameState),
        'active',
        new Date().toISOString()
      ).run();
    } catch (error) {
      console.error('[DatabaseManager] Error saving game state to D1:', error);
      throw error;
    }
  }

  async markGameAsInactive(partyId: string): Promise<void> {
    try {
      await this.env.DB.prepare(
        `UPDATE games SET status = ?, updated_at = ? WHERE party_id = ?`
      ).bind(
        'inactive',
        new Date().toISOString(),
        partyId
      ).run();
    } catch (error) {

      console.error('[DatabaseManager] Error marking game as inactive:', error);
      throw error;
    }
  }

  async loadGameStateFromD1(partyId: string): Promise<any | null> {
    console.log('[DatabaseManager] Loading game state from D1 for partyId:', partyId);
    try {
      const result = await this.env.DB.prepare('SELECT state_json FROM games WHERE party_id = ? AND status = ? LIMIT 1')
        .bind(partyId, 'active').first();

      if (result?.state_json) {
        return JSON.parse(result.state_json);
      }
      return null;
    } catch (error) {
      console.error('[DatabaseManager] Error loading game state from D1:', error);
      throw error;
    }
  }

  async getAllPartyIds(): Promise<string[]> {
    try {
      const result = await this.env.DB.prepare('SELECT party_id FROM games').all();
      return (result.results || []).map((row: any) => row.party_id);
    } catch (error) {
      console.error('[DatabaseManager] Error getting all party IDs:', error);
      throw error;
    }
  }
}
