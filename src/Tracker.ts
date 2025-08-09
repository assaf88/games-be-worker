export class Tracker {
	state: DurableObjectState;
	activeParties: Map<string, number>; // partyId -> lastActive timestamp

	constructor(state: DurableObjectState) {
		this.state = state;
		this.activeParties = new Map();
	}

	async fetch(req: Request) {
		const url = new URL(req.url);

		if (url.pathname === "/ping" && req.method === "POST") {
			const { partyId } = await req.json() as { partyId: string };
			this.activeParties.set(partyId, Date.now());
			return new Response("OK");
		}

		if (url.pathname === "/list") {
			return new Response(JSON.stringify(
				Array.from(this.activeParties.entries()),
			), { headers: { "Content-Type": "application/json" } });
		}

		if (url.pathname === "/cleanup") {
			const cutoff = Date.now() - 30 * 60 * 1000;
			for (const [partyId, ts] of this.activeParties) {
				if (ts < cutoff) this.activeParties.delete(partyId);
			}
			return new Response("Cleaned");
		}

		return new Response("Not found", { status: 404 });
	}
}

export default Tracker
