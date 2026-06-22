// Pure vote-counting logic for debate matches. No I/O — unit-testable.

export const VOTE_WINDOW_SEC = 25;
export const TIE_EPS = 0.02;
export const SWING_MIN = 0.05;
export const POINTS_WIN = 3;
export const POINTS_TIE = 1;

export type Side = 'A' | 'B';

export interface WindowTally {
  a: number;
  b: number;
}

export interface Verdict {
  winnerSide: 'A' | 'B' | 'tie';
  finalShareA: number;
  finalShareB: number;
  swingWinner: 'A' | 'B' | 'none';
  swingPct: number;
}

// Share of each side within a single window. Empty window = neutral 0.5/0.5.
export function windowShare(w: WindowTally): { a: number; b: number } {
  const t = w.a + w.b;
  if (t === 0) return { a: 0.5, b: 0.5 };
  return { a: w.a / t, b: w.b / t };
}

// Count a window from a per-user vote map (last-write-wins is inherent to the map).
export function tallyVotes(votes: Map<string, Side>): WindowTally {
  let a = 0;
  let b = 0;
  for (const s of votes.values()) {
    if (s === 'A') a++;
    else if (s === 'B') b++;
  }
  return { a, b };
}

// Weighted verdict: every window weight 1, the LAST window weight 2 (climax).
// Swing: how much a side gained from the first window to the last.
export function computeVerdict(windows: WindowTally[]): Verdict {
  if (windows.length === 0) {
    return { winnerSide: 'tie', finalShareA: 0.5, finalShareB: 0.5, swingWinner: 'none', swingPct: 0 };
  }

  let wa = 0;
  let wb = 0;
  const lastIdx = windows.length - 1;
  windows.forEach((w, i) => {
    const weight = i === lastIdx ? 2 : 1;
    wa += w.a * weight;
    wb += w.b * weight;
  });

  const tot = wa + wb;
  const finalShareA = tot === 0 ? 0.5 : wa / tot;
  const finalShareB = tot === 0 ? 0.5 : wb / tot;

  let winnerSide: 'A' | 'B' | 'tie';
  if (Math.abs(finalShareA - finalShareB) <= TIE_EPS) winnerSide = 'tie';
  else winnerSide = finalShareA > finalShareB ? 'A' : 'B';

  const first = windowShare(windows[0]);
  const last = windowShare(windows[lastIdx]);
  const dA = last.a - first.a;
  const dB = last.b - first.b;
  const maxD = Math.max(dA, dB);

  let swingWinner: 'A' | 'B' | 'none' = 'none';
  let swingPct = 0;
  if (maxD >= SWING_MIN) {
    swingWinner = dA >= dB ? 'A' : 'B';
    swingPct = maxD;
  }

  return { winnerSide, finalShareA, finalShareB, swingWinner, swingPct };
}

// Normalize a side label into a stable tribe key, e.g. "iPhone 15" -> "iphone-15".
export function sideKey(label: string): string {
  return (label || 'side')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'side';
}
