import type { ExtendedWebSocket } from '../subscriptions.js';

export interface PingMessage {
  type: 'ping';
  id?: string;
}

export function handlePing(socket: ExtendedWebSocket, message: PingMessage): void {
  const response: Record<string, unknown> = { type: 'pong' };
  if (message.id !== undefined) {
    response.ackId = message.id;
  }
  socket.send(JSON.stringify(response));
}
