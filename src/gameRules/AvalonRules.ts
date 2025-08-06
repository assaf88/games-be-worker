export const AVALON_RULES = {
  // Quest requirements based on player count (5-10 players)
  questRequirements: {
    1: [2, 2, 2, 3, 3, 3], // Quest 1: [5p, 6p, 7p, 8p, 9p, 10p]
    2: [3, 3, 3, 4, 4, 4], // Quest 2: [5p, 6p, 7p, 8p, 9p, 10p]
    3: [2, 4, 3, 4, 4, 4], // Quest 3: [5p, 6p, 7p, 8p, 9p, 10p]
    4: [3, 3, 4, 5, 5, 5], // Quest 4: [5p, 6p, 7p, 8p, 9p, 10p]
    5: [3, 4, 4, 5, 5, 5], // Quest 5: [5p, 6p, 7p, 8p, 9p, 10p]
  } as Record<number, number[]>,

  // Fails required to fail quest (marked with * in rules)
  questFailRequirements: {
    1: [1, 1, 1, 1, 1, 1], // Quest 1: [5p, 6p, 7p, 8p, 9p, 10p]
    2: [1, 1, 1, 1, 1, 1], // Quest 2: [5p, 6p, 7p, 8p, 9p, 10p]
    3: [1, 1, 1, 1, 1, 1], // Quest 3: [5p, 6p, 7p, 8p, 9p, 10p]
    4: [1, 1, 1, 2, 2, 2], // Quest 4: [5p, 6p, 7p, 8p, 9p, 10p] - requires 2 fails
    5: [1, 1, 1, 1, 1, 1], // Quest 5: [5p, 6p, 7p, 8p, 9p, 10p]
  } as Record<number, number[]>,

  // Evil players count based on total players
  evilPlayerCounts: [2, 2, 3, 3, 3, 4], // [5p, 6p, 7p, 8p, 9p, 10p]

  // Character types
  goodCharacters: ['merlin', 'percival', 'servant'],
  evilCharacters: ['assassin', 'morgana', 'mordred', 'oberon', 'minion'],

  // Special character visibility rules
  visibilityRules: {
    merlin: {
      canSee: ['assassin', 'morgana', 'oberon', 'minion'] as string[], // All evils except mordred
      appearsAs: 'minion' // All evils appear as minion to merlin
    },
    percival: {
      canSee: ['merlin', 'morgana'] as string[], // Sees merlin and morgana (both appear as merlin)
      appearsAs: 'merlin'
    },
    assassin: {
      canSee: ['morgana', 'mordred', 'minion'] as string[], // All evils except oberon
      appearsAs: 'minion'
    },
    morgana: {
      canSee: ['assassin', 'mordred', 'minion'] as string[], // All evils except oberon
      appearsAs: 'minion'
    },
    mordred: {
      canSee: ['assassin', 'morgana', 'minion'] as string[], // All evils except oberon
      appearsAs: 'minion'
    },
    oberon: {
      canSee: [] as string[], // Sees no one
      appearsAs: null
    },
    servant: {
      canSee: [] as string[], // Sees no one
      appearsAs: null
    }
  }
};

export function getQuestRequirement(playerCount: number, questNumber: number): number {
  const playerIndex = playerCount - 5; // Convert to 0-based index
  if (playerIndex < 0 || playerIndex >= 6) {
    throw new Error(`Invalid player count: ${playerCount}. Must be between 5-10.`);
  }
  if (questNumber < 1 || questNumber > 5) {
    throw new Error(`Invalid quest number: ${questNumber}. Must be between 1-5.`);
  }
  return AVALON_RULES.questRequirements[questNumber][playerIndex];
}

export function getQuestFailRequirement(playerCount: number, questNumber: number): number {
  const playerIndex = playerCount - 5;
  if (playerIndex < 0 || playerIndex >= 6) {
    throw new Error(`Invalid player count: ${playerCount}. Must be between 5-10.`);
  }
  if (questNumber < 1 || questNumber > 5) {
    throw new Error(`Invalid quest number: ${questNumber}. Must be between 1-5.`);
  }
  return AVALON_RULES.questFailRequirements[questNumber][playerIndex];
}

export function getEvilPlayerCount(playerCount: number): number {
  const playerIndex = playerCount - 5;
  if (playerIndex < 0 || playerIndex >= 6) {
    throw new Error(`Invalid player count: ${playerCount}. Must be between 5-10.`);
  }
  return AVALON_RULES.evilPlayerCounts[playerIndex];
}

export function getGoodPlayerCount(playerCount: number): number {
  return playerCount - getEvilPlayerCount(playerCount);
}
