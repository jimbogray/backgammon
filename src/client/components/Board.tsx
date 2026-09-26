import type React from 'react';
import type { Board as BoardState, Color, Move } from '../../shared/engine';
import { countAt, opponent } from '../../shared/engine';

export type Spot = number | 'bar' | 'off';

/** A checker move to animate: the checker glides from `move.from` to where it now sits. */
export interface Motion {
  move: Move;
  color: Color;
  /** Changes for every new move, so the animation replays. */
  key: string;
}

interface Props {
  board: BoardState;
  you: Color;
  dice: number[] | null;
  /** Dice values still unused this turn (for dimming used dice). */
  remaining: number[] | null;
  diceColor: Color;
  /** Shake the dice while a roll is under way. */
  rolling?: boolean;
  motion?: Motion | null;
  cube: { value: number; owner: Color | null };
  selected: Spot | null;
  sources: Set<Spot>;
  targets: Set<Spot>;
  recent: Set<number>;
  onSpotClick: (spot: Spot) => void;
}

// Geometry (SVG user units).
const W = 760;
const H = 560;
const F = 20; // frame
const PW = 50; // point width
const PL = 210; // point length
const BAR_X = F + 6 * PW; // 320
const BAR_W = 50;
const RIGHT_X = BAR_X + BAR_W; // 370
const TRAY_X = RIGHT_X + 6 * PW + F; // 690
const TRAY_W = W - TRAY_X; // 70
const R = 23; // checker radius
const TOP = F;
const BOTTOM = H - F;

/** Point number (1..24) as seen by `you`, where 1 is your bottom-right point. */
function toViewerPoint(you: Color, index: number): number {
  return you === 'white' ? index + 1 : 24 - index;
}

function pointLeft(p: number): number {
  if (p <= 6) return RIGHT_X + (6 - p) * PW;
  if (p <= 12) return F + (12 - p) * PW;
  if (p <= 18) return F + (p - 13) * PW;
  return RIGHT_X + (p - 19) * PW;
}

/** Centre of the `i`th checker (from the edge) in a stack on a point or the bar, as seen by `you`. */
function stackXY(you: Color, color: Color, spot: number | 'bar', i: number): { x: number; y: number } {
  if (spot === 'bar') {
    const k = Math.min(i, 2);
    return { x: BAR_X + BAR_W / 2, y: color === you ? H / 2 + 30 + R + k * 2 * R : H / 2 - 30 - R - k * 2 * R };
  }
  const p = toViewerPoint(you, spot);
  const k = Math.min(i, 4);
  return { x: pointLeft(p) + PW / 2, y: p >= 13 ? TOP + R + k * 2 * R : BOTTOM - R - k * 2 * R };
}

function countOn(board: BoardState, color: Color, spot: number | 'bar'): number {
  return spot === 'bar' ? board.bar[color] : countAt(board, color, spot);
}

type Glide = { dx: number; dy: number; key: string };

function Checker({ cx, cy, color, label, ring, glide }: { cx: number; cy: number; color: Color; label?: string; ring?: 'source' | 'selected'; glide?: Glide }) {
  return (
    <g
      className={`checker ${color} ${glide ? 'gliding' : ''}`}
      style={glide ? ({ '--dx': `${glide.dx}px`, '--dy': `${glide.dy}px` } as React.CSSProperties) : undefined}
    >
      {ring && <circle cx={cx} cy={cy} r={R + 3} className={`ring ${ring}`} />}
      <circle cx={cx} cy={cy} r={R - 1} className="body" />
      <circle cx={cx} cy={cy} r={R - 8} className="inner" />
      {label && (
        <text x={cx} y={cy + 5} textAnchor="middle" className="stack-label">
          {label}
        </text>
      )}
    </g>
  );
}

const PIPS: Record<number, Array<[number, number]>> = {
  1: [[0.5, 0.5]],
  2: [[0.25, 0.25], [0.75, 0.75]],
  3: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]],
  4: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]],
  6: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.5], [0.75, 0.5], [0.25, 0.75], [0.75, 0.75]],
};

function Die({ x, y, size, value, color, used, rolling }: { x: number; y: number; size: number; value: number; color: Color; used: boolean; rolling?: boolean }) {
  return (
    <g className={`die ${color} ${used ? 'used' : ''} ${rolling ? 'rolling' : ''}`} style={{ transformOrigin: `${x + size / 2}px ${y + size / 2}px` }}>
      <rect x={x} y={y} width={size} height={size} rx={size * 0.18} />
      {PIPS[value].map(([px, py], i) => (
        <circle key={i} cx={x + px * size} cy={y + py * size} r={size * 0.09} />
      ))}
    </g>
  );
}

export function Board({ board, you, dice, remaining, diceColor, rolling, motion, cube, selected, sources, targets, recent, onSpotClick }: Props) {
  const them = opponent(you);

  // The checker that just moved starts at its old spot and glides to the top of its new stack.
  let glideTo: { spot: number | 'bar'; glide: Glide } | null = null;
  if (motion && motion.move.to !== 'off') {
    const { move, color } = motion;
    const to = move.to as number;
    const toCount = countAt(board, color, to);
    if (toCount > 0) {
      const src = stackXY(you, color, move.from, countOn(board, color, move.from));
      const dst = stackXY(you, color, to, toCount - 1);
      glideTo = { spot: to, glide: { dx: src.x - dst.x, dy: src.y - dst.y, key: motion.key } };
    }
  }
  const points = [];
  const checkers = [];
  const hits = [];

  for (let index = 0; index < 24; index++) {
    const p = toViewerPoint(you, index);
    const x = pointLeft(p);
    const top = p >= 13;
    const tipY = top ? TOP + PL : BOTTOM - PL;
    const baseY = top ? TOP : BOTTOM;
    const isTarget = targets.has(index);
    points.push(
      <polygon
        key={`pt${index}`}
        points={`${x},${baseY} ${x + PW},${baseY} ${x + PW / 2},${tipY}`}
        className={`point ${p % 2 ? 'odd' : 'even'} ${isTarget ? 'target' : ''} ${recent.has(index) ? 'recent' : ''}`}
      />,
    );
    points.push(
      <text key={`num${index}`} x={x + PW / 2} y={top ? 14 : H - 6} textAnchor="middle" className="point-number">
        {p}
      </text>,
    );

    const owner: Color | null = countAt(board, 'white', index) ? 'white' : countAt(board, 'black', index) ? 'black' : null;
    const n = owner ? countAt(board, owner, index) : 0;
    const visible = Math.min(n, 5);
    for (let i = 0; i < visible; i++) {
      const cy = top ? TOP + R + i * 2 * R : BOTTOM - R - i * 2 * R;
      const isTop = i === visible - 1;
      const glide = isTop && glideTo?.spot === index && owner === motion?.color ? glideTo.glide : undefined;
      checkers.push(
        <Checker
          key={glide ? `c${index}-${i}-${glide.key}` : `c${index}-${i}`}
          cx={x + PW / 2}
          cy={cy}
          color={owner!}
          glide={glide}
          label={isTop && n > 5 ? String(n) : undefined}
          ring={isTop ? (selected === index ? 'selected' : sources.has(index) ? 'source' : undefined) : undefined}
        />,
      );
    }
    if (isTarget) {
      const cy = top ? TOP + R + Math.min(n, 4) * 2 * R : BOTTOM - R - Math.min(n, 4) * 2 * R;
      checkers.push(<circle key={`t${index}`} cx={x + PW / 2} cy={cy} r={9} className="target-dot" />);
    }
    hits.push(
      <rect
        key={`hit${index}`}
        x={x}
        y={top ? TOP : BOTTOM - PL}
        width={PW}
        height={PL}
        className={`hit ${sources.has(index) || isTarget ? 'clickable' : ''}`}
        data-role={isTarget ? 'target' : sources.has(index) ? 'source' : undefined}
        onClick={() => onSpotClick(index)}
      >
        <title>{`Point ${p}`}</title>
      </rect>,
    );
  }

  // Bar: your checkers in the bottom half, the opponent's in the top half.
  const barCx = BAR_X + BAR_W / 2;
  for (const color of [you, them] as Color[]) {
    const n = board.bar[color];
    const mine = color === you;
    for (let i = 0; i < Math.min(n, 3); i++) {
      const cy = mine ? H / 2 + 30 + R + i * 2 * R : H / 2 - 30 - R - i * 2 * R;
      const isTop = i === Math.min(n, 3) - 1;
      checkers.push(
        <Checker
          key={`bar${color}${i}`}
          cx={barCx}
          cy={cy}
          color={color}
          label={isTop && n > 3 ? String(n) : undefined}
          ring={mine && isTop ? (selected === 'bar' ? 'selected' : sources.has('bar') ? 'source' : undefined) : undefined}
        />,
      );
    }
  }

  // Bear-off tray: yours at the bottom, the opponent's at the top.
  const tray = [];
  for (const color of [you, them] as Color[]) {
    const mine = color === you;
    for (let i = 0; i < board.off[color]; i++) {
      const y = mine ? BOTTOM - 12 - i * 13 : TOP + i * 13;
      tray.push(<rect key={`off${color}${i}`} x={TRAY_X + 10} y={y} width={TRAY_W - 20} height={11} rx={3} className={`borne ${color}`} />);
    }
  }

  // Doubling cube lives in the tray between the two stacks.
  const cubeY = cube.owner === null ? H / 2 - 18 : cube.owner === you ? H / 2 + 4 : H / 2 - 40;
  const cubeLabel = cube.owner === null && cube.value === 1 ? '64' : String(cube.value);

  // Dice sit in the right half, between the two rows.
  const diceEls: React.ReactElement[] = [];
  if (dice) {
    // A double still shows as two dice; the four moves it gives are counted beside them.
    const values = dice.slice(0, 2);
    const double = values[0] === values[1];
    const size = 44;
    const gap = 10;
    const total = values.length * size + (values.length - 1) * gap;
    let unused = remaining ? remaining.slice() : double ? [values[0], values[0], values[0], values[0]] : values.slice();
    // Mark dice as used left-to-right, matching values still remaining. For a
    // double, the first die dims once two of its four moves are played.
    const usedFlags = double
      ? [unused.length <= 2, unused.length === 0]
      : values.map((v) => {
          const k = unused.indexOf(v);
          if (k >= 0) {
            unused = [...unused.slice(0, k), ...unused.slice(k + 1)];
            return false;
          }
          return true;
        });
    const startX = diceColor === you ? RIGHT_X + (6 * PW - total) / 2 : F + (6 * PW - total) / 2;
    if (double && !rolling && unused.length > 0) {
      diceEls.push(
        <text key="moves-left" x={startX + total + 8} y={H / 2 + 6} className="dice-count">
          ×{unused.length}
        </text>,
      );
    }
    values.forEach((v, i) =>
      diceEls.push(
        <Die
          key={`d${i}`}
          x={startX + i * (size + gap)}
          y={H / 2 - size / 2}
          size={size}
          value={v}
          color={diceColor}
          used={usedFlags[i]}
          rolling={rolling}
        />,
      ),
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="board" role="img" aria-label="Backgammon board">
      <rect x={0} y={0} width={W} height={H} rx={10} className="frame" />
      <rect x={F} y={TOP} width={6 * PW} height={H - 2 * F} className="felt" />
      <rect x={RIGHT_X} y={TOP} width={6 * PW} height={H - 2 * F} className="felt" />
      <rect x={BAR_X} y={0} width={BAR_W} height={H} className="bar" />
      <rect x={TRAY_X} y={TOP} width={TRAY_W - 6} height={H - 2 * F} rx={4} className={`tray ${targets.has('off') ? 'target' : ''}`} />
      {points}
      {tray}
      <g className="cube">
        <rect x={TRAY_X + 14} y={cubeY} width={36} height={36} rx={6} />
        <text x={TRAY_X + 32} y={cubeY + 24} textAnchor="middle">
          {cubeLabel}
        </text>
      </g>
      {diceEls}
      {checkers}
      {hits}
      <rect
        x={BAR_X}
        y={H / 2}
        width={BAR_W}
        height={H / 2}
        className={`hit ${sources.has('bar') ? 'clickable' : ''}`}
        data-role={sources.has('bar') ? 'source' : undefined}
        onClick={() => onSpotClick('bar')}
      />
      <rect
        x={TRAY_X}
        y={H / 2}
        width={TRAY_W}
        height={H / 2 - F}
        className={`hit ${targets.has('off') ? 'clickable' : ''}`}
        data-role={targets.has('off') ? 'target' : undefined}
        onClick={() => onSpotClick('off')}
      >
        <title>Bear off</title>
      </rect>
    </svg>
  );
}
