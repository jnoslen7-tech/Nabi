import { useEffect, useState } from 'react';
import type { DrawSide } from '../engine';

/** Per-player, device-local preferences. Changeable mid-game; never part of game state. */
export interface PlayerPrefs {
  /** Show clue badges/rings on your own cards. Off = expert memory mode. */
  clueIndicators: boolean;
  /** Which side newly drawn cards enter your hand. */
  drawSide: DrawSide;
  /** Soft SFX. Default off — players are usually on FaceTime/Zoom. */
  sound: boolean;
  /** Vibrate on your turn (phones). */
  vibrate: boolean;
  /** Browser notification when it becomes your turn. */
  notifications: boolean;
}

export const DEFAULT_PREFS: PlayerPrefs = {
  clueIndicators: true,
  drawSide: 'right',
  sound: false,
  vibrate: true,
  notifications: false,
};

const keyFor = (playerId: string) => `hanabi-prefs-${playerId}`;

export function loadPrefs(playerId: string): PlayerPrefs {
  try {
    const raw = localStorage.getItem(keyFor(playerId));
    if (raw) return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
  } catch {
    /* corrupted or unavailable storage — fall through to defaults */
  }
  return { ...DEFAULT_PREFS };
}

export function savePrefs(playerId: string, prefs: PlayerPrefs): void {
  try {
    localStorage.setItem(keyFor(playerId), JSON.stringify(prefs));
  } catch {
    /* storage unavailable (private mode) — prefs just won't persist */
  }
}

export function usePrefs(playerId: string): [PlayerPrefs, (update: Partial<PlayerPrefs>) => void] {
  const [prefs, setPrefs] = useState(() => loadPrefs(playerId));
  useEffect(() => {
    setPrefs(loadPrefs(playerId));
  }, [playerId]);
  const update = (patch: Partial<PlayerPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      savePrefs(playerId, next);
      return next;
    });
  };
  return [prefs, update];
}

/** Session identity per room so a refresh rejoins the same seat. */
export function rememberSeat(roomCode: string, playerId: string, name: string): void {
  try {
    localStorage.setItem(`hanabi-seat-${roomCode.toUpperCase()}`, JSON.stringify({ playerId, name }));
  } catch {
    /* ignore */
  }
}

export function recallSeat(roomCode: string): { playerId: string; name: string } | null {
  try {
    const raw = localStorage.getItem(`hanabi-seat-${roomCode.toUpperCase()}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
