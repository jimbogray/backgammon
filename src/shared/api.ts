// Shapes of the JSON the server returns, shared with the browser client.
import type { Color, EndReason, GameState } from './engine.js';

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
