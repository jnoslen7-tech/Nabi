import { useEffect, useMemo, useState } from 'react';

interface Burst {
  id: number;
  x: number;
  y: number;
  hue: number;
  particles: number;
}

let burstId = 0;

/**
 * Lightweight CSS-particle fireworks. Mount once; call the returned `launch`
 * to fire a burst (bigger = stack completion / win).
 */
export function useFireworks() {
  const [bursts, setBursts] = useState<Burst[]>([]);

  const launch = (opts?: { big?: boolean; x?: number; y?: number }) => {
    const burst: Burst = {
      id: burstId++,
      x: opts?.x ?? 15 + Math.random() * 70,
      y: opts?.y ?? 15 + Math.random() * 40,
      hue: Math.floor(Math.random() * 360),
      particles: opts?.big ? 26 : 14,
    };
    setBursts((prev) => [...prev.slice(-4), burst]);
    window.setTimeout(() => {
      setBursts((prev) => prev.filter((b) => b.id !== burst.id));
    }, 1600);
  };

  return { bursts, launch };
}

export function FireworksLayer({ bursts }: { bursts: Burst[] }) {
  return (
    <div className="fireworks-layer" aria-hidden="true">
      {bursts.map((b) => (
        <BurstView key={b.id} burst={b} />
      ))}
    </div>
  );
}

function BurstView({ burst }: { burst: Burst }) {
  const [risen, setRisen] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setRisen(true), 350);
    return () => window.clearTimeout(t);
  }, []);

  const particles = useMemo(
    () =>
      Array.from({ length: burst.particles }, (_, i) => {
        const angle = (i / burst.particles) * Math.PI * 2 + Math.random() * 0.4;
        const dist = 38 + Math.random() * 46;
        return {
          dx: Math.cos(angle) * dist,
          dy: Math.sin(angle) * dist,
          hue: burst.hue + Math.floor(Math.random() * 50) - 25,
          delay: Math.random() * 0.08,
        };
      }),
    [burst],
  );

  return (
    <div className="burst" style={{ left: `${burst.x}%`, top: `${burst.y}%` }}>
      {!risen && <span className="burst-trail" style={{ color: `hsl(${burst.hue} 90% 70%)` }} />}
      {risen &&
        particles.map((p, i) => (
          <span
            key={i}
            className="burst-particle"
            style={
              {
                '--dx': `${p.dx}px`,
                '--dy': `${p.dy}px`,
                background: `hsl(${p.hue} 95% 70%)`,
                animationDelay: `${p.delay}s`,
              } as React.CSSProperties
            }
          />
        ))}
    </div>
  );
}
