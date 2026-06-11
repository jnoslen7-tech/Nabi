import {
  applyAction,
  createGame,
  getPlayerView,
  reorderHand as engineReorderHand,
  type GameAction,
  type GameSettings,
  type GameState,
} from '../engine';
import type { GameBackend, JoinResult, RoomInfo, RoomPlayer, RoomSnapshot } from './types';

interface MockRoom {
  info: RoomInfo;
  game: GameState | null;
  subscribers: Map<string, Set<(snap: RoomSnapshot) => void>>;
}

function makeRoomCode(): string {
  const animals = ['FOX', 'OWL', 'KOI', 'CAT', 'BEE', 'ELK', 'JAY', 'YAK', 'ANT', 'BAT'];
  const animal = animals[Math.floor(Math.random() * animals.length)];
  const digits = Math.floor(100 + Math.random() * 900);
  return `${animal}-${digits}`;
}

/**
 * In-memory demo backend: runs the whole game on this device with no network.
 * Used automatically when Supabase env vars are absent. Supports hotseat play —
 * the lobby can join several local players, and the UI switches between their
 * (independently redacted) views.
 */
export class MockBackend implements GameBackend {
  readonly isMock = true;
  private rooms = new Map<string, MockRoom>();
  private nextId = 1;

  private getRoom(roomCode: string): MockRoom {
    const room = this.rooms.get(roomCode.toUpperCase());
    if (!room) throw new Error(`Room ${roomCode} not found`);
    return room;
  }

  private requireHost(room: MockRoom, playerId: string): void {
    if (room.info.hostPlayerId !== playerId) throw new Error('Only the host can do that');
  }

  private broadcast(room: MockRoom): void {
    for (const [playerId, callbacks] of room.subscribers) {
      const snap = this.snapshotFor(room, playerId);
      for (const cb of callbacks) cb(snap);
    }
  }

  private snapshotFor(room: MockRoom, playerId: string): RoomSnapshot {
    const player = room.info.players.find((p) => p.id === playerId);
    return {
      room: structuredClone(room.info),
      view: room.game && player ? getPlayerView(room.game, player.seat) : null,
    };
  }

  async createRoom(hostName: string, settings: GameSettings): Promise<JoinResult> {
    let roomCode = makeRoomCode();
    while (this.rooms.has(roomCode)) roomCode = makeRoomCode();
    const playerId = `mock-${this.nextId++}`;
    const host: RoomPlayer = { id: playerId, name: hostName, seat: 0, connected: true };
    this.rooms.set(roomCode, {
      info: { roomCode, hostPlayerId: playerId, settings, players: [host], phase: 'lobby' },
      game: null,
      subscribers: new Map(),
    });
    return { roomCode, playerId };
  }

  async joinRoom(roomCode: string, name: string, rejoinPlayerId?: string): Promise<JoinResult> {
    const room = this.getRoom(roomCode);
    if (rejoinPlayerId) {
      const existing = room.info.players.find((p) => p.id === rejoinPlayerId);
      if (existing) {
        existing.connected = true;
        this.broadcast(room);
        return { roomCode: room.info.roomCode, playerId: existing.id };
      }
    }
    if (room.info.phase !== 'lobby') throw new Error('Game already started');
    if (room.info.players.length >= 3) throw new Error('Room is full');
    const playerId = `mock-${this.nextId++}`;
    room.info.players.push({ id: playerId, name, seat: room.info.players.length, connected: true });
    this.broadcast(room);
    return { roomCode: room.info.roomCode, playerId };
  }

  async updateSettings(roomCode: string, playerId: string, settings: GameSettings): Promise<void> {
    const room = this.getRoom(roomCode);
    this.requireHost(room, playerId);
    if (room.info.phase !== 'lobby') throw new Error('Settings are locked once the game starts');
    room.info.settings = settings;
    this.broadcast(room);
  }

  async startGame(roomCode: string, playerId: string): Promise<void> {
    const room = this.getRoom(roomCode);
    this.requireHost(room, playerId);
    if (room.info.players.length < 2) throw new Error('Need at least 2 players');
    const settings = { ...room.info.settings, playerCount: room.info.players.length as 2 | 3 };
    room.info.settings = settings;
    room.game = createGame(settings);
    room.info.phase = 'playing';
    this.broadcast(room);
  }

  async submitAction(roomCode: string, playerId: string, action: GameAction): Promise<void> {
    const room = this.getRoom(roomCode);
    const player = room.info.players.find((p) => p.id === playerId);
    if (!player || !room.game) throw new Error('Not in a running game');
    room.game = applyAction(room.game, player.seat, action);
    if (room.game.status !== 'playing') room.info.phase = 'ended';
    this.broadcast(room);
  }

  async reorderHand(roomCode: string, playerId: string, order: number[]): Promise<void> {
    const room = this.getRoom(roomCode);
    const player = room.info.players.find((p) => p.id === playerId);
    if (!player || !room.game) throw new Error('Not in a running game');
    room.game = engineReorderHand(room.game, player.seat, order);
    this.broadcast(room);
  }

  async rematch(roomCode: string, playerId: string): Promise<void> {
    const room = this.getRoom(roomCode);
    this.requireHost(room, playerId);
    room.game = createGame(room.info.settings);
    room.info.phase = 'playing';
    this.broadcast(room);
  }

  async backToLobby(roomCode: string, playerId: string): Promise<void> {
    const room = this.getRoom(roomCode);
    this.requireHost(room, playerId);
    room.game = null;
    room.info.phase = 'lobby';
    this.broadcast(room);
  }

  subscribe(roomCode: string, playerId: string, onSnapshot: (snap: RoomSnapshot) => void): () => void {
    const room = this.getRoom(roomCode);
    if (!room.subscribers.has(playerId)) room.subscribers.set(playerId, new Set());
    room.subscribers.get(playerId)!.add(onSnapshot);
    // Emit the current state immediately so reconnect/refresh restores instantly.
    queueMicrotask(() => onSnapshot(this.snapshotFor(room, playerId)));
    return () => {
      room.subscribers.get(playerId)?.delete(onSnapshot);
    };
  }
}
