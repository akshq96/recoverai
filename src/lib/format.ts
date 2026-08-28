export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatDate(d: Date | string): string {
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// A restrained, mostly-neutral palette on purpose: text-weight and a single
// dot of color do the work, not a different saturated fill for every state.
const STATUS_COLORS: Record<string, string> = {
  NEW: "text-neutral-500 border-neutral-200",
  RETRY_SCHEDULED: "text-amber-700 border-amber-200",
  RETRY_ATTEMPTED: "text-amber-700 border-amber-200",
  WAITING_FOR_PAYMENT: "text-blue-700 border-blue-200",
  RECOVERED: "text-emerald-700 border-emerald-200",
  ESCALATED: "text-orange-700 border-orange-200",
  STOPPED: "text-red-700 border-red-200",
};

export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? "text-neutral-500 border-neutral-200";
}

// VERIFIED (confirmed by a real Razorpay webhook) vs SIMULATED (outcome from
// the documented probability model) must always read as visually distinct —
// never let a simulated recovery look identical to a verified one. VERIFIED
// is the only state that gets a solid fill; everything else stays outlined.
export function recoveryModeBadge(mode: string | null): { label: string; className: string } | null {
  if (mode === "VERIFIED") return { label: "Verified", className: "bg-emerald-700 text-white" };
  if (mode === "SIMULATED") return { label: "Simulated", className: "text-neutral-500 border border-neutral-300" };
  return null;
}

// Same visual vocabulary as recoveryModeBadge, extended with REAL — used for
// events that involved a genuine Razorpay API call whose final outcome isn't
// settled yet (e.g. a real payment link was just created, nobody's paid it
// yet). REAL and VERIFIED both read as "not a demo"; SIMULATED never does.
export function eventModeBadge(mode: "REAL" | "VERIFIED" | "SIMULATED" | null): { label: string; className: string } | null {
  if (mode === "VERIFIED") return { label: "Verified", className: "bg-emerald-700 text-white" };
  if (mode === "REAL") return { label: "Real", className: "text-blue-700 border border-blue-200" };
  if (mode === "SIMULATED") return { label: "Simulated", className: "text-neutral-500 border border-neutral-300" };
  return null;
}

const ACTOR_LABELS: Record<string, string> = {
  SYSTEM: "System",
  RULE_ENGINE: "Policy engine",
  LLM: "Claude (AI)",
  HUMAN: "Human",
  RAZORPAY_WEBHOOK: "Razorpay",
};

export function actorLabel(actorType: string): string {
  return ACTOR_LABELS[actorType] ?? actorType;
}

// Compact AI / POLICY / HUMAN / RAZORPAY vocabulary for the live activity
// feed and lifecycle timeline, where space is tight and the source of a
// decision needs to read at a glance.
const SHORT_ACTOR_LABELS: Record<string, string> = {
  SYSTEM: "SYSTEM",
  RULE_ENGINE: "POLICY",
  LLM: "AI",
  HUMAN: "HUMAN",
  RAZORPAY_WEBHOOK: "RAZORPAY",
};

export function shortActorLabel(actorType: string): string {
  return SHORT_ACTOR_LABELS[actorType] ?? actorType;
}

export type ActivityEntry = {
  at: Date;
  actorType: string;
  headline: string;
  mode: "REAL" | "VERIFIED" | "SIMULATED" | null;
  customerName?: string;
};

// Turns a raw AuditLog row into a one-line, judge-readable activity feed
// entry. Kept close to the audit log shape rather than the DB layer so it's
// easy to see exactly which log actions map to which headline.
export function humanizeAuditEntry(log: { actorType: string; action: string; createdAt: Date; detail: string }, customerName?: string): ActivityEntry {
  let detail: Record<string, unknown> = {};
  try {
    detail = JSON.parse(log.detail);
  } catch {
    // malformed detail JSON — fall through with an empty object
  }

  const base = { at: log.createdAt, actorType: log.actorType, customerName };

  switch (log.action) {
    case "classified":
      return { ...base, headline: `Category identified: ${detail.category}`, mode: null };
    case "recommendation": {
      const pct = Math.round(((detail.confidence as number) ?? 0) * 100);
      return { ...base, headline: `Recovery probability ${pct}% → AI recommends ${detail.recommendedAction}`, mode: null };
    }
    case "action_selected": {
      const attempt = detail.attemptNumber ? ` (attempt ${detail.attemptNumber}/${detail.maxRetries})` : "";
      return {
        ...base,
        headline: detail.requiresApproval
          ? `Policy: ${detail.actionType} queued for human approval${attempt}`
          : `Policy: approved ${detail.actionType}${attempt}`,
        mode: null,
      };
    }
    case "message_sent":
      return {
        ...base,
        headline: `Razorpay payment link ${detail.paymentLinkIsReal ? "created" : "generated (demo)"} and recovery message sent`,
        mode: detail.paymentLinkIsReal ? "REAL" : "SIMULATED",
      };
    case "recovered": {
      const amount = typeof detail.amountPaise === "number" ? formatPaise(detail.amountPaise) : null;
      return {
        ...base,
        headline:
          detail.recoveryMode === "VERIFIED"
            ? `${amount ?? "Payment"} recovered — verified by Razorpay`
            : `${amount ?? "Payment"} recovered (simulated outcome)`,
        mode: (detail.recoveryMode as "REAL" | "VERIFIED" | "SIMULATED") ?? null,
      };
    }
    case "escalated":
      return { ...base, headline: "Escalated to a human agent", mode: null };
    case "stopped":
      return { ...base, headline: `Stopped: ${detail.reason}`, mode: null };
    case "retry_failed":
      return { ...base, headline: `Simulated auto-retry failed (attempt ${detail.attemptNumber})`, mode: "SIMULATED" };
    case "payment_link_expired":
      return { ...base, headline: "Simulated payment link expired unpaid", mode: "SIMULATED" };
    case "awaiting_human_approval":
      return { ...base, headline: "Awaiting human approval — amount exceeds auto-execute threshold", mode: null };
    case "approved":
      return { ...base, headline: "Human approved the recovery action", mode: null };
    case "approval_skipped_stale":
      return { ...base, headline: "Stale approval discarded — charge already resolved elsewhere", mode: null };
    case "processing_error":
      return { ...base, headline: "Processing error — charge left for the next run", mode: null };
    default:
      return { ...base, headline: log.action, mode: null };
  }
}
