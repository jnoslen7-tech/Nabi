import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { GameAction, GameSettings } from '../engine';
import type { GameBackend, JoinResult, RoomSnapshot } from './types';

const POLL_INTERVAL_MS = 2500; // turn-based: polling is an acceptable Realtime fallback

interface Subscription {
  roomCode: string;
  playerId: string;
  onSnapshot: (snap: RoomSnapshot) => void;
  channel: RealtimeChannel;
  pollTimer: number;
  lastJson: string;
  presentIds: Set<string>;
}

/** Tokens survive refresh so rejoining a room restores the same seat. */
function tokenKey(roomCode: string, playerId: string): string {
  return `hanabi-token-${roomCode.toUpperCase()}-${playerId}`;
}

function saveToken(roomCode: string, playerId: string, token: string): void {
  try {
    localStorage.setItem(tokenKey(roomCode, playerId), token);
  } catch {
    /* private mode: reconnection just won't survive a refresh */
  }
}

function loadToken(roomCode: string, playerId: string): string | null {
  try {
    return localStorage.getItem(tokenKey(roomCode, playerId));
  } catch {
    return null;
  }
}

/**
 * Supabase implementation of GameBackend. All game logic and hidden-information
 * redaction run inside Postgres (see supabase/migrations/001_init.sql); this
 * class only calls RPCs and listens for room-version bumps over Realtime,
 * with slow polling as a fallback. Presence on the room channel powers the
 * "waiting for [name]" connected flags.
 */
export class SupabaseBackend implements GameBackend {
  readonly isMock = false;
  private subs = new Set<Subscription>();

  constructor(private client: SupabaseClient) {}

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) {
      // Postgres `raise exception` messages arrive as error.message.
      throw new Error(error.message.replace(/^.*?: /, ''));
    }
    return data as T;
  }

  private requireToken(roomCode: string, playerId: string): string {
    const token = loadToken(roomCode, playerId);
    if (!token) throw new Error('Session expired — rejoin the room with its code');
    return token;
  }

  async createRoom(hostName: string, settings: GameSettings): Promise<JoinResult> {
    const res = await this.rpc<{ roomCode: string; playerId: string; token: string }>('create_room', {
      p_host_name: hostName,
      p_settings: settings,
    });
    saveToken(res.roomCode, res.playerId, res.token);
    return { roomCode: res.roomCode, playerId: res.playerId };
  }

  async joinRoom(roomCode: string, name: string, rejoinPlayerId?: string): Promise<JoinResult> {
    const rejoinToken = rejoinPlayerId ? loadToken(roomCode, rejoinPlayerId) : null;
    const res = await this.rpc<{ roomCode: string; playerId: string; token: string }>('join_room', {
      p_room_code: roomCode,
      p_name: name,
      p_rejoin_player_id: rejoinToken ? rejoinPlayerId : null,
      p_rejoin_token: rejoinToken,
    });
    saveToken(res.roomCode, res.playerId, res.token);
    return { roomCode: res.roomCode, playerId: res.playerId };
  }

  async updateSettings(roomCode: string, playerId: string, settings: GameSettings): Promise<void> {
    await this.rpc('update_settings', {
      p_room_code: roomCode,
      p_player_id: playerId,
      p_token: this.requireToken(roomCode, playerId),
      p_settings: settings,
    });
    this.refetchAll(roomCode);
  }

  async startGame(roomCode: string, playerId: string): Promise<void> {
    await this.rpc('start_game', {
      p_room_code: roomCode,
      p_player_id: playerId,
      p_token: this.requireToken(roomCode, playerId),
    });
    this.refetchAll(roomCode);
  }

  async submitAction(roomCode: string, playerId: string, action: GameAction): Promise<void> {
    await this.rpc('submit_action', {
      p_room_code: roomCode,
      p_player_id: playerId,
      p_token: this.requireToken(roomCode, playerId),
      p_action: action,
    });
    this.refetchAll(roomCode);
  }

  async reorderHand(roomCode: string, playerId: string, order: number[]): Promise<void> {
    await this.rpc('reorder_hand', {
      p_room_code: roomCode,
      p_player_id: playerId,
      p_token: this.requireToken(roomCode, playerId),
      p_order: order,
    });
    this.refetchAll(roomCode);
  }

  async rematch(roomCode: string, playerId: string): Promise<void> {
    await this.rpc('rematch', {
      p_room_code: roomCode,
      p_player_id: playerId,
      p_token: this.requireToken(roomCode, playerId),
    });
    this.refetchAll(roomCode);
  }

  async backToLobby(roomCode: string, playerId: string): Promise<void> {
    await this.rpc('back_to_lobby', {
      p_room_code: roomCode,
      p_player_id: playerId,
      p_token: this.requireToken(roomCode, playerId),
    });
    this.refetchAll(roomCode);
  }

  subscribe(roomCode: string, playerId: string, onSnapshot: (snap: RoomSnapshot) => void): () => void {
    const channel = this.client.channel(`room:${roomCode.toUpperCase()}`, {
      config: { presence: { key: playerId } },
    });

    const sub: Subscription = {
      roomCode,
      playerId,
      onSnapshot,
      channel,
      pollTimer: 0,
      lastJson: '',
      presentIds: new Set([playerId]),
    };

    channel
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode.toUpperCase()}` },
        () => void this.refetch(sub),
      )
      .on('presence', { event: 'sync' }, () => {
        sub.presentIds = new Set([playerId, ...Object.keys(channel.presenceState())]);
        // Re-emit the cached snapshot with fresh connected flags.
        if (sub.lastJson) this.emit(sub, JSON.parse(sub.lastJson) as RoomSnapshot, true);
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') void channel.track({ online: true });
      });

    sub.pollTimer = window.setInterval(() => void this.refetch(sub), POLL_INTERVAL_MS);
    this.subs.add(sub);
    void this.refetch(sub); // initial snapshot

    return () => {
      this.subs.delete(sub);
      window.clearInterval(sub.pollTimer);
      void this.client.removeChannel(channel);
    };
  }

  /** After our own mutation, update every local subscription immediately. */
  private refetchAll(roomCode: string): void {
    for (const sub of this.subs) {
      if (sub.roomCode.toUpperCase() === roomCode.toUpperCase()) void this.refetch(sub);
    }
  }

  private async refetch(sub: Subscription): Promise<void> {
    try {
      const snap = await this.rpc<RoomSnapshot & { version: number }>('get_snapshot', {
        p_room_code: sub.roomCode,
        p_player_id: sub.playerId,
        p_token: this.requireToken(sub.roomCode, sub.playerId),
      });
      const json = JSON.stringify(snap);
      if (json === sub.lastJson) return; // nothing changed — skip the re-render
      sub.lastJson = json;
      this.emit(sub, snap, false);
    } catch {
      // Transient network failure: the poll loop will retry shortly.
    }
  }

  private emit(sub: Subscription, snap: RoomSnapshot, fromPresence: boolean): void {
    if (!this.subs.has(sub) && !fromPresence) return;
    const withPresence: RoomSnapshot = {
      ...snap,
      room: {
        ...snap.room,
        players: snap.room.players.map((p) => ({ ...p, connected: sub.presentIds.has(p.id) })),
      },
    };
    sub.onSnapshot(withPresence);
  }
}
