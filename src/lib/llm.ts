import Anthropic from "@anthropic-ai/sdk";
import { DECLINE_CATEGORY, type DeclineCategory } from "./constants";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

// Cheap/fast model for the narrow classification task; a stronger model for
// customer-facing copy and the recovery recommendation. Both overridable via
// env for local experimentation.
const CLASSIFY_MODEL = process.env.ANTHROPIC_CLASSIFY_MODEL ?? "claude-haiku-4-5-20251001";
const DRAFT_MODEL = process.env.ANTHROPIC_DRAFT_MODEL ?? "claude-sonnet-5";

const KNOWN_CATEGORIES = Object.values(DECLINE_CATEGORY).filter((c) => c !== DECLINE_CATEGORY.UNKNOWN);

// Only called when the deterministic decline-code table (decline-classifier.ts)
// doesn't recognize the code. This is the one place classification is allowed
// to be probabilistic, and the result + raw reasoning is written to the audit
// log so a human can see exactly why the LLM chose a category.
export async function classifyUnknownDecline(
  declineCode: string,
  declineReasonRaw: string,
): Promise<{ category: DeclineCategory; reasoning: string }> {
  if (!hasApiKey()) {
    return {
      category: DECLINE_CATEGORY.UNKNOWN,
      reasoning: "ANTHROPIC_API_KEY not configured — defaulted to UNKNOWN (would call the LLM classifier otherwise).",
    };
  }

  try {
    const message = await getClient().messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 300,
      system:
        "You classify Razorpay subscription payment failures into a fixed set of categories. " +
        "Respond with strict JSON only: {\"category\": one of " +
        JSON.stringify(KNOWN_CATEGORIES) +
        ', "reasoning": "one sentence"}. If nothing fits, use "UNKNOWN".',
      messages: [
        {
          role: "user",
          content: `decline_code: ${declineCode}\ndecline_reason: ${declineReasonRaw}`,
        },
      ],
    });

    const text = message.content.find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    const category = KNOWN_CATEGORIES.includes(parsed.category) ? parsed.category : DECLINE_CATEGORY.UNKNOWN;
    return { category, reasoning: parsed.reasoning ?? "LLM returned no reasoning." };
  } catch (err) {
    // Anthropic being down/rate-limited/returning malformed JSON must never
    // take the recovery pipeline down with it — fall back to UNKNOWN, which
    // the policy engine routes straight to human escalation.
    return {
      category: DECLINE_CATEGORY.UNKNOWN,
      reasoning: `LLM classification failed (${err instanceof Error ? err.message : "unknown error"}); defaulted to UNKNOWN.`,
    };
  }
}

export type RecoveryRecommendation = {
  recommendedAction: string;
  confidence: number; // 0..1
  reasoning: string;
  source: "LLM" | "FALLBACK";
};

// This is the ONLY place the LLM has any say in what happens next, and even
// here it only recommends — it never executes. The deterministic policy
// engine (policy-engine.ts) validates the recommendation against the
// category's allowed-action set, applies the hard safety caps (retries,
// window, amount threshold), and only then may execute it. If the LLM is
// unavailable or recommends something outside policy, the engine falls back
// to the deterministic pickActionType() with confidence 0 — the pipeline
// keeps working either way.
export async function recommendRecoveryAction(params: {
  category: DeclineCategory;
  attemptNumber: number;
  amountPaise: number;
  declineReasonRaw: string;
  allowedActions: string[];
}): Promise<RecoveryRecommendation> {
  if (!hasApiKey()) {
    return {
      recommendedAction: params.allowedActions[0],
      confidence: 0,
      reasoning: "ANTHROPIC_API_KEY not configured — used the deterministic default action for this category.",
      source: "FALLBACK",
    };
  }

  try {
    const rupees = (params.amountPaise / 100).toFixed(2);
    const message = await getClient().messages.create({
      model: DRAFT_MODEL,
      max_tokens: 300,
      system:
        "You recommend a recovery action for a failed Razorpay subscription payment. You MUST pick exactly one " +
        `action from this list: ${JSON.stringify(params.allowedActions)}. Respond with strict JSON only: ` +
        '{"recommendedAction": one of the allowed actions, "confidence": number between 0 and 1, "reasoning": "one or two sentences"}.',
      messages: [
        {
          role: "user",
          content:
            `Decline category: ${params.category}\nRaw reason: ${params.declineReasonRaw}\n` +
            `Attempt number: ${params.attemptNumber}\nAmount at risk: ₹${rupees}\n` +
            `Allowed actions: ${params.allowedActions.join(", ")}`,
        },
      ],
    });

    const text = message.content.find((b) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    if (!params.allowedActions.includes(parsed.recommendedAction)) {
      // The LLM went out of policy — never let that reach execution.
      return {
        recommendedAction: params.allowedActions[0],
        confidence: 0,
        reasoning: `LLM recommended an out-of-policy action ("${parsed.recommendedAction}"); overridden with the deterministic default.`,
        source: "FALLBACK",
      };
    }
    const confidence = typeof parsed.confidence === "number" ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5;
    return {
      recommendedAction: parsed.recommendedAction,
      confidence,
      reasoning: parsed.reasoning ?? "LLM returned no reasoning.",
      source: "LLM",
    };
  } catch (err) {
    return {
      recommendedAction: params.allowedActions[0],
      confidence: 0,
      reasoning: `LLM recommendation failed (${err instanceof Error ? err.message : "unknown error"}); used the deterministic default action.`,
      source: "FALLBACK",
    };
  }
}

// Drafts the copy for a SEND_REMINDER / OFFER_ALT_METHOD action. The policy
// engine decides *whether* and *when* to send — this only decides *what it says*.
export async function draftRecoveryMessage(params: {
  customerName: string;
  planName: string;
  amountPaise: number;
  category: DeclineCategory;
  attemptNumber: number;
  paymentLinkUrl?: string;
}): Promise<string> {
  const rupees = (params.amountPaise / 100).toFixed(2);
  const fallback =
    `Hi ${params.customerName}, your payment of ₹${rupees} for ${params.planName} didn't go through. ` +
    (params.paymentLinkUrl ? `Please complete it here: ${params.paymentLinkUrl}` : "Please update your payment method to continue.");

  if (!hasApiKey()) return fallback;

  try {
    const message = await getClient().messages.create({
      model: DRAFT_MODEL,
      max_tokens: 300,
      system:
        "You write short, warm, non-pushy SMS/email copy (under 400 characters) asking a customer to fix a " +
        "failed subscription payment. Never sound threatening. State the amount and plan plainly. " +
        "If a payment link is given, include it verbatim. No subject line, no markdown, plain text only.",
      messages: [
        {
          role: "user",
          content:
            `Customer: ${params.customerName}\nPlan: ${params.planName}\nAmount: ₹${rupees}\n` +
            `Failure category: ${params.category}\nAttempt number: ${params.attemptNumber}\n` +
            (params.paymentLinkUrl ? `Payment link: ${params.paymentLinkUrl}\n` : ""),
        },
      ],
    });

    return message.content.find((b) => b.type === "text")?.text?.trim() || fallback;
  } catch {
    return fallback;
  }
}
