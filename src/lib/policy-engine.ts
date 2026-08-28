import { prisma } from "./prisma";
import { getSimTime } from "./sim-clock";
import {
  CHARGE_STATUS,
  DECLINE_CATEGORY,
  RECOVERY_MODE,
  MAX_RETRIES,
  RETRY_WINDOW_DAYS,
  HUMAN_APPROVAL_THRESHOLD_PAISE,
  type DeclineCategory,
} from "./constants";
import { classifyDeclineCode, ALLOWED_ACTIONS_BY_CATEGORY } from "./decline-classifier";
import { classifyUnknownDecline, draftRecoveryMessage, recommendRecoveryAction } from "./llm";
import { createRecoveryPaymentLink } from "./razorpay";
import { simulateAutoRetryOutcome, simulateReminderOutcome } from "./simulate-outcome";

const DAY_MS = 24 * 60 * 60 * 1000;
// Backoff / cooldown between attempts — also doubles as the minimum gap
// enforced between recovery attempts on the same charge (no duplicate
// attempts can fire because a charge only re-enters the `due` query once
// its nextRetryAt has passed).
const RETRY_BACKOFF_DAYS = [1, 2, 4]; // indexed by attemptNumber - 1
const REMINDER_FOLLOWUP_DAYS = 2;

const ACTIONABLE_STATUSES: string[] = [CHARGE_STATUS.NEW, CHARGE_STATUS.RETRY_SCHEDULED, CHARGE_STATUS.WAITING_FOR_PAYMENT];

async function logAudit(failedChargeId: string, actorType: string, action: string, detail: unknown) {
  await prisma.auditLog.create({
    data: { failedChargeId, actorType, action, detail: JSON.stringify(detail) },
  });
}

async function markRecovered(
  chargeId: string,
  subscriptionId: string,
  recoveredAt: Date,
  recoveryMode: "SIMULATED" | "VERIFIED",
  note: string,
  razorpayPaymentId?: string,
) {
  const updated = await prisma.failedCharge.update({
    where: { id: chargeId },
    data: {
      status: CHARGE_STATUS.RECOVERED,
      recoveredAt,
      recoveryMode,
      razorpayPaymentId: razorpayPaymentId ?? undefined,
      pendingPaymentLinkId: null,
      pendingPaymentLinkIsReal: false,
    },
  });
  await prisma.subscription.update({ where: { id: subscriptionId }, data: { status: "active" } });
  await logAudit(chargeId, recoveryMode === "VERIFIED" ? "RAZORPAY_WEBHOOK" : "SYSTEM", "recovered", {
    note,
    recoveryMode,
    amountPaise: updated.amountPaise,
  });
}

// Called exclusively by the Razorpay webhook handler once a payment_link.paid
// event is verified — this is the ONLY code path allowed to produce a
// VERIFIED recovery. Idempotent: a charge that's already RECOVERED is left
// alone (defends against the webhook firing twice for the same link even if
// the outer WebhookEvent ledger somehow missed it).
export async function markVerifiedRecovery(chargeId: string, razorpayPaymentId: string) {
  const charge = await prisma.failedCharge.findUnique({ where: { id: chargeId } });
  if (!charge) return { ok: false, reason: "charge not found" as const };
  // Idempotent: a charge already RECOVERED is left exactly alone — this is
  // what makes a duplicate/retried payment_link.paid webhook a safe no-op
  // even if the outer WebhookEvent ledger somehow let it through twice.
  if (charge.status === CHARGE_STATUS.RECOVERED) return { ok: true, reason: "already recovered" as const };

  // BUG FIX: capture the payment-link id BEFORE markRecovered() clears
  // FailedCharge.pendingPaymentLinkId — this is the only join key back to
  // the specific RecoveryAction that created the link, so it has to be read
  // off this pre-mutation snapshot, not re-derived afterwards.
  const paymentLinkId = charge.pendingPaymentLinkId;

  if (paymentLinkId) {
    const openAction = await prisma.recoveryAction.findFirst({
      where: { failedChargeId: charge.id, razorpayPaymentLinkId: paymentLinkId, verifiedAt: null },
      orderBy: { createdAt: "desc" },
    });
    // Idempotent at the action level too: verifiedAt: null above means an
    // action already marked verified by a prior delivery of this same event
    // is never matched (and therefore never re-updated) again.
    if (openAction) {
      await prisma.recoveryAction.update({
        where: { id: openAction.id },
        data: { outcome: "paid (verified via webhook)", verifiedAt: new Date(), razorpayPaymentId },
      });
    }
  }

  await markRecovered(
    charge.id,
    charge.subscriptionId,
    new Date(),
    RECOVERY_MODE.VERIFIED,
    "Customer paid via Razorpay payment link — confirmed by payment_link.paid webhook.",
    razorpayPaymentId,
  );

  return { ok: true, reason: "recovered" as const };
}

async function stopCharge(chargeId: string, reason: string) {
  await prisma.failedCharge.update({
    where: { id: chargeId },
    data: { status: CHARGE_STATUS.STOPPED, stoppedReason: reason, pendingPaymentLinkId: null, pendingPaymentLinkIsReal: false },
  });
  await logAudit(chargeId, "RULE_ENGINE", "stopped", { reason });
}

async function escalate(chargeId: string, reasoning: string) {
  await prisma.failedCharge.update({
    where: { id: chargeId },
    data: { status: CHARGE_STATUS.ESCALATED, pendingPaymentLinkId: null, pendingPaymentLinkIsReal: false },
  });
  await prisma.recoveryAction.create({
    data: {
      failedChargeId: chargeId,
      type: "ESCALATE_HUMAN",
      decidedBy: "RULE",
      reasoning,
      executedAt: new Date(),
      outcome: "escalated to human agent",
    },
  });
  await logAudit(chargeId, "RULE_ENGINE", "escalated", { reasoning });
}

function deterministicActionType(category: DeclineCategory, attemptNumber: number): string {
  switch (category) {
    case DECLINE_CATEGORY.INSUFFICIENT_FUNDS:
    case DECLINE_CATEGORY.ISSUER_UNAVAILABLE:
      return "AUTO_RETRY";
    case DECLINE_CATEGORY.CARD_EXPIRED:
    case DECLINE_CATEGORY.MANDATE_REVOKED:
    case DECLINE_CATEGORY.INVALID_MANDATE:
      if (attemptNumber === 1) return "SEND_REMINDER";
      if (attemptNumber === 2) return "OFFER_ALT_METHOD";
      return "ESCALATE_HUMAN";
    default:
      return "ESCALATE_HUMAN";
  }
}

async function executeAutoRetry(actionId: string, chargeId: string, subscriptionId: string, category: DeclineCategory, attemptNumber: number, simNow: Date) {
  // Auto-retry has no Razorpay confirmation path (see razorpay.ts note) — its
  // outcome can only ever be SIMULATED.
  const success = simulateAutoRetryOutcome(chargeId, category, attemptNumber);
  if (success) {
    await markRecovered(chargeId, subscriptionId, simNow, RECOVERY_MODE.SIMULATED, `Auto-retry succeeded on attempt ${attemptNumber} (simulated outcome).`);
  } else {
    const backoffDays = RETRY_BACKOFF_DAYS[Math.min(attemptNumber - 1, RETRY_BACKOFF_DAYS.length - 1)];
    const nextRetryAt = new Date(simNow.getTime() + backoffDays * DAY_MS);
    await prisma.failedCharge.update({
      where: { id: chargeId },
      data: { attemptNumber: { increment: 1 }, status: CHARGE_STATUS.RETRY_SCHEDULED, nextRetryAt },
    });
    await logAudit(chargeId, "SYSTEM", "retry_failed", { attemptNumber, nextRetryAt });
  }
  await prisma.recoveryAction.update({
    where: { id: actionId },
    data: { executedAt: simNow, outcome: success ? "success (simulated)" : "failed" },
  });
}

async function executeReminder(
  actionId: string,
  chargeId: string,
  category: DeclineCategory,
  attemptNumber: number,
  actionType: "SEND_REMINDER" | "OFFER_ALT_METHOD",
  simNow: Date,
) {
  const charge = await prisma.failedCharge.findUniqueOrThrow({
    where: { id: chargeId },
    include: { subscription: { include: { customer: true } } },
  });
  const { subscription } = charge;
  const { customer } = subscription;

  const link = await createRecoveryPaymentLink({
    amountPaise: charge.amountPaise,
    customerName: customer.name,
    customerEmail: customer.email,
    customerPhone: customer.phone,
    description: `${subscription.planName} — payment recovery`,
  });
  const isReal = !link.mocked && !!link.id;

  const messageText = await draftRecoveryMessage({
    customerName: customer.name,
    planName: subscription.planName,
    amountPaise: charge.amountPaise,
    category,
    attemptNumber,
    paymentLinkUrl: link.url ?? undefined,
  });

  await logAudit(chargeId, "SYSTEM", "message_sent", {
    actionType,
    channel: "email (simulated send)",
    paymentLink: link.url,
    paymentLinkIsReal: isReal,
    paymentLinkError: link.error,
    message: messageText,
  });

  // A REAL Razorpay link moves the charge to WAITING_FOR_PAYMENT, which the
  // simulator is never allowed to touch (see processCharge below) — only the
  // payment_link.paid webhook, or the compliance window expiring, can move
  // it forward from here. A mocked link (no keys / API failure) stays on the
  // existing RETRY_SCHEDULED path, where the demo simulator is explicitly
  // allowed to resolve it.
  const nextRetryAt = new Date(simNow.getTime() + REMINDER_FOLLOWUP_DAYS * DAY_MS);
  await prisma.failedCharge.update({
    where: { id: chargeId },
    data: {
      attemptNumber: { increment: 1 },
      status: isReal ? CHARGE_STATUS.WAITING_FOR_PAYMENT : CHARGE_STATUS.RETRY_SCHEDULED,
      nextRetryAt,
      pendingPaymentLinkId: link.id ?? undefined,
      pendingPaymentLinkIsReal: isReal,
    },
  });
  await prisma.recoveryAction.update({
    where: { id: actionId },
    data: {
      executedAt: simNow,
      outcome: isReal ? "sent, awaiting payment (real Razorpay link)" : "sent, awaiting response (simulated — no Razorpay keys configured)",
      razorpayPaymentLinkId: link.id ?? undefined,
    },
  });
}

async function executeAction(action: { id: string; type: string }, chargeId: string, simNow: Date) {
  const charge = await prisma.failedCharge.findUniqueOrThrow({ where: { id: chargeId } });
  const category = charge.category as DeclineCategory;

  if (action.type === "AUTO_RETRY") {
    await executeAutoRetry(action.id, chargeId, charge.subscriptionId, category, charge.attemptNumber, simNow);
  } else if (action.type === "SEND_REMINDER" || action.type === "OFFER_ALT_METHOD") {
    await executeReminder(action.id, chargeId, category, charge.attemptNumber, action.type, simNow);
  }
}

async function processCharge(chargeId: string, simNow: Date) {
  const charge = await prisma.failedCharge.findUniqueOrThrow({ where: { id: chargeId } });

  // Defense in depth: only these statuses are ever actionable. (A VERIFIED
  // recovery arriving via webhook mid-batch, for instance, must never be
  // reprocessed.)
  if (!ACTIONABLE_STATUSES.includes(charge.status)) return;

  // A pending approval already exists for this charge — don't pile on another.
  const pendingApproval = await prisma.recoveryAction.findFirst({
    where: { failedChargeId: chargeId, requiresApproval: true, executedAt: null },
  });
  if (pendingApproval) return;

  if (charge.pendingPaymentLinkId) {
    if (charge.pendingPaymentLinkIsReal) {
      // BUG FIX: a real Razorpay payment link must NEVER be auto-resolved by
      // the demo simulator. Only the payment_link.paid webhook can VERIFY it.
      // The only thing this pass is allowed to do is enforce the compliance
      // window — if the customer still hasn't paid a real link after the
      // retry window, stop chasing it automatically (a human can still
      // follow up manually; the link itself isn't revoked).
      const ageDays = (simNow.getTime() - charge.occurredAt.getTime()) / DAY_MS;
      if (ageDays > RETRY_WINDOW_DAYS) {
        await stopCharge(charge.id, `Retry window (${RETRY_WINDOW_DAYS}d) expired with a real Razorpay payment link still unpaid.`);
      }
      // Otherwise: genuinely still waiting on the customer / webhook. No-op.
      return;
    }

    // No real link exists (keys weren't configured, or link creation
    // failed) — safe to use the documented simulation for demo purposes.
    const converted = simulateReminderOutcome(charge.id, charge.category as DeclineCategory, charge.attemptNumber);
    if (converted) {
      await markRecovered(
        charge.id,
        charge.subscriptionId,
        simNow,
        RECOVERY_MODE.SIMULATED,
        "Customer paid via recovery link (simulated outcome — no real Razorpay payment link existed).",
      );
      return;
    }
    await prisma.failedCharge.update({ where: { id: charge.id }, data: { pendingPaymentLinkId: null, pendingPaymentLinkIsReal: false } });
    await logAudit(charge.id, "SYSTEM", "payment_link_expired", { attemptNumber: charge.attemptNumber, simulated: true });
  }

  // Classify (deterministic rule table first, LLM only as fallback).
  let category: DeclineCategory;
  if (charge.category === "UNCLASSIFIED") {
    const ruleResult = classifyDeclineCode(charge.declineCode);
    if (ruleResult.decidedBy === "RULE") {
      category = ruleResult.category;
      await logAudit(charge.id, "RULE_ENGINE", "classified", { category, source: "decline code table" });
    } else {
      const llmResult = await classifyUnknownDecline(charge.declineCode, charge.declineReasonRaw);
      category = llmResult.category;
      await logAudit(charge.id, "LLM", "classified", { category, reasoning: llmResult.reasoning });
    }
    await prisma.failedCharge.update({ where: { id: charge.id }, data: { category } });
  } else {
    category = charge.category as DeclineCategory;
  }

  // Compliance stopping rules — hard caps, never overridden by rule or LLM output.
  const ageDays = (simNow.getTime() - charge.occurredAt.getTime()) / DAY_MS;
  if (charge.attemptNumber > MAX_RETRIES) {
    await stopCharge(charge.id, `Exceeded max retries (${MAX_RETRIES}).`);
    return;
  }
  if (ageDays > RETRY_WINDOW_DAYS) {
    await stopCharge(charge.id, `Exceeded retry window (${RETRY_WINDOW_DAYS} days).`);
    return;
  }

  const allowed = ALLOWED_ACTIONS_BY_CATEGORY[category];

  if (allowed.length === 1 && allowed[0] === "ESCALATE_HUMAN") {
    await escalate(charge.id, `Category ${category}, attempt ${charge.attemptNumber}: no automated lever available for this category.`);
    return;
  }

  // AI recommendation step — Claude proposes, it never decides or executes.
  // The recommendation is validated against `allowed` before it can be used;
  // an out-of-policy or failed recommendation falls back to the deterministic
  // default with confidence 0 (see recommendRecoveryAction in llm.ts).
  const recommendation = await recommendRecoveryAction({
    category,
    attemptNumber: charge.attemptNumber,
    amountPaise: charge.amountPaise,
    declineReasonRaw: charge.declineReasonRaw,
    allowedActions: allowed,
  });

  const deterministicDefault = deterministicActionType(category, charge.attemptNumber);
  const actionType = allowed.includes(recommendation.recommendedAction) ? recommendation.recommendedAction : deterministicDefault;

  await logAudit(charge.id, recommendation.source === "LLM" ? "LLM" : "RULE_ENGINE", "recommendation", {
    recommendedAction: recommendation.recommendedAction,
    confidence: recommendation.confidence,
    reasoning: recommendation.reasoning,
    usedAction: actionType,
  });

  if (actionType === "ESCALATE_HUMAN") {
    await escalate(charge.id, recommendation.reasoning);
    return;
  }
  if (actionType === "STOP") {
    await stopCharge(charge.id, recommendation.reasoning);
    return;
  }

  const requiresApproval = charge.amountPaise > HUMAN_APPROVAL_THRESHOLD_PAISE;
  const action = await prisma.recoveryAction.create({
    data: {
      failedChargeId: charge.id,
      type: actionType,
      decidedBy: recommendation.source === "LLM" ? "LLM" : "RULE",
      reasoning: recommendation.reasoning,
      confidence: recommendation.confidence,
      aiRecommended: recommendation.source === "LLM",
      requiresApproval,
    },
  });
  await logAudit(charge.id, "RULE_ENGINE", "action_selected", {
    actionType,
    requiresApproval,
    aiRecommended: recommendation.source === "LLM",
    attemptNumber: charge.attemptNumber,
    maxRetries: MAX_RETRIES,
  });

  if (requiresApproval) {
    await logAudit(charge.id, "SYSTEM", "awaiting_human_approval", {
      amountPaise: charge.amountPaise,
      thresholdPaise: HUMAN_APPROVAL_THRESHOLD_PAISE,
    });
    return;
  }

  await executeAction(action, charge.id, simNow);
}

export async function runBatch() {
  const simNow = await getSimTime();
  const due = await prisma.failedCharge.findMany({
    where: {
      OR: [
        { status: CHARGE_STATUS.NEW },
        { status: { in: [CHARGE_STATUS.RETRY_SCHEDULED, CHARGE_STATUS.WAITING_FOR_PAYMENT] }, nextRetryAt: { lte: simNow } },
      ],
    },
    select: { id: true },
  });

  let processed = 0;
  let failed = 0;
  for (const { id } of due) {
    try {
      await processCharge(id, simNow);
      processed++;
    } catch (err) {
      // One bad charge (a Razorpay/LLM failure that slipped past the inner
      // try/catches, a data anomaly, etc.) must never abort the whole batch.
      failed++;
      await logAudit(id, "SYSTEM", "processing_error", {
        message: err instanceof Error ? err.message : "unknown error",
      }).catch(() => {});
    }
  }

  return { processed, failed, simNow };
}

// Re-fetches both the action and its charge immediately before executing —
// the action may have been queued minutes or days ago (in virtual-clock
// time), and the charge can have been resolved through a completely
// different path since then (a real webhook firing, another approval
// request, a compliance stop from a batch run). Uses an atomic
// compare-and-swap (`updateMany` guarded on approvedAt/executedAt still
// being null) so two concurrent approve clicks on the same action can only
// ever result in one execution.
export async function approvePendingAction(actionId: string) {
  const action = await prisma.recoveryAction.findUnique({ where: { id: actionId } });
  if (!action) return { ok: false as const, reason: "action not found" };
  if (!action.requiresApproval) return { ok: false as const, reason: "action does not require approval" };
  if (action.executedAt) return { ok: false as const, reason: "action already executed" };
  if (action.approvedAt) return { ok: false as const, reason: "action already approved" };

  const charge = await prisma.failedCharge.findUnique({ where: { id: action.failedChargeId } });
  if (!charge) return { ok: false as const, reason: "charge not found" };
  if (!ACTIONABLE_STATUSES.includes(charge.status)) {
    await logAudit(charge.id, "SYSTEM", "approval_skipped_stale", { actionId, chargeStatus: charge.status });
    return { ok: false as const, reason: `charge is already ${charge.status} — stale action discarded` };
  }

  const simNow = await getSimTime();
  const claimed = await prisma.recoveryAction.updateMany({
    where: { id: actionId, approvedAt: null, executedAt: null },
    data: { approvedAt: simNow },
  });
  if (claimed.count === 0) {
    // Lost a race with a concurrent approval of the same action.
    return { ok: false as const, reason: "action already approved by a concurrent request" };
  }

  await logAudit(charge.id, "HUMAN", "approved", { actionId });
  await executeAction({ id: action.id, type: action.type }, charge.id, simNow);
  return { ok: true as const };
}
