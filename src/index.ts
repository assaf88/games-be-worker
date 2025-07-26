// Cloudflare Worker entrypoint. Configuration is in wrangler.toml.
// Durable Object: PartyState
// To deploy: wrangler deploy (see package.json scripts)

import PartyState from './PartyState';

interface Env {
  PARTY_STATE: DurableObjectNamespace;
  DB: D1Database;
}

function getPartyCodeFromUrl(url: URL): string | null {
  const match = url.pathname.match(/\/game\/party\/(\w+)/);
  return match ? match[1] : null;
}

export { PartyState };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // Handle party creation
    if (url.pathname === '/game/create-party' && request.method === 'POST') {
      const { id, name } = await request.json() as { id: string, name: string };
      // Fetch all existing party_ids in one query
      const allIdsResult = await env.DB.prepare('SELECT party_id FROM games').all();
      const existingIds = new Set((allIdsResult.results || []).map((row: any) => row.party_id));
      // Generate a unique 4-digit party_code
      let partyId;
      let partyCode;
      let attempts = 0;
      const maxAttempts = 20;
      const tempGameName = 'tempgamename-';
      do {
        partyCode = (Math.floor(1000 + Math.random() * 9000)).toString();
        partyId = `${tempGameName}${partyCode}`;
        attempts++;
      } while (existingIds.has(partyId) && attempts < maxAttempts);
      if (existingIds.has(partyId)) {
        return new Response(JSON.stringify({ error: 'Failed to create party. Please try again.' }), { status: 500 });
      }
      // Create Durable Object and initialize game state
      const idObj = env.PARTY_STATE.idFromName(partyId || '');
      const stub = env.PARTY_STATE.get(idObj);
      // Send an internal request to initialize the party with the creator
      await stub.fetch('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ id, name, partyCode })
      });
      // Save to D1 immediately (the Durable Object will handle it)
      return new Response(JSON.stringify({ partyCode }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // Handle WebSocket connections
    if (request.headers.get('upgrade') === 'websocket') {
      const partyCode = getPartyCodeFromUrl(url);
      if (!partyCode) {
        return new Response('Invalid party code', { status: 400 });
      }
      const tempGameName = 'tempgamename-';
      const id = env.PARTY_STATE.idFromName(`${tempGameName}${partyCode}`);
      const obj = env.PARTY_STATE.get(id);
      return obj.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
  PartyState,  // This was the correct way to export Durable Objects
} satisfies ExportedHandler<Env> & { PartyState: typeof PartyState };