import { useState } from 'react';

export function Home({
  initialRoomCode,
  onCreate,
  onJoin,
  busy,
  error,
}: {
  initialRoomCode: string | null;
  onCreate: (name: string) => void;
  onJoin: (roomCode: string, name: string) => void;
  busy: boolean;
  error: string | null;
}) {
  const [name, setName] = useState('');
  const [code, setCode] = useState(initialRoomCode ?? '');
  const [mode, setMode] = useState<'create' | 'join'>(initialRoomCode ? 'join' : 'create');

  const canSubmit = name.trim().length > 0 && (mode === 'create' || code.trim().length >= 3);

  return (
    <div className="screen home">
      <div className="home-hero">
        <div className="home-lantern">花火</div>
        <h1>Hanabi</h1>
        <p className="tagline">build fireworks together, one clue at a time</p>
      </div>

      <form
        className="home-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit || busy) return;
          if (mode === 'create') onCreate(name.trim());
          else onJoin(code.trim().toUpperCase(), name.trim());
        }}
      >
        <input
          className="text-input"
          placeholder="Your name"
          value={name}
          maxLength={16}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />

        <div className="segmented">
          <button
            type="button"
            className={mode === 'create' ? 'active' : ''}
            onClick={() => setMode('create')}
          >
            New game
          </button>
          <button
            type="button"
            className={mode === 'join' ? 'active' : ''}
            onClick={() => setMode('join')}
          >
            Join with code
          </button>
        </div>

        {mode === 'join' && (
          <input
            className="text-input room-code-input"
            placeholder="ROOM CODE (e.g. FOX-742)"
            value={code}
            maxLength={8}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
        )}

        {error && <p className="error-text">{error}</p>}

        <button type="submit" className="primary-btn" disabled={!canSubmit || busy}>
          {busy ? '…' : mode === 'create' ? 'Create room' : 'Join room'}
        </button>
      </form>
    </div>
  );
}
