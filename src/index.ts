// Cloudflare Worker entrypoint. Configuration is in wrangler.toml.
// Durable Object: GamePartyState
// To deploy: wrangler deploy (see package.json scripts)

import GamePartyState from './GamePartyState';
import { GameHandlerFactory } from './handlers/GameHandlerFactory';

interface Env {
  PARTY_STATE: DurableObjectNamespace;
  DB: D1Database;
}

// In-memory tracking of active party codes (clears on worker restart)
const activePartyCodes = new Set<string>();

function getGameIdAndPartyCodeFromUrl(url: URL): { gameId: string | null, partyCode: string | null } {
  // Match patterns like /game/avalon/party/xxxx or /game/avalon/create-party
  const gameMatch = url.pathname.match(/\/game\/(\w+)\/(?:party\/(\w+)|create-party)/);
  if (gameMatch) {
    const gameId = gameMatch[1];
    const partyCode = gameMatch[2] || null; // null for create-party endpoints
    return { gameId, partyCode };
  }
  return { gameId: null, partyCode: null };
}

export { GamePartyState };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
  
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Handle party creation for specific games
    const createPartyMatch = url.pathname.match(/\/game\/(\w+)\/create-party/);
    if (createPartyMatch && request.method === 'POST') {
      const gameId = createPartyMatch[1];
      
      // Validate game type
      if (!GameHandlerFactory.isValidGameId(gameId)) {
        return new Response(JSON.stringify({ error: `Game type '${gameId}' not supported` }), { 
          status: 404, 
          headers: { 'Content-Type': 'application/json' } 
        });
      }

      const { id, name } = await request.json() as { id: string, name: string };
      
      // Fetch all existing party_ids from D1 (started games)
      const allIdsResult = await env.DB.prepare('SELECT party_id FROM games').all();
      const existingIds = new Set((allIdsResult.results || []).map((row: any) => row.party_id));
      
      // Combine D1 results with in-memory active codes
      const allTakenIds = new Set([...existingIds, ...activePartyCodes]);
      
      // Generate a unique 4-digit party_code
      let partyId;
      let partyCode;
      let attempts = 0;
      const maxAttempts = 20;
      do {
        partyCode = (Math.floor(1000 + Math.random() * 9000)).toString();
        partyId = `${gameId}-${partyCode}`;
        attempts++;
      } while (allTakenIds.has(partyId) && attempts < maxAttempts);
      
      if (allTakenIds.has(partyId)) {
        return new Response(JSON.stringify({ error: 'Failed to create party. Please try again.' }), { status: 500 });
      }
      
      // Add to in-memory tracking
      activePartyCodes.add(partyId);

      // Create Durable Object and initialize game state
      const idObj = env.PARTY_STATE.idFromName(partyId);
      const stub = env.PARTY_STATE.get(idObj);
      
      // Send an internal request to initialize the party with the creator
      await stub.fetch('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ id, name, partyCode, gameId })
      });
      
      // Save to D1 immediately (the Durable Object will handle it)
      return new Response(JSON.stringify({ partyCode }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Handle cleanup requests from Durable Objects
    if (url.pathname === '/cleanup-party' && request.method === 'POST') {
      try {
        const { partyId } = await request.json() as { partyId: string };
        activePartyCodes.delete(partyId);
        return new Response('OK', { status: 200 });
      } catch (e) {
        return new Response('Bad Request', { status: 400 });
      }
    }

    // Handle WebSocket connections for specific games
    if (request.headers.get('upgrade') === 'websocket') {
      const { gameId, partyCode } = getGameIdAndPartyCodeFromUrl(url);
      
      if (!gameId || !partyCode) {
        return new Response('Invalid game or party code', { status: 400 });
      }
      
      // Validate game type
      if (!GameHandlerFactory.isValidGameId(gameId)) {
        return new Response(`Game type '${gameId}' not supported`, { status: 404 });
      }
      
      const partyId = `${gameId}-${partyCode}`;
      const id = env.PARTY_STATE.idFromName(partyId);
      const obj = env.PARTY_STATE.get(id);
      return obj.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
  GamePartyState,  // This was the correct way to export Durable Objects
} satisfies ExportedHandler<Env> & { GamePartyState: typeof GamePartyState };