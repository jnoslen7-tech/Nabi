import { useEffect, useMemo, useRef, useState } from 'react';
import { getBackend, type RoomSnapshot } from './backend';
import { DEFAULT_SETTINGS, type GameAction, type GameSettings } from './engine';
import { recallSeat, rememberSeat, usePrefs } from './lib/prefs';
import { setSoundEnabled } from './lib/sound';
import { GameScreen } from './screens/GameScreen';
import { Home } from './screens/Home';
import { Lobby } from './screens/Lobby';

interface Session {
  roomCode: string;
  playerId: string;
  name: string;
}

export default function App() {
  const backend = useMemo(() => getBackend(), []);
  const [session, setSession] = useState<Session | null>(null);
  /** Demo/hotseat: every locally joined seat, so you can switch between them. */
  const [localSeats, setLocalSeats] = useState<Session[]>([]);
  const [autoFollow, setAutoFollow] = useState(true);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, updatePrefs] = usePrefs(session?.playerId ?? 'anon');

  useEffect(() => {
    setSoundEnabled(prefs.sound);
  }, [prefs.sound]);

  // Join links: ?room=FOX-742
  const linkRoomCode = useMemo(() => new URLSearchParams(window.location.search).get('room'), []);

  // Subscribe to the active seat's snapshots.
  useEffect(() => {
    if (!session) return;
    setSnapshot(null);
    return backend.subscribe(session.roomCode, session.playerId, setSnapshot);
  }, [backend, session]);

  // Hotseat auto-follow: when the turn passes to another locally-controlled seat, switch to it.
  const followRef = useRef({ localSeats, autoFollow, session });
  followRef.current = { localSeats, autoFollow, session };
  useEffect(() => {
    const { localSeats, autoFollow, session } = followRef.current;
    if (!backend.isMock || !autoFollow || !snapshot?.view || localSeats.length < 2) return;
    if (snapshot.view.status !== 'playing') return;
    const currentSeatPlayer = snapshot.room.players.find((p) => p.seat === snapshot.view!.currentPlayer);
    if (!currentSeatPlayer || currentSeatPlayer.id === session?.playerId) return;
    const local = localSeats.find((s) => s.playerId === currentSeatPlayer.id);
    if (local) {
      const t = window.setTimeout(() => setSession(local), 2300); // let the reveal animation finish first
      return () => window.clearTimeout(t);
    }
  }, [backend, snapshot]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const createRoom = (name: string) =>
    run(async () => {
      const { roomCode, playerId } = await backend.createRoom(name, { ...DEFAULT_SETTINGS });
      const s = { roomCode, playerId, name };
      rememberSeat(roomCode, playerId, name);
      setSession(s);
      setLocalSeats([s]);
    });

  const joinRoom = (roomCode: string, name: string) =>
    run(async () => {
      const remembered = recallSeat(roomCode);
      const { playerId } = await backend.joinRoom(roomCode, name, remembered?.playerId);
      const s = { roomCode, playerId, name };
      rememberSeat(roomCode, playerId, name);
      setSession(s);
      setLocalSeats((prev) => (prev.some((x) => x.playerId === playerId) ? prev : [...prev, s]));
    });

  const addLocalPlayer = (name: string) =>
    run(async () => {
      if (!session) return;
      const { playerId } = await backend.joinRoom(session.roomCode, name);
      setLocalSeats((prev) => [...prev, { roomCode: session.roomCode, playerId, name }]);
    });

  const withSession = (fn: (s: Session) => Promise<void>) =>
    run(async () => {
      if (session) await fn(session);
    });
  const updateSettings = (settings: GameSettings) =>
    withSession((s) => backend.updateSettings(s.roomCode, s.playerId, settings));
  const startGame = () => withSession((s) => backend.startGame(s.roomCode, s.playerId));
  const submitAction = (action: GameAction) =>
    withSession((s) => backend.submitAction(s.roomCode, s.playerId, action));
  const reorder = (order: number[]) => withSession((s) => backend.reorderHand(s.roomCode, s.playerId, order));
  const rematch = () => withSession((s) => backend.rematch(s.roomCode, s.playerId));
  const backToLobby = () => withSession((s) => backend.backToLobby(s.roomCode, s.playerId));

  const demoBanner = backend.isMock && (
    <div className="demo-banner">
      Demo mode — no backend connected
      {localSeats.length > 1 && session && (
        <span className="seat-switcher">
          {localSeats.map((s) => (
            <button
              key={s.playerId}
              type="button"
              className={s.playerId === session.playerId ? 'active' : ''}
              onClick={() => setSession(s)}
            >
              {s.name}
            </button>
          ))}
          <label className="auto-follow">
            <input type="checkbox" checked={autoFollow} onChange={(e) => setAutoFollow(e.target.checked)} />
            follow turns
          </label>
        </span>
      )}
    </div>
  );

  if (!session) {
    return (
      <>
        {demoBanner}
        <Home initialRoomCode={linkRoomCode} onCreate={createRoom} onJoin={joinRoom} busy={busy} error={error} />
      </>
    );
  }

  if (!snapshot) {
    return (
      <>
        {demoBanner}
        <div className="screen center-screen">
          <p className="muted">Connecting…</p>
        </div>
      </>
    );
  }

  if (snapshot.room.phase === 'lobby' || !snapshot.view) {
    return (
      <>
        {demoBanner}
        <Lobby
          room={snapshot.room}
          playerId={session.playerId}
          isMock={backend.isMock}
          onUpdateSettings={updateSettings}
          onStart={startGame}
          onAddLocalPlayer={addLocalPlayer}
          error={error}
        />
      </>
    );
  }

  return (
    <>
      {demoBanner}
      <GameScreen
        key={session.playerId}
        snapshot={snapshot}
        playerId={session.playerId}
        prefs={prefs}
        updatePrefs={updatePrefs}
        onAction={submitAction}
        onReorder={reorder}
        onRematch={rematch}
        onBackToLobby={backToLobby}
        error={error}
        clearError={() => setError(null)}
      />
    </>
  );
}
