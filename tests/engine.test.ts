import { describe, expect, it } from 'vitest';
import {
  applyAction,
  availableMoves,
  Board,
  GameError,
  GameState,
  initialBoard,
  legalNextMoves,
  maxPlayable,
  diceToPlay,
  newGame,
  pipCount,
  Roller,
} from '../src/shared/engine';

function emptyBoard(): Board {
  return { points: new Array(24).fill(0), bar: { white: 0, black: 0 }, off: { white: 0, black: 0 } };
}

function seq(...values: number[]): Roller {
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error('ran out of dice');
    return values[i++];
  };
}

function stateWith(board: Board, patch: Partial<GameState> = {}): GameState {
  return {
    ...newGame(seq(6, 1)),
    board,
    ...patch,
  };
}

function firstMoves(board: Board, color: 'white' | 'black', dice: number[]) {
  return legalNextMoves({ board, remaining: diceToPlay(dice), played: [] }, color, dice);
}

describe('setup', () => {
  it('places 15 checkers each with equal pip counts', () => {
    const b = initialBoard();
    const white = b.points.filter((n) => n > 0).reduce((a, n) => a + n, 0);
    const black = b.points.filter((n) => n < 0).reduce((a, n) => a - n, 0);
    expect(white).toBe(15);
    expect(black).toBe(15);
    expect(pipCount(b, 'white')).toBe(167);
    expect(pipCount(b, 'black')).toBe(167);
  });

  it('opening roll re-rolls ties and the higher die starts with both dice', () => {
    const g = newGame(seq(3, 3, 2, 5));
    expect(g.turn).toBe('black');
    expect(g.dice).toEqual([2, 5]);
    expect(g.phase).toBe('moving');
  });
});

describe('moves', () => {
  it('blocks landing on a point held by two opposing checkers', () => {
    const b = emptyBoard();
    b.points[10] = 1;
    b.points[7] = -2;
    b.points[23] = 14;
    const moves = firstMoves(b, 'white', [3, 1]);
    expect(moves.some((m) => m.from === 10 && m.to === 7)).toBe(false);
  });

  it('hits a blot and sends it to the bar', () => {
    const b = emptyBoard();
    b.points[10] = 1;
    b.points[7] = -1;
    b.points[0] = -14;
    b.points[23] = 14;
    const g = stateWith(b, { turn: 'white', dice: [3, 1], phase: 'moving' });
    const next = applyAction(g, 'white', { type: 'move', moves: [{ from: 10, to: 7, die: 3 }, { from: 7, to: 6, die: 1 }] }, seq());
    expect(next.board.bar.black).toBe(1);
    expect(next.board.points[6]).toBe(1);
    expect(next.turn).toBe('black');
  });

  it('forces entering from the bar before other moves', () => {
    const b = emptyBoard();
    b.bar.white = 1;
    b.points[5] = 14;
    const moves = firstMoves(b, 'white', [3, 5]);
    expect(moves.every((m) => m.from === 'bar')).toBe(true);
    expect(moves.map((m) => m.to).sort()).toEqual([19, 21]);
  });

  it('must use both dice when possible', () => {
    // White checker on 13 (index 12) could play 6 to index 6 then 1 is blocked,
    // or 1 then 6. Only the order that allows both dice is legal.
    const b = emptyBoard();
    b.points[12] = 1;
    b.points[6] = -2; // blocks 12-6
    b.points[0] = -13;
    b.off.white = 14;
    const moves = firstMoves(b, 'white', [6, 1]);
    expect(moves).toEqual([{ from: 12, to: 11, die: 1 }]);
  });

  it('must play the larger die when only one die can be played', () => {
    const b = emptyBoard();
    b.points[12] = 1;
    b.points[7] = -2; // 12 -> 7 (5) blocked
    b.points[9] = -2; // 12 -> 9 (3) blocked... then only one of 12->10 (2) or 12->6 (6)
    b.points[4] = -2; // 10 -> 4 (6) blocked, 6 -> 4 (2) blocked
    b.points[0] = -9;
    b.off.white = 14;
    expect(maxPlayable(b, 'white', diceToPlay([6, 2]))).toBe(1);
    const moves = firstMoves(b, 'white', [6, 2]);
    expect(moves).toEqual([{ from: 12, to: 6, die: 6 }]);
  });

  it('plays doubles four times', () => {
    const g = stateWith(initialBoard(), { turn: 'white', dice: [2, 2], phase: 'moving' });
    const moves = [
      { from: 5, to: 3, die: 2 },
      { from: 5, to: 3, die: 2 },
      { from: 7, to: 5, die: 2 },
      { from: 7, to: 5, die: 2 },
    ];
    const next = applyAction(g, 'white', { type: 'move', moves }, seq());
    expect(next.board.points[3]).toBe(2);
    expect(next.board.points[7]).toBe(1);
  });

  it('rejects an incomplete turn when more dice could be played', () => {
    const g = stateWith(initialBoard(), { turn: 'white', dice: [3, 1], phase: 'moving' });
    expect(() =>
      applyAction(g, 'white', { type: 'move', moves: [{ from: 7, to: 4, die: 3 }] }, seq()),
    ).toThrow(GameError);
  });

  it('rejects moves by the player who is not on turn', () => {
    const g = stateWith(initialBoard(), { turn: 'white', dice: [3, 1], phase: 'moving' });
    expect(() => applyAction(g, 'black', { type: 'move', moves: [] }, seq())).toThrow(GameError);
  });

  it('passes the turn automatically when a roll has no legal moves', () => {
    const b = emptyBoard();
    b.bar.white = 1;
    for (const i of [18, 19, 20, 21, 22, 23]) b.points[i] = -2;
    b.points[0] = -3;
    b.points[5] = 14;
    const g = stateWith(b, { turn: 'white', phase: 'rolling', dice: null });
    const next = applyAction(g, 'white', { type: 'roll' }, seq(4, 2));
    expect(next.turn).toBe('black');
    expect(next.phase).toBe('rolling');
    expect(next.lastTurn).toEqual({ color: 'white', dice: [4, 2], moves: [] });
  });
});

describe('bearing off', () => {
  it('bears off exactly and with a larger die from the highest point', () => {
    const b = emptyBoard();
    b.points[3] = 2; // white 4-point
    b.points[1] = 1;
    b.off.white = 12;
    b.points[20] = -15;
    const moves = firstMoves(b, 'white', [6, 2]);
    expect(moves).toContainEqual({ from: 3, to: 'off', die: 6 });
    expect(moves).toContainEqual({ from: 1, to: 'off', die: 2 });
    expect(moves).not.toContainEqual({ from: 1, to: 'off', die: 6 });
  });

  it('cannot bear off with a checker outside home', () => {
    const b = emptyBoard();
    b.points[6] = 1;
    b.points[0] = 14;
    b.points[20] = -15;
    const moves = firstMoves(b, 'white', [1, 2]);
    expect(moves.some((m) => m.to === 'off')).toBe(false);
  });

  it('scores a gammon when the loser has borne off nothing', () => {
    const b = emptyBoard();
    b.points[0] = 1;
    b.off.white = 14;
    b.points[12] = -15;
    const g = stateWith(b, { turn: 'white', dice: [1, 2], phase: 'moving' });
    const next = applyAction(g, 'white', { type: 'move', moves: [{ from: 0, to: 'off', die: 2 }] }, seq());
    expect(next.phase).toBe('finished');
    expect(next.result).toEqual({ winner: 'white', reason: 'bearoff', type: 'gammon', points: 2 });
  });

  it('scores a backgammon when the loser still has a checker in the winner home board', () => {
    const b = emptyBoard();
    b.points[0] = 1;
    b.off.white = 14;
    b.points[2] = -1;
    b.points[12] = -14;
    const g = stateWith(b, { turn: 'white', dice: [1, 2], phase: 'moving', cube: { value: 2, owner: 'black' } });
    const next = applyAction(g, 'white', { type: 'move', moves: [{ from: 0, to: 'off', die: 2 }] }, seq());
    expect(next.result?.type).toBe('backgammon');
    expect(next.result?.points).toBe(6);
  });
});

describe('doubling cube', () => {
  it('offer, take, then only the taker may redouble', () => {
    let g = stateWith(initialBoard(), { turn: 'white', phase: 'rolling', dice: null });
    g = applyAction(g, 'white', { type: 'double' }, seq());
    expect(g.phase).toBe('doubling');
    expect(() => applyAction(g, 'white', { type: 'take' }, seq())).toThrow(GameError);
    g = applyAction(g, 'black', { type: 'take' }, seq());
    expect(g.cube).toEqual({ value: 2, owner: 'black' });
    expect(g.phase).toBe('rolling');
    expect(() => applyAction(g, 'white', { type: 'double' }, seq())).toThrow(GameError);
  });

  it('dropping a double loses at the current cube value', () => {
    let g = stateWith(initialBoard(), { turn: 'white', phase: 'rolling', dice: null, cube: { value: 2, owner: 'white' } });
    g = applyAction(g, 'white', { type: 'double' }, seq());
    g = applyAction(g, 'black', { type: 'drop' }, seq());
    expect(g.result).toEqual({ winner: 'white', reason: 'drop', type: 'normal', points: 2 });
  });
});

describe('availableMoves', () => {
  it('narrows choices as moves are made and ends when dice are used', () => {
    const g = stateWith(initialBoard(), { turn: 'white', dice: [6, 5], phase: 'moving' });
    const first = availableMoves(g, 'white', []);
    expect(first.legal.length).toBeGreaterThan(0);
    const after = availableMoves(g, 'white', [{ from: 23, to: 17, die: 6 }]);
    expect(after.legal.every((m) => m.die === 5)).toBe(true);
    const done = availableMoves(g, 'white', [
      { from: 23, to: 17, die: 6 },
      { from: 17, to: 12, die: 5 },
    ]);
    expect(done.legal).toEqual([]);
  });
});
