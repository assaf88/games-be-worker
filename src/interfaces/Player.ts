export interface Player {
  id: string;
  name: string;
  order?: number;
  connected?: boolean;
  disconnectTime?: number;
  tabId?: string;

  // Avalon specific fields
  specialId?: string; // For role visibility (only sent to players who can see this role)
  voted?: boolean; // For voting phase indication
  decided?: boolean; // For results phase indication
  characterSex?: 'm' | 'f';
}
