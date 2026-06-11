import type { Clue, LogEntry } from '../engine';

const COLOR_NAMES: Record<string, string> = {
  red: 'red',
  yellow: 'yellow',
  green: 'green',
  blue: 'blue',
  white: 'white',
  rainbow: 'rainbow',
};

export function clueText(clue: Clue): string {
  return clue.kind === 'color' ? `${COLOR_NAMES[clue.color]}s` : `${clue.number}s`;
}

/**
 * Plain-English log line for `viewer`.
 * When the viewer has clue indicators OFF, clues they RECEIVED are censored
 * ("Maria gave you a clue") so the log can't be used to recover forgotten
 * clues. Clues given to partners stay fully visible.
 */
export function formatLogEntry(
  entry: LogEntry,
  names: string[],
  viewer: number,
  censorReceivedClues: boolean,
): string {
  const name = (p: number) => (p === viewer ? 'You' : (names[p] ?? `Player ${p + 1}`));
  switch (entry.type) {
    case 'clue': {
      if (entry.target === viewer && censorReceivedClues) {
        return `${name(entry.actor)} gave you a clue`;
      }
      const who = entry.target === viewer ? 'your' : `${name(entry.target)}’s`;
      const verb = entry.actor === viewer ? 'clued' : 'clued';
      const count = entry.positions.length;
      return `${name(entry.actor)} ${verb} ${who} ${clueText(entry.clue)} (${count} card${count === 1 ? '' : 's'})`;
    }
    case 'play': {
      const card = `${COLOR_NAMES[entry.card.color]} ${entry.card.number}`;
      if (entry.success) {
        const extra = entry.completedStack ? ' — stack complete! 🎆' : '';
        return `${name(entry.actor)} played a ${card} ✓${extra}`;
      }
      return `${name(entry.actor)} misplayed a ${card} ✗ (fuse burned)`;
    }
    case 'discard':
      return `${name(entry.actor)} discarded a ${COLOR_NAMES[entry.card.color]} ${entry.card.number}`;
    case 'draw':
      return ''; // draws are implicit; skip in the visible log
    case 'gameEnd':
      switch (entry.outcome) {
        case 'won':
          return `Perfect show — every stack complete! Final score ${entry.score} 🎆`;
        case 'lost':
          return `The fuses ran out. Final score ${entry.score}`;
        case 'finished':
          return `Deck empty — show over. Final score ${entry.score}`;
      }
  }
}
