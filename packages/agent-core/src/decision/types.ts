/**
 * Decision questions and answers — the Jev/SystemOne shape, shared by every backend.
 */

export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  /** Option id → description. */
  criteria: Record<string, string | null>;
}

export interface ScoreQuestion {
  type: "score";
  instructions: string;
  /** Ordered level descriptions, lowest first (index 0). */
  criteria: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface NoulAnswer {
  type: "noul";
  /** Probability the answer is yes. */
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: "score";
  /** Probability-weighted level; can land between levels. */
  score: number;
  confidence: number;
  legend: Record<string, unknown>;
  probabilities: Record<string, number>;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

export interface DecisionUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  contextWindow: number;
}

export interface DecideOptions {
  signal?: AbortSignal;
  /** Called once per backend call that reported token usage. */
  onUsage?: (usage: DecisionUsage) => void;
}

/** Jev question ids: letters, digits, '_', '.', '-' (max 100 chars). */
export const QUESTION_ID_RE = /^[A-Za-z0-9_.-]{1,100}$/;
export const MAX_QUESTIONS_PER_REQUEST = 64;
