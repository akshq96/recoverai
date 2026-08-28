import { DECLINE_CATEGORY, type DeclineCategory } from "./constants";

// Maps Razorpay's error/decline codes to a recovery category. This table is
// the deterministic path: known codes never touch the LLM, so their handling
// stays auditable and cheap. Only codes that fall through to "UNKNOWN" are
// handed to the LLM classifier — see src/lib/llm.ts.
//
// Source shapes match Razorpay's payment.failed webhook payload
// (error_code / error_reason on payments.entity).
const DECLINE_CODE_MAP: Record<string, DeclineCategory> = {
  insufficient_funds: DECLINE_CATEGORY.INSUFFICIENT_FUNDS,
  balance_insufficient: DECLINE_CATEGORY.INSUFFICIENT_FUNDS,

  card_expired: DECLINE_CATEGORY.CARD_EXPIRED,
  expired_card: DECLINE_CATEGORY.CARD_EXPIRED,

  mandate_revoked: DECLINE_CATEGORY.MANDATE_REVOKED,
  mandate_cancelled: DECLINE_CATEGORY.MANDATE_REVOKED,
  authorization_revoked: DECLINE_CATEGORY.MANDATE_REVOKED,

  issuer_unavailable: DECLINE_CATEGORY.ISSUER_UNAVAILABLE,
  gateway_error: DECLINE_CATEGORY.ISSUER_UNAVAILABLE,
  bank_technical_error: DECLINE_CATEGORY.ISSUER_UNAVAILABLE,
  issuer_down: DECLINE_CATEGORY.ISSUER_UNAVAILABLE,

  invalid_mandate: DECLINE_CATEGORY.INVALID_MANDATE,
  mandate_not_found: DECLINE_CATEGORY.INVALID_MANDATE,
};

export function classifyDeclineCode(declineCode: string): {
  category: DeclineCategory;
  decidedBy: "RULE" | "LLM";
} {
  const normalized = declineCode.trim().toLowerCase();
  const mapped = DECLINE_CODE_MAP[normalized];
  if (mapped) {
    return { category: mapped, decidedBy: "RULE" };
  }
  return { category: DECLINE_CATEGORY.UNKNOWN, decidedBy: "LLM" };
}

// Category -> recovery levers that are *allowed* for that category. The
// policy engine picks among these; it never invents an action outside this
// table, which is what keeps the agent bounded.
export const ALLOWED_ACTIONS_BY_CATEGORY: Record<DeclineCategory, string[]> = {
  [DECLINE_CATEGORY.INSUFFICIENT_FUNDS]: ["AUTO_RETRY", "SEND_REMINDER"],
  [DECLINE_CATEGORY.CARD_EXPIRED]: ["SEND_REMINDER", "OFFER_ALT_METHOD"],
  [DECLINE_CATEGORY.MANDATE_REVOKED]: ["SEND_REMINDER", "OFFER_ALT_METHOD", "ESCALATE_HUMAN"],
  [DECLINE_CATEGORY.ISSUER_UNAVAILABLE]: ["AUTO_RETRY"],
  [DECLINE_CATEGORY.INVALID_MANDATE]: ["OFFER_ALT_METHOD", "ESCALATE_HUMAN"],
  [DECLINE_CATEGORY.UNKNOWN]: ["ESCALATE_HUMAN"],
};
