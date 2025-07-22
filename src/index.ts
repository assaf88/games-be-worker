// Cloudflare Worker entrypoint. Configuration is in wrangler.toml.
// Durable Object: PartyState
// To deploy: wrangler deploy (see package.json scripts)

import PartyState from './PartyState';

interface Env {
  PARTY_STATE: DurableObjectNamespace;
  DB: D1Database;
}

function getPartyIdFromUrl(url: URL): string | null {
  // Accepts /game?party=7253 or /game/party/7253
  if (url.pathname.startsWith('/game')) {
    const partyFromQuery = url.searchParams.get('party');
    if (partyFromQuery) return partyFromQuery;
    const match = url.pathname.match(/\/game\/(party|room)\/(\w+)/);
    if (match) return match[2];
  }
  return null;
}

export { PartyState };

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

    // New endpoint: POST /game/create-party
    if (url.pathname === '/game/create-party' && request.method === 'POST') {
      const { id, name } = await request.json() as { id: string, name: string };
      // Fetch all existing party_ids in one query
      const allIdsResult = await env.DB.prepare('SELECT party_id FROM games').all();
      const existingIds = new Set((allIdsResult.results || []).map((row: any) => row.party_id));
      // Generate a unique 4-digit party_id
      let partyId;
      let attempts = 0;
      const maxAttempts = 20;
      do {
        partyId = (Math.floor(1000 + Math.random() * 9000)).toString();
        attempts++;
      } while (existingIds.has(partyId) && attempts < maxAttempts);
      if (existingIds.has(partyId)) {
        return new Response(JSON.stringify({ error: 'Could not generate unique party id' }), { status: 500 });
      }
      // Create Durable Object and initialize game state
      const idObj = env.PARTY_STATE.idFromName(partyId || '');
      const stub = env.PARTY_STATE.get(idObj);
      // Send an internal request to initialize the party with the creator
      await stub.fetch('https://internal/init', {
        method: 'POST',
        body: JSON.stringify({ id, name, partyId })
      });
      // Save to D1 immediately (the Durable Object will handle it)
      return new Response(JSON.stringify({ partyId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

		if (url.pathname.startsWith('/game')) {
			if (request.headers.get('upgrade') !== 'websocket') {
				return new Response('Expected websocket', { status: 400 });
			}
			const partyId = getPartyIdFromUrl(url);
			if (!partyId) {
				return new Response('Missing party id', { status: 400 });
			}
			// Route to Durable Object
			const id = env.PARTY_STATE.idFromName(partyId);
			const stub = env.PARTY_STATE.get(id);
			return await stub.fetch(request);
		}
		switch (url.pathname) {
			case '/message':
				return new Response('Hello, World!');
			case '/random':
				return new Response(crypto.randomUUID());
			default:
				return new Response('Not Found', { status: 404 });
		}
	},
	// Export Durable Object classes
	PartyState,
} satisfies ExportedHandler<Env> & { PartyState: typeof PartyState };
