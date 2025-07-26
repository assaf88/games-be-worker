export interface Player {
  id: string;
  name: string;
  order?: number;
  connected?: boolean;
  disconnectTime?: number;
} 