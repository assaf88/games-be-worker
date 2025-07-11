export class PartyState {
  state: DurableObjectState;
  connections: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.connections.add(server);
      
      server.addEventListener('message', (event) => {
        try {
          const data = JSON.parse(event.data as string);
          
          // Handle ping from client - respond with pong
          if (data.action === 'ping') {
            server.send(JSON.stringify({ 
              action: 'pong', 
              timestamp: Date.now() 
            }));
            return; // Don't broadcast ping/pong messages
          }
          
          // Broadcast game messages to all other connections
          for (const ws of this.connections) {
            if (ws !== server && ws.readyState === 1) {
              ws.send(event.data);
            }
          }
        } catch (error) {
          // If not JSON, broadcast as-is (for backward compatibility)
          for (const ws of this.connections) {
            if (ws !== server && ws.readyState === 1) {
              ws.send(event.data);
            }
          }
        }
      });
      
      const cleanup = () => {
        this.connections.delete(server);
      };
      
      server.addEventListener('close', cleanup);
      server.addEventListener('error', cleanup);
      
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response('Expected websocket', { status: 400 });
  }
}

export default PartyState;
