// Shapes of the JSON the server returns, shared with the browser client.
import type { Action, Color, EndReason, GameState, Move } from './engine.js';

export interface PlayerInfo {
  id: number;
  username: string;
}

export type GameStatus = 'waiting' | 'active' | 'finished';

export interface GameView {
  id: string;
  status: GameStatus;
  version: number;
  you: Color | null;
  players: { white: PlayerInfo | null; black: PlayerInfo | null };
  createdBy: number;
  inviteCode: string | null;
  state: GameState | null;
  updatedAt: string;
}

export interface GameSummary {
  id: string;
  status: GameStatus;
  you: Color | null;
  opponent: PlayerInfo | null;
  yourTurn: boolean;
  inviteCode: string | null;
  result: { won: boolean; points: number; reason: EndReason } | null;
  updatedAt: string;
}

/** Live notice that a game changed; browsers refetch the game when they get one. */
export interface GameEvent {
  id: string;
  version: number;
  /** What changed it, when a player acted (absent when a game starts). */
  action?: { type: Action['type']; by: Color; /** For a move: the checkers it moved, in order. */ moves?: Move[] };
}


/** A started game as listed on the matches screen, for anyone to watch. */
export interface MatchSummary {
  id: string;
  status: 'active' | 'finished';
  players: { white: PlayerInfo | null; black: PlayerInfo | null };
  /** Who the game is waiting on, or null once it's over. */
  turn: Color | null;
  cube: number;
  pips: { white: number; black: number } | null;
  result: { winner: Color; points: number; reason: EndReason } | null;
  updatedAt: string;
}
