export const CHARGE_STATUS = {
  NEW: "NEW",
  RETRY_SCHEDULED: "RETRY_SCHEDULED",
  RETRY_ATTEMPTED: "RETRY_ATTEMPTED",
  // A real Razorpay payment link is outstanding for this charge. Distinct
  // from RETRY_SCHEDULED (which covers auto-retry backoff and *simulated*
  // reminder follow-ups): a charge in this state can ONLY be resolved by the
  // payment_link.paid webhook or by the compliance window expiring — never
  // by the demo simulator.
  WAITING_FOR_PAYMENT: "WAITING_FOR_PAYMENT",
  RECOVERED: "RECOVERED",
  ESCALATED: "ESCALATED",
  STOPPED: "STOPPED",
} as const;
export type ChargeStatus = (typeof CHARGE_STATUS)[keyof typeof CHARGE_STATUS];

export const ACTION_TYPE = {
  AUTO_RETRY: "AUTO_RETRY",
  SEND_REMINDER: "SEND_REMINDER",
  OFFER_ALT_METHOD: "OFFER_ALT_METHOD",
  ESCALATE_HUMAN: "ESCALATE_HUMAN",
  STOP: "STOP",
} as const;
export type ActionType = (typeof ACTION_TYPE)[keyof typeof ACTION_TYPE];

export const DECIDED_BY = {
  RULE: "RULE",
  LLM: "LLM",
  HUMAN: "HUMAN",
} as const;
export type DecidedBy = (typeof DECIDED_BY)[keyof typeof DECIDED_BY];

export const ACTOR_TYPE = {
  SYSTEM: "SYSTEM",
  RULE_ENGINE: "RULE_ENGINE",
  LLM: "LLM",
  HUMAN: "HUMAN",
  RAZORPAY_WEBHOOK: "RAZORPAY_WEBHOOK",
} as const;
export type ActorType = (typeof ACTOR_TYPE)[keyof typeof ACTOR_TYPE];

// A charge is only ever RECOVERED through one of these two paths, and the
// distinction is never hidden from the UI or folded into a single total:
//   VERIFIED  — a real Razorpay payment_link.paid webhook confirmed the money moved.
//   SIMULATED — the outcome came from the documented probability model
//               (simulate-outcome.ts), used because real bank/NPCI retry
//               outcomes aren't controllable from Razorpay test mode.
export const RECOVERY_MODE = {
  VERIFIED: "VERIFIED",
  SIMULATED: "SIMULATED",
} as const;
export type RecoveryMode = (typeof RECOVERY_MODE)[keyof typeof RECOVERY_MODE];

export const DECLINE_CATEGORY = {
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  CARD_EXPIRED: "CARD_EXPIRED",
  MANDATE_REVOKED: "MANDATE_REVOKED",
  ISSUER_UNAVAILABLE: "ISSUER_UNAVAILABLE",
  INVALID_MANDATE: "INVALID_MANDATE",
  UNKNOWN: "UNKNOWN",
} as const;
export type DeclineCategory = (typeof DECLINE_CATEGORY)[keyof typeof DECLINE_CATEGORY];

// Policy engine caps — the "bounded and gated" part of the bar.
export const MAX_RETRIES = 3;
export const RETRY_WINDOW_DAYS = 7;
// Any action touching a charge above this amount requires human approval
// before it executes, regardless of what the rule engine or LLM decided.
export const HUMAN_APPROVAL_THRESHOLD_PAISE = 500000; // ₹5,000
