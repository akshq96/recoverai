import { DECLINE_CATEGORY, type DeclineCategory } from "./constants";

// Razorpay's test mode can't be told "make this bank decline succeed on the
// 2nd retry" — real NACH/card-network retry outcomes aren't controllable
// from the merchant side even in test mode. To still produce a measurable
// "money recovered across a batch" result, outcomes are drawn from a
// documented probability model instead of faked as always-succeed.
//
// The model is deterministic per (chargeId, attemptNumber) via a seeded RNG,
// so re-running the same batch reproduces the same results — important for
// a demo you're going to record once and show to judges.
const RETRY_SUCCESS_PROBABILITY: Record<string, number[]> = {
  // index = attemptNumber - 1
  [DECLINE_CATEGORY.INSUFFICIENT_FUNDS]: [0.25, 0.4, 0.55],
  [DECLINE_CATEGORY.ISSUER_UNAVAILABLE]: [0.5, 0.75, 0.85],
};

// Probability a customer follows a reminder/payment-link and pays, per send.
const REMINDER_CONVERSION_PROBABILITY: Record<string, number> = {
  [DECLINE_CATEGORY.CARD_EXPIRED]: 0.4,
  [DECLINE_CATEGORY.MANDATE_REVOKED]: 0.3,
  [DECLINE_CATEGORY.INVALID_MANDATE]: 0.25,
};

function seededRandom(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(31, h) + seed.charCodeAt(i);
    h |= 0;
  }
  h = Math.imul(h ^ (h >>> 15), 1 | h);
  h ^= h + Math.imul(h ^ (h >>> 7), 61 | h);
  const n = ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  return n;
}

export function simulateAutoRetryOutcome(chargeId: string, category: DeclineCategory, attemptNumber: number): boolean {
  const table = RETRY_SUCCESS_PROBABILITY[category];
  if (!table) return false;
  const p = table[Math.min(attemptNumber - 1, table.length - 1)];
  return seededRandom(`${chargeId}:retry:${attemptNumber}`) < p;
}

export function simulateReminderOutcome(chargeId: string, category: DeclineCategory, sendCount: number): boolean {
  const p = REMINDER_CONVERSION_PROBABILITY[category];
  if (!p) return false;
  return seededRandom(`${chargeId}:reminder:${sendCount}`) < p;
}
