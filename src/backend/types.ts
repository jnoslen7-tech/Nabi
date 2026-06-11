import type { GameAction, GameSettings, PlayerView } from '../engine';

export interface RoomPlayer {
  id: string;
  name: string;
  seat: number;
  connected: boolean;
}

export type RoomPhase = 'lobby' | 'playing' | 'ended';

export interface RoomInfo {
  roomCode: string;
  hostPlayerId: string;
  settings: GameSettings;
  players: RoomPlayer[];
  phase: RoomPhase;
}

/** Everything one subscribed client receives: room metadata + their redacted game view. */
export interface RoomSnapshot {
  room: RoomInfo;
  /** null while in the lobby. Always the SUBSCRIBER's redacted view — never full state. */
  view: PlayerView | null;
}

export interface JoinResult {
  roomCode: string;
  playerId: string;
}

/**
 * The thin seam between the UI and any backend. The UI only ever talks to this
 * interface; `MockBackend` (in-memory, demo mode) and `SupabaseBackend`
 * (Postgres + Realtime) are drop-in implementations. Swapping mock → Supabase
 * requires only setting the two env vars — no other code changes.
 */
export interface GameBackend {
  /** True for the in-memory demo backend (UI shows the demo banner / hotseat controls). */
  readonly isMock: boolean;

  createRoom(hostName: string, settings: GameSettings): Promise<JoinResult>;
  /** Join (or — with a previously issued playerId — rejoin) a room by code. */
  joinRoom(roomCode: string, name: string, rejoinPlayerId?: string): Promise<JoinResult>;
  updateSettings(roomCode: string, playerId: string, settings: GameSettings): Promise<void>;
  startGame(roomCode: string, playerId: string): Promise<void>;
  submitAction(roomCode: string, playerId: string, action: GameAction): Promise<void>;
  /** Free reorder of one's own hand — not a turn action. */
  reorderHand(roomCode: string, playerId: string, order: number[]): Promise<void>;
  /** Same room, same settings, fresh deal. */
  rematch(roomCode: string, playerId: string): Promise<void>;
  /** Back to the lobby so the host can change settings. */
  backToLobby(roomCode: string, playerId: string): Promise<void>;
  /** Subscribe to this player's snapshots. Returns an unsubscribe function. */
  subscribe(roomCode: string, playerId: string, onSnapshot: (snap: RoomSnapshot) => void): () => void;
}
