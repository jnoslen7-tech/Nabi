import type { Card, CardKnowledge } from '../engine';

const COLOR_SYMBOL: Record<string, string> = {
  red: '✦',
  yellow: '✦',
  green: '✦',
  blue: '✦',
  white: '✦',
  rainbow: '☄',
};

/** A face-up card (partners' hands, discard, stacks). */
export function CardFace({
  card,
  flashing,
  small,
  knowledge,
}: {
  card: Card;
  flashing?: boolean;
  small?: boolean;
  knowledge?: CardKnowledge;
}) {
  const known = knowledge && (knowledge.cluedColors.length > 0 || knowledge.cluedNumber !== null);
  return (
    <div
      className={`card face color-${card.color} ${flashing ? 'flashing' : ''} ${small ? 'small' : ''}`}
    >
      <span className="card-number">{card.number}</span>
      <span className="card-symbol">{COLOR_SYMBOL[card.color]}</span>
      {known && <span className="partner-known" title="They have clue info on this card">●</span>}
    </div>
  );
}

/** Your own card: face-down, optionally decorated with accumulated clue info. */
export function CardBack({
  knowledge,
  showIndicators,
  flashing,
  selected,
  onClick,
}: {
  knowledge: CardKnowledge;
  showIndicators: boolean;
  flashing?: boolean;
  selected?: boolean;
  onClick?: () => void;
}) {
  const colors = showIndicators ? knowledge.cluedColors : [];
  const number = showIndicators ? knowledge.cluedNumber : null;
  // A rainbow card clued with 2+ colors is deducibly rainbow.
  const ringColor = colors.length >= 2 ? 'rainbow' : colors[0];
  return (
    <button
      type="button"
      className={`card back ${flashing ? 'flashing' : ''} ${selected ? 'selected' : ''} ${
        ringColor ? `ring-${ringColor}` : ''
      }`}
      onClick={onClick}
    >
      <span className="back-pattern">花</span>
      {number !== null && <span className="badge badge-number">{number}</span>}
      {ringColor && <span className={`badge badge-color swatch-${ringColor}`} />}
    </button>
  );
}

/** "Not: …" line for a selected own card. */
export function negativeInfoText(knowledge: CardKnowledge): string | null {
  const parts: string[] = [];
  if (knowledge.notColors.length > 0) parts.push(`not ${knowledge.notColors.join(', ')}`);
  if (knowledge.notNumbers.length > 0) parts.push(`not ${[...knowledge.notNumbers].sort().join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}
