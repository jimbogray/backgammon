// Backgammon rules engine. Pure functions with no I/O, shared by the server
// (which is authoritative and validates every action) and the browser
// (which uses it to highlight legal moves before a turn is submitted).
//
// Board layout: `points[0..23]`. Positive counts are white checkers, negative
// counts are black checkers. White moves from index 23 toward 0 and bears off
// below index 0 (white's home board is 0..5). Black moves from 0 toward 23 and
// bears off above index 23 (black's home board is 18..23).

export type Color = 'white' | 'black';

export interface Board {
  points: number[];
  bar: Record<Color, number>;
  off: Record<Color, number>;
}

export interface Move {
  from: number | 'bar';
  to: number | 'off';
  die: number;
}

export type Phase = 'rolling' | 'moving' | 'doubling' | 'finished';
export type ResultType = 'normal' | 'gammon' | 'backgammon';
export type EndReason = 'bearoff' | 'resign' | 'drop';

export interface TurnRecord {
  color: Color;
  dice: number[];
  moves: Move[];
}

export interface GameState {
  board: Board;
  turn: Color;
  phase: Phase;
  /** The two dice rolled for the current turn (null while waiting to roll). */
  dice: number[] | null;
  cube: { value: number; owner: Color | null };
  doubleOfferedBy: Color | null;
  openingRoll: { white: number; black: number };
  lastTurn: TurnRecord | null;
  turnNumber: number;
  result: null | {
    winner: Color;
    type: ResultType;
    reason: EndReason;
    points: number;
  };
}

export type Action =
  | { type: 'roll' }
  | { type: 'move'; moves: Move[] }
  | { type: 'double' }
  | { type: 'take' }
  | { type: 'drop' }
  | { type: 'resign' };

export type Roller = () => number;

export const CHECKERS_PER_SIDE = 15;
export const MAX_CUBE = 64;

export function opponent(color: Color): Color {
  return color === 'white' ? 'black' : 'white';
}

export function initialBoard(): Board {
  const points = new Array<number>(24).fill(0);
  // White: 2 on the 24-point, 5 on the 13-point, 3 on the 8-point, 5 on the 6-point.
  points[23] = 2;
  points[12] = 5;
  points[7] = 3;
  points[5] = 5;
  // Black mirrors white.
  points[0] = -2;
  points[11] = -5;
  points[16] = -3;
  points[18] = -5;
  return { points, bar: { white: 0, black: 0 }, off: { white: 0, black: 0 } };
}

export function cloneBoard(board: Board): Board {
  return {
    points: board.points.slice(),
    bar: { ...board.bar },
    off: { ...board.off },
  };
}

/** Number of `color`'s checkers on point index `i`. */
export function countAt(board: Board, color: Color, i: number): number {
  const n = board.points[i];
  return color === 'white' ? Math.max(n, 0) : Math.max(-n, 0);
}

function sign(color: Color): number {
  return color === 'white' ? 1 : -1;
}

function isHomeIndex(color: Color, i: number): boolean {
  return color === 'white' ? i <= 5 : i >= 18;
}

export function allHome(board: Board, color: Color): boolean {
  if (board.bar[color] > 0) return false;
  for (let i = 0; i < 24; i++) {
    if (countAt(board, color, i) > 0 && !isHomeIndex(color, i)) return false;
  }
  return true;
}

/** Point index a checker entering from the bar lands on with `die`. */
export function entryIndex(color: Color, die: number): number {
  return color === 'white' ? 24 - die : die - 1;
}

/** Pip distance from point index `i` to bearing off, for `color`. */
export function pipDistance(color: Color, i: number): number {
  return color === 'white' ? i + 1 : 24 - i;
}

export function pipCount(board: Board, color: Color): number {
  let pips = board.bar[color] * 25;
  for (let i = 0; i < 24; i++) pips += countAt(board, color, i) * pipDistance(color, i);
  return pips;
}

/** The single move a checker on `from` makes with `die`, or null if it is illegal. */
function singleMove(board: Board, color: Color, from: number | 'bar', die: number): Move | null {
  const opp = opponent(color);
  if (from === 'bar') {
    if (board.bar[color] === 0) return null;
    const to = entryIndex(color, die);
    if (countAt(board, opp, to) >= 2) return null;
    return { from, to, die };
  }
  if (board.bar[color] > 0) return null;
  if (countAt(board, color, from) === 0) return null;
  const to = color === 'white' ? from - die : from + die;
  if (to >= 0 && to <= 23) {
    if (countAt(board, opp, to) >= 2) return null;
    return { from, to, die };
  }
  // Bearing off.
  if (!allHome(board, color)) return null;
  const distance = pipDistance(color, from);
  if (die === distance) return { from, to: 'off', die };
  // A larger die may bear off only from the highest occupied point.
  if (die > distance) {
    if (color === 'white') {
      for (let i = from + 1; i <= 5; i++) if (countAt(board, color, i) > 0) return null;
    } else {
      for (let i = from - 1; i >= 18; i--) if (countAt(board, color, i) > 0) return null;
    }
    return { from, to: 'off', die };
  }
  return null;
}

/** Every legal single-checker move using one die of value `die`. */
export function movesForDie(board: Board, color: Color, die: number): Move[] {
  if (board.bar[color] > 0) {
    const m = singleMove(board, color, 'bar', die);
    return m ? [m] : [];
  }
  const out: Move[] = [];
  for (let i = 0; i < 24; i++) {
    const m = singleMove(board, color, i, die);
    if (m) out.push(m);
  }
  return out;
}

export function applyMove(board: Board, color: Color, move: Move): Board {
  const next = cloneBoard(board);
  const s = sign(color);
  const opp = opponent(color);
  if (move.from === 'bar') next.bar[color] -= 1;
  else next.points[move.from] -= s;
  if (move.to === 'off') {
    next.off[color] += 1;
  } else {
    if (countAt(next, opp, move.to) === 1) {
      // Hit a blot: send it to the bar.
      next.points[move.to] = 0;
      next.bar[opp] += 1;
    }
    next.points[move.to] += s;
  }
  return next;
}

/** Expand a roll into the dice available to play (doubles play four times). */
export function diceToPlay(dice: number[]): number[] {
  return dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [dice[0], dice[1]];
}

function boardKey(board: Board, remaining: number[]): string {
  return `${board.points.join(',')}|${board.bar.white},${board.bar.black}|${board.off.white},${board.off.black}|${remaining
    .slice()
    .sort()
    .join('')}`;
}

function removeOne(dice: number[], die: number): number[] {
  const i = dice.indexOf(die);
  return i < 0 ? dice : [...dice.slice(0, i), ...dice.slice(i + 1)];
}

/** The largest number of dice that can be played from this position. */
export function maxPlayable(
  board: Board,
  color: Color,
  remaining: number[],
  memo: Map<string, number> = new Map(),
): number {
  if (remaining.length === 0) return 0;
  const key = boardKey(board, remaining);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;
  let best = 0;
  for (const die of new Set(remaining)) {
    for (const m of movesForDie(board, color, die)) {
      const depth = 1 + maxPlayable(applyMove(board, color, m), color, removeOne(remaining, die), memo);
      if (depth > best) best = depth;
      if (best === remaining.length) break;
    }
    if (best === remaining.length) break;
  }
  memo.set(key, best);
  return best;
}

export interface TurnProgress {
  board: Board;
  remaining: number[];
  played: Move[];
}

/** Replay `played` moves from the start of a turn. Throws if any move is illegal. */
export function replayTurn(start: Board, color: Color, dice: number[], played: Move[]): TurnProgress {
  const total = maxPlayable(start, color, diceToPlay(dice));
  let progress: TurnProgress = { board: start, remaining: diceToPlay(dice), played: [] };
  for (const move of played) {
    const legal = legalNextMoves(progress, color, dice, total);
    const match = legal.find((m) => sameMove(m, move));
    if (!match) throw new Error('Illegal move');
    progress = {
      board: applyMove(progress.board, color, match),
      remaining: removeOne(progress.remaining, match.die),
      played: [...progress.played, match],
    };
  }
  return progress;
}

export function sameMove(a: Move, b: Move): boolean {
  return a.from === b.from && a.to === b.to && a.die === b.die;
}

/**
 * Legal next single moves partway through a turn. A move is legal only if the
 * turn can still use the maximum number of dice after it, and when just one
 * die can be played the larger one must be used if possible.
 */
export function legalNextMoves(
  progress: TurnProgress,
  color: Color,
  dice: number[],
  total: number = maxPlayable(progress.board, color, progress.remaining),
): Move[] {
  const needed = total - progress.played.length;
  if (needed <= 0) return [];
  const memo = new Map<string, number>();
  let moves: Move[] = [];
  for (const die of new Set(progress.remaining)) {
    for (const m of movesForDie(progress.board, color, die)) {
      const after = applyMove(progress.board, color, m);
      if (1 + maxPlayable(after, color, removeOne(progress.remaining, die), memo) >= needed) moves.push(m);
    }
  }
  if (total === 1 && dice[0] !== dice[1]) {
    const high = Math.max(dice[0], dice[1]);
    if (moves.some((m) => m.die === high)) moves = moves.filter((m) => m.die === high);
  }
  return moves;
}

/** Scoring multiplier for a finished game where `winner` has borne everything off. */
export function resultType(board: Board, winner: Color): ResultType {
  const loser = opponent(winner);
  if (board.off[loser] > 0) return 'normal';
  if (board.bar[loser] > 0) return 'backgammon';
  for (let i = 0; i < 24; i++) {
    if (countAt(board, loser, i) > 0 && isHomeIndex(winner, i)) return 'backgammon';
  }
  return 'gammon';
}

const MULTIPLIER: Record<ResultType, number> = { normal: 1, gammon: 2, backgammon: 3 };

export function newGame(roll: Roller): GameState {
  let white = roll();
  let black = roll();
  while (white === black) {
    white = roll();
    black = roll();
  }
  const turn: Color = white > black ? 'white' : 'black';
  return {
    board: initialBoard(),
    turn,
    phase: 'moving',
    dice: [white, black],
    cube: { value: 1, owner: null },
    doubleOfferedBy: null,
    openingRoll: { white, black },
    lastTurn: null,
    turnNumber: 1,
    result: null,
  };
}

export function canDouble(state: GameState, color: Color): boolean {
  return (
    state.phase === 'rolling' &&
    state.turn === color &&
    (state.cube.owner === null || state.cube.owner === color) &&
    state.cube.value < MAX_CUBE
  );
}

export class GameError extends Error {}

function finish(state: GameState, winner: Color, reason: EndReason, type: ResultType, cubeValue: number): GameState {
  return {
    ...state,
    phase: 'finished',
    dice: null,
    doubleOfferedBy: null,
    result: { winner, reason, type, points: cubeValue * MULTIPLIER[type] },
  };
}

function passTurn(state: GameState, record: TurnRecord, board: Board): GameState {
  return {
    ...state,
    board,
    turn: opponent(state.turn),
    phase: 'rolling',
    dice: null,
    lastTurn: record,
    turnNumber: state.turnNumber + 1,
  };
}

/**
 * Apply an action by `actor` and return the new state. Throws GameError when
 * the action is not allowed. `roll` supplies dice for the roll action.
 */
export function applyAction(state: GameState, actor: Color, action: Action, roll: Roller): GameState {
  if (state.phase === 'finished') throw new GameError('The game is over');

  switch (action.type) {
    case 'resign': {
      const winner = opponent(actor);
      return finish(state, winner, 'resign', resultType(state.board, winner), state.cube.value);
    }

    case 'double': {
      if (!canDouble(state, actor)) throw new GameError('You cannot double now');
      return { ...state, phase: 'doubling', doubleOfferedBy: actor };
    }

    case 'take': {
      if (state.phase !== 'doubling' || state.doubleOfferedBy !== opponent(actor)) {
        throw new GameError('There is no double to take');
      }
      return {
        ...state,
        phase: 'rolling',
        doubleOfferedBy: null,
        cube: { value: state.cube.value * 2, owner: actor },
      };
    }

    case 'drop': {
      if (state.phase !== 'doubling' || state.doubleOfferedBy !== opponent(actor)) {
        throw new GameError('There is no double to drop');
      }
      return finish(state, opponent(actor), 'drop', 'normal', state.cube.value);
    }

    case 'roll': {
      if (state.phase !== 'rolling' || state.turn !== actor) throw new GameError('It is not your turn to roll');
      const dice = [roll(), roll()];
      if (maxPlayable(state.board, actor, diceToPlay(dice)) === 0) {
        // No legal moves: the turn passes automatically.
        return passTurn(state, { color: actor, dice, moves: [] }, state.board);
      }
      return { ...state, phase: 'moving', dice };
    }

    case 'move': {
      if (state.phase !== 'moving' || state.turn !== actor || !state.dice) {
        throw new GameError('It is not your turn to move');
      }
      if (!Array.isArray(action.moves)) throw new GameError('Invalid moves');
      const total = maxPlayable(state.board, actor, diceToPlay(state.dice));
      let progress: TurnProgress;
      try {
        progress = replayTurn(state.board, actor, state.dice, action.moves.map(normalizeMove));
      } catch {
        throw new GameError('Illegal move');
      }
      const record: TurnRecord = { color: actor, dice: state.dice, moves: progress.played };
      if (progress.board.off[actor] === CHECKERS_PER_SIDE) {
        return finish(
          { ...state, board: progress.board, lastTurn: record },
          actor,
          'bearoff',
          resultType(progress.board, actor),
          state.cube.value,
        );
      }
      if (progress.played.length !== total) throw new GameError('You must play as many dice as possible');
      return passTurn(state, record, progress.board);
    }

    default:
      throw new GameError('Unknown action');
  }
}

function normalizeMove(raw: unknown): Move {
  const m = raw as Record<string, unknown>;
  const from = m?.from === 'bar' ? 'bar' : Number(m?.from);
  const to = m?.to === 'off' ? 'off' : Number(m?.to);
  const die = Number(m?.die);
  if ((from !== 'bar' && !Number.isInteger(from)) || (to !== 'off' && !Number.isInteger(to)) || !Number.isInteger(die)) {
    throw new GameError('Invalid move');
  }
  return { from, to, die };
}

/** Moves available to the player right now, given partial moves already made this turn. */
export function availableMoves(state: GameState, color: Color, played: Move[]): { progress: TurnProgress; legal: Move[] } {
  if (state.phase !== 'moving' || state.turn !== color || !state.dice) {
    return { progress: { board: state.board, remaining: [], played: [] }, legal: [] };
  }
  const total = maxPlayable(state.board, color, diceToPlay(state.dice));
  const progress = replayTurn(state.board, color, state.dice, played);
  return { progress, legal: legalNextMoves(progress, color, state.dice, total) };
}
