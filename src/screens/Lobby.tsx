import { useState } from 'react';
import type { RoomInfo } from '../backend';
import { PRESETS, type GameSettings, type Preset } from '../engine';

function detectPreset(s: GameSettings): Preset {
  for (const [name, p] of Object.entries(PRESETS)) {
    if (
      s.maxClues === p.maxClues &&
      s.errorsAllowed === p.errorsAllowed &&
      s.suits === p.suits &&
      s.allowDiscardAtMaxClues === p.allowDiscardAtMaxClues
    ) {
      return name as Preset;
    }
  }
  return 'custom';
}

export function Lobby({
  room,
  playerId,
  isMock,
  onUpdateSettings,
  onStart,
  onAddLocalPlayer,
  error,
}: {
  room: RoomInfo;
  playerId: string;
  isMock: boolean;
  onUpdateSettings: (s: GameSettings) => void;
  onStart: () => void;
  onAddLocalPlayer: (name: string) => void;
  error: string | null;
}) {
  const isHost = room.hostPlayerId === playerId;
  const s = room.settings;
  const preset = detectPreset(s);
  const [copied, setCopied] = useState(false);

  const joinLink = `${window.location.origin}${window.location.pathname}?room=${room.roomCode}`;

  const set = (patch: Partial<GameSettings>) => onUpdateSettings({ ...s, ...patch });

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      window.prompt('Copy this link:', joinLink);
    }
  };

  return (
    <div className="screen lobby">
      <header className="lobby-header">
        <p className="lobby-label">room code</p>
        <h1 className="room-code">{room.roomCode}</h1>
        <button type="button" className="ghost-btn" onClick={copyLink}>
          {copied ? 'Link copied ✓' : isMock ? 'Copy link (demo: same device only)' : 'Copy join link'}
        </button>
      </header>

      <section className="lobby-players">
        <h2>Players</h2>
        <ul>
          {room.players.map((p) => (
            <li key={p.id} className="player-row">
              <span className="player-dot" />
              <span className="player-name">
                {p.name}
                {p.id === playerId ? ' (you)' : ''}
              </span>
              {p.id === room.hostPlayerId && <span className="host-tag">host</span>}
            </li>
          ))}
          {room.players.length < 3 &&
            Array.from({ length: 3 - room.players.length }, (_, i) => (
              <li key={`empty-${i}`} className="player-row empty">
                <span className="player-dot empty" />
                <span className="player-name">waiting for a friend…</span>
              </li>
            ))}
        </ul>
        {isMock && room.players.length < 3 && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() => onAddLocalPlayer(`Player ${room.players.length + 1}`)}
          >
            + Add local player (hotseat)
          </button>
        )}
      </section>

      <section className="lobby-settings">
        <h2>Settings {!isHost && <span className="muted">(host chooses)</span>}</h2>

        <div className="segmented presets">
          {(['easy', 'standard', 'hard'] as const).map((p) => (
            <button
              key={p}
              type="button"
              disabled={!isHost}
              className={preset === p ? 'active' : ''}
              onClick={() => set(PRESETS[p])}
            >
              {p[0].toUpperCase() + p.slice(1)}
            </button>
          ))}
          <button type="button" disabled className={preset === 'custom' ? 'active' : ''}>
            Custom
          </button>
        </div>

        <label className="setting-row">
          <span>Clue tokens</span>
          <div className="stepper">
            <button type="button" disabled={!isHost || s.maxClues <= 2} onClick={() => set({ maxClues: s.maxClues - 1 })}>−</button>
            <strong>{s.maxClues}</strong>
            <button type="button" disabled={!isHost || s.maxClues >= 10} onClick={() => set({ maxClues: s.maxClues + 1 })}>+</button>
          </div>
        </label>

        <label className="setting-row">
          <span>
            Errors allowed
            {s.errorsAllowed === 0 && <em className="muted"> — sudden death!</em>}
          </span>
          <div className="stepper">
            <button type="button" disabled={!isHost || s.errorsAllowed <= 0} onClick={() => set({ errorsAllowed: s.errorsAllowed - 1 })}>−</button>
            <strong>{s.errorsAllowed}</strong>
            <button type="button" disabled={!isHost || s.errorsAllowed >= 4} onClick={() => set({ errorsAllowed: s.errorsAllowed + 1 })}>+</button>
          </div>
        </label>

        <label className="setting-row">
          <span>Colors</span>
          <div className="segmented small">
            {([4, 5, 6] as const).map((n) => (
              <button
                key={n}
                type="button"
                disabled={!isHost}
                className={s.suits === n ? 'active' : ''}
                onClick={() => set({ suits: n })}
              >
                {n === 6 ? '6 🌈' : n}
              </button>
            ))}
          </div>
        </label>
        {s.suits === 6 && (
          <p className="muted hint">Rainbow cards match every color clue but build their own stack.</p>
        )}

        <label className="setting-row checkbox">
          <input
            type="checkbox"
            disabled={!isHost}
            checked={s.allowDiscardAtMaxClues}
            onChange={(e) => set({ allowDiscardAtMaxClues: e.target.checked })}
          />
          <span>House rule: allow discarding at max clue tokens</span>
        </label>
      </section>

      {error && <p className="error-text">{error}</p>}

      {isHost ? (
        <button
          type="button"
          className="primary-btn"
          disabled={room.players.length < 2}
          onClick={onStart}
        >
          {room.players.length < 2 ? 'Waiting for players…' : `Start with ${room.players.length} players 🎆`}
        </button>
      ) : (
        <p className="muted center">Waiting for the host to start…</p>
      )}
    </div>
  );
}
