import { useEffect, useMemo, useRef, useState } from 'react';
import type { RoomSnapshot } from '../backend';
import { CardBack, CardFace, negativeInfoText } from '../components/Card';
import { FireworksLayer, useFireworks } from '../components/Fireworks';
import {
  maxScore,
  scoreFlavor,
  suitsFor,
  type Card,
  type CardNumber,
  type Clue,
  type Color,
  type GameAction,
  type LogEntry,
} from '../engine';
import { clueText, formatLogEntry } from '../lib/format';
import type { PlayerPrefs } from '../lib/prefs';
import { sfxClue, sfxDraw, sfxFirework, sfxPlay, sfxSizzle, sfxTurn } from '../lib/sound';

const CLUEABLE_COLORS: Exclude<Color, 'rainbow'>[] = ['red', 'yellow', 'green', 'blue', 'white'];

interface Reveal {
  key: number;
  card: Card;
  success: boolean;
  completedStack: boolean;
  actorName: string;
}

export function GameScreen({
  snapshot,
  playerId,
  prefs,
  updatePrefs,
  onAction,
  onReorder,
  onRematch,
  onBackToLobby,
  error,
  clearError,
}: {
  snapshot: RoomSnapshot;
  playerId: string;
  prefs: PlayerPrefs;
  updatePrefs: (p: Partial<PlayerPrefs>) => void;
  onAction: (action: GameAction) => void;
  onReorder: (order: number[]) => void;
  onRematch: () => void;
  onBackToLobby: () => void;
  error: string | null;
  clearError: () => void;
}) {
  const { room } = snapshot;
  const view = snapshot.view!;
  const me = view.playerIndex;
  const names = useMemo(() => {
    const bySeat: string[] = [];
    for (const p of room.players) bySeat[p.seat] = p.name;
    return bySeat;
  }, [room.players]);
  const isHost = room.hostPlayerId === playerId;
  const myTurn = view.status === 'playing' && view.currentPlayer === me;
  const gameOver = view.status !== 'playing';
  const partners = Object.keys(view.partnerHands).map(Number).sort();
  const colorsInPlay = suitsFor(view.settings.suits);
  const clueColorOptions = CLUEABLE_COLORS.filter((c) => colorsInPlay.includes(c));

  // ----- selection / clue-building state -----
  const [selectedCardId, setSelectedCardId] = useState<number | null>(null);
  const [clueTarget, setClueTarget] = useState<number | null>(partners.length === 1 ? partners[0] : null);
  const [cluePick, setCluePick] = useState<Clue | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);

  // ----- animation state -----
  const [flashIds, setFlashIds] = useState<Set<number>>(new Set());
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const { bursts, launch } = useFireworks();
  const seenLog = useRef(view.log.length);
  const flashTimer = useRef<number | undefined>(undefined);
  const wasMyTurn = useRef(myTurn);

  const flash = (ids: number[], duration = 1800) => {
    window.clearTimeout(flashTimer.current);
    setFlashIds(new Set(ids));
    flashTimer.current = window.setTimeout(() => setFlashIds(new Set()), duration);
  };

  // React to new log entries: flash clues, run play drama, soft sounds.
  useEffect(() => {
    const fresh = view.log.slice(seenLog.current);
    seenLog.current = view.log.length;
    for (const entry of fresh) {
      if (entry.type === 'clue') {
        flash(entry.cardIds);
        sfxClue();
      } else if (entry.type === 'play') {
        const actorName = entry.actor === me ? 'You' : (names[entry.actor] ?? '');
        const r: Reveal = { key: Date.now(), ...{ card: entry.card, success: entry.success, completedStack: entry.completedStack }, actorName };
        setReveal(r);
        // Beat of suspense: flip at 350ms, result at 900ms, clear at 2000ms.
        window.setTimeout(() => {
          if (entry.success) {
            launch({ big: entry.completedStack });
            if (entry.completedStack) sfxFirework();
            else sfxPlay();
          } else {
            sfxSizzle();
          }
        }, 900);
        window.setTimeout(() => setReveal((cur) => (cur?.key === r.key ? null : cur)), 2100);
      } else if (entry.type === 'draw') {
        sfxDraw();
      } else if (entry.type === 'gameEnd' && entry.outcome === 'won') {
        for (let i = 0; i < 6; i++) window.setTimeout(() => launch({ big: true }), 400 * i + 1100);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.log.length]);

  // Turn notification: vibration / sound / browser notification.
  useEffect(() => {
    if (myTurn && !wasMyTurn.current) {
      if (prefs.vibrate && 'vibrate' in navigator) navigator.vibrate?.(80);
      sfxTurn();
      if (prefs.notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        new Notification('Hanabi — your turn!', { body: `Room ${room.roomCode}` });
      }
    }
    wasMyTurn.current = myTurn;
  }, [myTurn, prefs.vibrate, prefs.notifications, room.roomCode]);

  // Reset transient selections when the turn moves on.
  useEffect(() => {
    setSelectedCardId(null);
    setCluePick(null);
    if (partners.length === 1) setClueTarget(partners[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.turn]);

  // ----- replay last clue: available only until you take your turn -----
  const replayAvailable = useMemo(() => {
    if (!view.lastClue) return false;
    let idx = -1;
    for (let i = view.log.length - 1; i >= 0; i--) {
      if (view.log[i].type === 'clue') {
        idx = i;
        break;
      }
    }
    if (idx === -1) return false;
    return !view.log
      .slice(idx + 1)
      .some((e) => 'actor' in e && e.actor === me && (e.type === 'play' || e.type === 'discard' || e.type === 'clue'));
  }, [view.log, view.lastClue, me]);

  const replayLastClue = () => {
    if (!view.lastClue) return;
    flash(view.lastClue.cardIds);
    sfxClue();
  };

  // ----- own-hand drag-to-reorder -----
  const handRef = useRef<HTMLDivElement>(null);
  const [localOrder, setLocalOrder] = useState<number[]>(view.ownHand.map((c) => c.id));
  const drag = useRef<{ id: number; startX: number; moved: boolean } | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);

  useEffect(() => {
    const ids = view.ownHand.map((c) => c.id);
    setLocalOrder((prev) => {
      const same = prev.length === ids.length && prev.every((id) => ids.includes(id));
      return same ? prev : ids;
    });
  }, [view.ownHand]);

  const orderedOwnHand = localOrder
    .map((id) => view.ownHand.find((c) => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const onCardPointerDown = (id: number, e: React.PointerEvent) => {
    if (gameOver) return;
    drag.current = { id, startX: e.clientX, moved: false };
    setDragId(id);
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !handRef.current) return;
    if (Math.abs(e.clientX - d.startX) > 8) d.moved = true;
    if (!d.moved) return;
    const cards = Array.from(handRef.current.querySelectorAll('[data-own-card]'));
    let targetIdx = cards.length - 1;
    for (let i = 0; i < cards.length; i++) {
      const rect = cards[i].getBoundingClientRect();
      if (e.clientX < rect.left + rect.width / 2) {
        targetIdx = i;
        break;
      }
    }
    setLocalOrder((prev) => {
      const from = prev.indexOf(d.id);
      if (from === -1 || from === targetIdx) return prev;
      const next = prev.filter((x) => x !== d.id);
      next.splice(targetIdx, 0, d.id);
      return next;
    });
  };

  const onCardPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragId(null);
    if (!d) return;
    if (d.moved) {
      const viewOrder = view.ownHand.map((c) => c.id);
      if (localOrder.join(',') !== viewOrder.join(',')) onReorder(localOrder);
    } else {
      setSelectedCardId((cur) => (cur === d.id ? null : d.id));
      setCluePick(null);
    }
  };

  // ----- actions -----
  const canDiscard = view.settings.allowDiscardAtMaxClues || view.clues < view.settings.maxClues;
  const submitPlay = () => {
    if (selectedCardId === null) return;
    onAction({ type: 'play', cardId: selectedCardId, drawSide: prefs.drawSide });
    setSelectedCardId(null);
  };
  const submitDiscard = () => {
    if (selectedCardId === null) return;
    onAction({ type: 'discard', cardId: selectedCardId, drawSide: prefs.drawSide });
    setSelectedCardId(null);
  };
  const submitClue = () => {
    if (clueTarget === null || !cluePick) return;
    onAction({ type: 'clue', targetPlayer: clueTarget, clue: cluePick });
    setCluePick(null);
  };

  const clueWouldMatch = (clue: Clue): number => {
    if (clueTarget === null) return 0;
    const hand = view.partnerHands[clueTarget] ?? [];
    return hand.filter((c) =>
      clue.kind === 'number' ? c.number === clue.number : c.color === clue.color || c.color === 'rainbow',
    ).length;
  };

  const previewIds = useMemo(() => {
    if (!cluePick || clueTarget === null) return new Set<number>();
    const hand = view.partnerHands[clueTarget] ?? [];
    return new Set(
      hand
        .filter((c) =>
          cluePick.kind === 'number' ? c.number === cluePick.number : c.color === cluePick.color || c.color === 'rainbow',
        )
        .map((c) => c.id),
    );
  }, [cluePick, clueTarget, view.partnerHands]);

  const selectedCard = orderedOwnHand.find((c) => c.id === selectedCardId);
  const turnName = view.status !== 'playing' ? null : view.currentPlayer === me ? 'Your turn' : `${names[view.currentPlayer]}’s turn`;
  const discardByColor = useMemo(() => {
    const groups = new Map<Color, Card[]>();
    for (const color of colorsInPlay) groups.set(color, []);
    for (const c of view.discard) groups.get(c.color)?.push(c);
    for (const cards of groups.values()) cards.sort((a, b) => a.number - b.number);
    return groups;
  }, [view.discard, colorsInPlay]);

  const disconnected = room.players.filter((p) => !p.connected);

  return (
    <div className="screen game">
      <FireworksLayer bursts={bursts} />

      {/* ---- top bar ---- */}
      <header className={`game-topbar ${myTurn ? 'my-turn' : ''}`}>
        <span className="topbar-room">{room.roomCode}</span>
        <span className="topbar-turn">{turnName ?? 'Game over'}</span>
        <span className="topbar-actions">
          {replayAvailable && (
            <button type="button" className="icon-btn" title="Replay last clue" onClick={replayLastClue}>
              ↻
            </button>
          )}
          <button type="button" className="icon-btn" title="Preferences" onClick={() => setPrefsOpen(true)}>
            ⚙
          </button>
        </span>
      </header>

      {view.finalTurnsRemaining !== null && !gameOver && (
        <p className="final-turns">Deck empty — {view.finalTurnsRemaining} turn{view.finalTurnsRemaining === 1 ? '' : 's'} left</p>
      )}
      {disconnected.length > 0 && (
        <p className="final-turns">waiting for {disconnected.map((p) => p.name).join(', ')}…</p>
      )}

      {/* ---- partners ---- */}
      <section className="partners">
        {partners.map((seat) => {
          const isTarget = myTurn && clueTarget === seat;
          return (
            <div
              key={seat}
              className={`partner ${view.currentPlayer === seat && !gameOver ? 'their-turn' : ''} ${isTarget ? 'clue-target' : ''}`}
              onClick={() => {
                if (myTurn && view.clues > 0 && partners.length > 1) {
                  setClueTarget(seat);
                  setCluePick(null);
                }
              }}
            >
              <p className="partner-name">
                {names[seat]}
                {view.currentPlayer === seat && !gameOver ? ' ◂' : ''}
              </p>
              <div className="hand">
                {(view.partnerHands[seat] ?? []).map((card) => (
                  <CardFace
                    key={card.id}
                    card={card}
                    knowledge={view.partnerKnowledge[card.id]}
                    flashing={flashIds.has(card.id) || previewIds.has(card.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </section>

      {/* ---- table center: stacks + side info ---- */}
      <section className="table-center">
        <div className="stacks">
          {colorsInPlay.map((color) => {
            const height = view.stacks[color] ?? 0;
            const dead = view.deadStacks.includes(color);
            return (
              <div key={color} className={`stack color-${color} ${dead ? 'dead' : ''} ${height === 5 ? 'complete' : ''}`}>
                <span className="stack-number">{height > 0 ? height : '·'}</span>
                {dead && <span className="stack-dead-mark" title="This stack can no longer be completed">✕</span>}
              </div>
            );
          })}
        </div>

        <div className="side-info">
          <div className="tokens" title="Clue tokens">
            {Array.from({ length: view.settings.maxClues }, (_, i) => (
              <span key={i} className={`token clue ${i < view.clues ? 'full' : ''}`} />
            ))}
          </div>
          <div className="tokens" title="Errors remaining">
            {Array.from({ length: view.settings.errorsAllowed + 1 }, (_, i) => (
              <span key={i} className={`token fuse ${i < view.errors ? 'burned' : ''}`} />
            ))}
          </div>
          <div className="deck-discard">
            <span className="deck-count" title="Cards left in deck">🂠 {view.deckCount}</span>
            <button type="button" className="ghost-btn small" onClick={() => setDiscardOpen(true)}>
              Discards ({view.discard.length})
            </button>
          </div>
        </div>
      </section>

      {/* ---- latest log line ---- */}
      <button type="button" className="log-ticker" onClick={() => setLogOpen(true)}>
        {[...view.log]
          .reverse()
          .map((e) => formatLogEntry(e, names, me, !prefs.clueIndicators))
          .find((t) => t) ?? 'Game started — good luck! Tap for log.'}
      </button>

      {/* ---- clue panel (your turn) ---- */}
      {myTurn && selectedCardId === null && (
        <section className="clue-panel">
          {partners.length > 1 && clueTarget === null && <p className="muted center">Tap a partner to clue them</p>}
          {clueTarget !== null && (
            <>
              <p className="clue-panel-title">
                {view.clues > 0 ? (
                  <>Clue {names[clueTarget]} <span className="muted">(costs 1 token)</span></>
                ) : (
                  <span className="muted">No clue tokens — play or discard</span>
                )}
              </p>
              <div className="clue-chips">
                {clueColorOptions.map((color) => {
                  const n = clueWouldMatch({ kind: 'color', color });
                  return (
                    <button
                      key={color}
                      type="button"
                      className={`chip swatch-${color} ${cluePick?.kind === 'color' && cluePick.color === color ? 'picked' : ''}`}
                      disabled={view.clues <= 0 || n === 0}
                      onClick={() => setCluePick({ kind: 'color', color })}
                      title={n === 0 ? 'No matching cards (clues must touch a card)' : `${n} card(s)`}
                    />
                  );
                })}
                {([1, 2, 3, 4, 5] as CardNumber[]).map((number) => {
                  const n = clueWouldMatch({ kind: 'number', number });
                  return (
                    <button
                      key={number}
                      type="button"
                      className={`chip number ${cluePick?.kind === 'number' && cluePick.number === number ? 'picked' : ''}`}
                      disabled={view.clues <= 0 || n === 0}
                      onClick={() => setCluePick({ kind: 'number', number })}
                      title={n === 0 ? 'No matching cards (clues must touch a card)' : `${n} card(s)`}
                    >
                      {number}
                    </button>
                  );
                })}
              </div>
              {cluePick && (
                <div className="confirm-row">
                  <button type="button" className="primary-btn slim" onClick={submitClue}>
                    Clue {clueText(cluePick)} → {names[clueTarget]}
                  </button>
                  <button type="button" className="ghost-btn small" onClick={() => setCluePick(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ---- selected own card actions ---- */}
      {selectedCard && (
        <section className="clue-panel">
          {prefs.clueIndicators && (
            <p className="muted center known-line">
              {selectedCard.knowledge.cluedColors.length > 0 || selectedCard.knowledge.cluedNumber !== null
                ? `Clued: ${[
                    ...selectedCard.knowledge.cluedColors,
                    ...(selectedCard.knowledge.cluedNumber !== null ? [String(selectedCard.knowledge.cluedNumber)] : []),
                  ].join(' · ')}`
                : 'No clues on this card'}
              {negativeInfoText(selectedCard.knowledge) ? ` — ${negativeInfoText(selectedCard.knowledge)}` : ''}
            </p>
          )}
          {myTurn ? (
            <div className="confirm-row">
              <button type="button" className="primary-btn slim" onClick={submitPlay}>
                Play ▸
              </button>
              <button
                type="button"
                className="primary-btn slim secondary"
                disabled={!canDiscard}
                title={canDiscard ? '' : 'Cannot discard at max clue tokens'}
                onClick={submitDiscard}
              >
                Discard
              </button>
              <button type="button" className="ghost-btn small" onClick={() => setSelectedCardId(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <p className="muted center">Wait for your turn to play or discard</p>
          )}
        </section>
      )}

      {/* ---- own hand ---- */}
      <section className="own-hand-area">
        <p className="own-hand-label">
          your hand <span className="muted">(drag to reorder)</span>
        </p>
        <div className="hand own" ref={handRef}>
          {orderedOwnHand.map((c) => (
            <div
              key={c.id}
              data-own-card
              className={`own-card-slot ${dragId === c.id ? 'dragging' : ''}`}
              onPointerDown={(e) => onCardPointerDown(c.id, e)}
              onPointerMove={onCardPointerMove}
              onPointerUp={onCardPointerUp}
              onPointerCancel={onCardPointerUp}
            >
              <CardBack
                knowledge={c.knowledge}
                showIndicators={prefs.clueIndicators}
                flashing={flashIds.has(c.id)}
                selected={selectedCardId === c.id}
              />
            </div>
          ))}
        </div>
      </section>

      {error && (
        <button type="button" className="error-toast" onClick={clearError}>
          {error} ✕
        </button>
      )}

      {/* ---- play reveal drama ---- */}
      {reveal && (
        <div className="reveal-overlay" key={reveal.key}>
          <div className={`reveal-card color-${reveal.card.color} ${reveal.success ? 'success' : 'failure'}`}>
            <div className="reveal-inner">
              <div className="reveal-front">花</div>
              <div className="reveal-back">
                <span className="card-number">{reveal.card.number}</span>
              </div>
            </div>
          </div>
          <p className="reveal-caption">
            {reveal.actorName} {reveal.success ? 'played' : 'misplayed'} …
          </p>
        </div>
      )}

      {/* ---- discard drawer ---- */}
      {discardOpen && (
        <div className="overlay" onClick={() => setDiscardOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Discard pile</h2>
            {view.discard.length === 0 && <p className="muted">Nothing discarded yet.</p>}
            {colorsInPlay.map((color) => {
              const cards = discardByColor.get(color) ?? [];
              if (cards.length === 0) return null;
              return (
                <div key={color} className="discard-row">
                  {cards.map((card) => (
                    <CardFace key={card.id} card={card} small />
                  ))}
                </div>
              );
            })}
            <button type="button" className="ghost-btn" onClick={() => setDiscardOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {/* ---- full log ---- */}
      {logOpen && (
        <div className="overlay" onClick={() => setLogOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Action log</h2>
            <ul className="log-list">
              {view.log
                .map((entry, i) => ({ entry, i, text: formatLogEntry(entry, names, me, !prefs.clueIndicators) }))
                .filter((x) => x.text)
                .reverse()
                .map((x) => (
                  <li key={x.i}>{x.text}</li>
                ))}
            </ul>
            <button type="button" className="ghost-btn" onClick={() => setLogOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {/* ---- preferences ---- */}
      {prefsOpen && (
        <div className="overlay" onClick={() => setPrefsOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Your preferences</h2>
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={prefs.clueIndicators}
                onChange={(e) => updatePrefs({ clueIndicators: e.target.checked })}
              />
              <span>
                Clue indicators on my cards
                <em className="muted block">off = expert mode: remember clues yourself</em>
              </span>
            </label>
            <label className="setting-row checkbox">
              <span>New cards enter on the</span>
              <div className="segmented small">
                <button type="button" className={prefs.drawSide === 'left' ? 'active' : ''} onClick={() => updatePrefs({ drawSide: 'left' })}>left</button>
                <button type="button" className={prefs.drawSide === 'right' ? 'active' : ''} onClick={() => updatePrefs({ drawSide: 'right' })}>right</button>
              </div>
            </label>
            <label className="setting-row checkbox">
              <input type="checkbox" checked={prefs.sound} onChange={(e) => updatePrefs({ sound: e.target.checked })} />
              <span>Soft sound effects</span>
            </label>
            <label className="setting-row checkbox">
              <input type="checkbox" checked={prefs.vibrate} onChange={(e) => updatePrefs({ vibrate: e.target.checked })} />
              <span>Vibrate on my turn</span>
            </label>
            <label className="setting-row checkbox">
              <input
                type="checkbox"
                checked={prefs.notifications}
                onChange={async (e) => {
                  const on = e.target.checked;
                  if (on && 'Notification' in window && Notification.permission !== 'granted') {
                    const perm = await Notification.requestPermission();
                    if (perm !== 'granted') return;
                  }
                  updatePrefs({ notifications: on });
                }}
              />
              <span>Browser notification on my turn</span>
            </label>
            <button type="button" className="ghost-btn" onClick={() => setPrefsOpen(false)}>Done</button>
          </div>
        </div>
      )}

      {/* ---- end screen ---- */}
      {gameOver && !reveal && (
        <div className="overlay end">
          <div className="sheet end-sheet">
            <h2 className="end-title">
              {view.status === 'won' ? 'Perfect show! 🎆' : view.status === 'lost' ? 'The fuses ran out 💨' : 'The show is over'}
            </h2>
            <p className="end-score">
              {view.score} <span className="muted">/ {maxScore(view.settings)}</span>
            </p>
            <p className="end-flavor">{scoreFlavor(view.score, maxScore(view.settings))}</p>
            <div className="stacks end-stacks">
              {colorsInPlay.map((color) => (
                <div key={color} className={`stack color-${color} ${ (view.stacks[color] ?? 0) === 5 ? 'complete' : ''}`}>
                  <span className="stack-number">{view.stacks[color] || '·'}</span>
                </div>
              ))}
            </div>
            {isHost ? (
              <div className="confirm-row">
                <button type="button" className="primary-btn slim" onClick={onRematch}>
                  Rematch 🎇
                </button>
                <button type="button" className="ghost-btn" onClick={onBackToLobby}>
                  Change settings
                </button>
              </div>
            ) : (
              <p className="muted center">Waiting for the host to start a rematch…</p>
            )}
            <button type="button" className="ghost-btn small" onClick={() => setLogOpen(true)}>
              View log
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Re-exported for ticker reuse. */
export type { LogEntry };
