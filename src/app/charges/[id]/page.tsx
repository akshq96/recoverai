import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatPaise, formatDate, statusColor, recoveryModeBadge, eventModeBadge, actorLabel } from "@/lib/format";

type Mode = "REAL" | "VERIFIED" | "SIMULATED" | null;
type LifecycleStep = { label: string; done: boolean; active?: boolean; detail: string; actor?: string; mode: Mode };

function parseDetail(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function buildLifecycle(
  charge: {
    status: string;
    category: string;
    declineCode: string;
    declineReasonRaw: string;
    recoveryMode: string | null;
    razorpayPaymentId: string | null;
    pendingPaymentLinkId: string | null;
    pendingPaymentLinkIsReal: boolean;
    stoppedReason: string | null;
  },
  auditLogs: { actorType: string; action: string; detail: string }[],
  actions: { type: string; outcome: string | null; executedAt: Date | null; requiresApproval: boolean; approvedAt: Date | null }[],
): LifecycleStep[] {
  const classifiedLog = auditLogs.find((l) => l.action === "classified");
  const recommendationLog = [...auditLogs].reverse().find((l) => l.action === "recommendation");
  const actionSelectedLogs = auditLogs.filter((l) => l.action === "action_selected");
  const messageSentLogs = auditLogs.filter((l) => l.action === "message_sent");
  const executedAction = actions.find((a) => a.executedAt);
  const latestAction = actions[actions.length - 1];
  // Only SEND_REMINDER / OFFER_ALT_METHOD ever touch a Razorpay payment link.
  // AUTO_RETRY-only charges must never surface a "waiting on Razorpay" step —
  // there is no real Razorpay payment involved in that lever at all.
  const usesPaymentLink = actions.some((a) => a.type === "SEND_REMINDER" || a.type === "OFFER_ALT_METHOD");

  const steps: LifecycleStep[] = [];

  steps.push({
    label: "Failed",
    done: true,
    detail: `${charge.declineCode} — ${charge.declineReasonRaw}`,
    actor: "SYSTEM",
    mode: null,
  });

  steps.push({
    label: "AI diagnosed",
    done: charge.category !== "UNCLASSIFIED",
    detail: charge.category !== "UNCLASSIFIED" ? `Classified as ${charge.category}` : "Not yet classified",
    actor: classifiedLog?.actorType,
    mode: null,
  });

  const recDetail = recommendationLog ? parseDetail(recommendationLog.detail) : null;
  steps.push({
    label: "AI recommended",
    done: !!recommendationLog,
    detail: recDetail
      ? `Recovery score ${Math.round(((recDetail.confidence as number) ?? 0) * 100)}% — recommends ${recDetail.recommendedAction}. ${recDetail.reasoning}`
      : "No recommendation yet",
    actor: recommendationLog?.actorType,
    mode: null,
  });

  const requiresApproval = !!latestAction?.requiresApproval;
  const approved = !!latestAction?.approvedAt;
  steps.push({
    label: "Policy approved",
    done: actionSelectedLogs.length > 0 && (!requiresApproval || approved),
    detail:
      actionSelectedLogs.length === 0
        ? "No action selected yet"
        : requiresApproval
          ? approved
            ? "Human-approved — amount exceeded the auto-execute threshold"
            : "Awaiting human approval — amount exceeds the auto-execute threshold"
          : "Within policy caps — auto-approved",
    actor: requiresApproval ? (approved ? "HUMAN" : "RULE_ENGINE") : "RULE_ENGINE",
    mode: null,
  });

  const isRealPaymentAction = messageSentLogs.some((l) => parseDetail(l.detail).paymentLinkIsReal === true);
  steps.push({
    label: "Recovery action",
    done: !!executedAction,
    detail: executedAction ? `${executedAction.type} — ${executedAction.outcome ?? "executed"}` : "Not executed yet",
    actor: executedAction ? "SYSTEM" : undefined,
    mode: executedAction ? (executedAction.type === "AUTO_RETRY" ? "SIMULATED" : isRealPaymentAction ? "REAL" : "SIMULATED") : null,
  });

  if (usesPaymentLink) {
    const waiting = charge.status === "WAITING_FOR_PAYMENT" || (charge.status === "RETRY_SCHEDULED" && !!charge.pendingPaymentLinkId);
    steps.push({
      label: "Awaiting payment",
      done: charge.status === "RECOVERED" || waiting,
      active: waiting,
      detail:
        charge.status === "RECOVERED"
          ? "Payment received"
          : waiting
            ? charge.pendingPaymentLinkIsReal
              ? "Waiting on a real Razorpay payment link — only a payment_link.paid webhook can resolve this"
              : "Waiting on a simulated payment link (no Razorpay keys configured) — resolved by the demo simulation, not Razorpay"
            : "No payment link currently outstanding",
      actor: "SYSTEM",
      mode: waiting ? (charge.pendingPaymentLinkIsReal ? "REAL" : "SIMULATED") : null,
    });
  }

  steps.push({
    label: charge.recoveryMode === "SIMULATED" ? "Simulated result" : "Razorpay verified",
    done: charge.status === "RECOVERED",
    detail:
      charge.status === "RECOVERED"
        ? charge.recoveryMode === "VERIFIED"
          ? `Confirmed by Razorpay webhook${charge.razorpayPaymentId ? ` (payment ${charge.razorpayPaymentId})` : ""}`
          : "Confirmed by the demo simulation — not a real payment"
        : charge.status === "ESCALATED"
          ? "Escalated — awaiting human resolution"
          : charge.status === "STOPPED"
            ? `Stopped: ${charge.stoppedReason}`
            : "Not yet recovered",
    actor: charge.status === "RECOVERED" ? (charge.recoveryMode === "VERIFIED" ? "RAZORPAY_WEBHOOK" : "SYSTEM") : undefined,
    mode: (charge.recoveryMode as Mode) ?? null,
  });

  return steps;
}

export default async function ChargeDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const charge = await prisma.failedCharge.findUnique({
    where: { id },
    include: {
      subscription: { include: { customer: true } },
      actions: { orderBy: { createdAt: "asc" } },
      auditLogs: { orderBy: { createdAt: "asc" } },
    },
  });

  if (!charge) notFound();

  const timeline = charge.auditLogs
    .map((l) => ({ at: l.createdAt, label: `${actorLabel(l.actorType)} · ${l.action}`, detail: parseDetail(l.detail) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const lifecycle = buildLifecycle(charge, charge.auditLogs, charge.actions);
  const modeBadge = recoveryModeBadge(charge.recoveryMode);

  const recommendationLog = [...charge.auditLogs].reverse().find((l) => l.action === "recommendation");
  const recDetail = recommendationLog ? parseDetail(recommendationLog.detail) : null;

  return (
    <main className="mx-auto max-w-2xl w-full px-4 sm:px-6 py-10 space-y-8">
      <Link href="/" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900">
        ← Back to dashboard
      </Link>

      <header className="flex items-start justify-between gap-4 flex-wrap border-b border-neutral-200 pb-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">{charge.subscription.customer.name}</h1>
          <p className="text-sm text-neutral-500 mt-1">
            {charge.subscription.planName} · {charge.subscription.customer.email}
          </p>
          <p className="text-3xl font-semibold tracking-tight text-neutral-900 mt-3 tabular-nums">{formatPaise(charge.amountPaise)}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className={`inline-block rounded border px-2.5 py-1 text-xs font-medium ${statusColor(charge.status)}`}>{charge.status}</span>
          {modeBadge && <span className={`inline-block rounded px-2.5 py-1 text-xs font-medium ${modeBadge.className}`}>{modeBadge.label}</span>}
        </div>
      </header>

      {recDetail && (
        <section className="border border-neutral-200 rounded-lg p-4 sm:p-5">
          <div className="text-[11px] font-medium uppercase tracking-widest text-neutral-400 mb-3">
            {recommendationLog?.actorType === "LLM" ? "AI recommendation" : "Policy recommendation (AI unavailable)"}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
            <div>
              <div className="text-xs text-neutral-400">Recovery score</div>
              <div className="text-2xl font-semibold text-neutral-900 tabular-nums">{Math.round(((recDetail.confidence as number) ?? 0) * 100)}%</div>
            </div>
            <div>
              <div className="text-xs text-neutral-400">Recommendation</div>
              <div className="text-2xl font-semibold text-neutral-900">{String(recDetail.recommendedAction)}</div>
            </div>
            <div className="sm:col-span-1">
              <div className="text-xs text-neutral-400">Reason</div>
              <div className="text-neutral-600">{String(recDetail.reasoning)}</div>
            </div>
          </div>
        </section>
      )}

      {/* The lifecycle is the main visual element on this page. */}
      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-4">Recovery lifecycle</h2>
        <ol className="space-y-0">
          {lifecycle.map((s, i) => {
            const badge = eventModeBadge(s.mode);
            return (
              <li key={i} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <span
                    className={`inline-flex w-7 h-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      s.done
                        ? "bg-neutral-900 text-white"
                        : s.active
                          ? "bg-blue-600 text-white"
                          : "border border-neutral-300 text-neutral-400"
                    }`}
                  >
                    {s.done ? "✓" : i + 1}
                  </span>
                  {i < lifecycle.length - 1 && <span className={`w-px flex-1 min-h-[26px] mt-1 ${s.done ? "bg-neutral-300" : "bg-neutral-200"}`} />}
                </div>
                <div className="pb-6 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-semibold ${s.done ? "text-neutral-900" : "text-neutral-400"}`}>{s.label}</span>
                    {badge && <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span>}
                    {s.actor && (
                      <span className="text-[10px] text-neutral-400 border border-neutral-200 rounded px-1.5 py-0.5">{actorLabel(s.actor)}</span>
                    )}
                  </div>
                  <p className="text-sm text-neutral-500 mt-1">{s.detail}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Decline code" value={charge.declineCode} />
        <Field label="Category" value={charge.category} />
        <Field label="Attempt" value={String(charge.attemptNumber)} />
        <Field label="Occurred" value={formatDate(charge.occurredAt)} />
        <Field label="Next retry" value={charge.nextRetryAt ? formatDate(charge.nextRetryAt) : "—"} />
        <Field label="Recovered at" value={charge.recoveredAt ? formatDate(charge.recoveredAt) : "—"} />
        <Field label="Razorpay payment ID" value={charge.razorpayPaymentId ?? "—"} />
        <Field label="Plan" value={charge.subscription.planName} />
      </section>

      {charge.pendingPaymentLinkId && (
        <section>
          <h2 className="text-sm font-medium text-neutral-700 mb-2">Pending payment link</h2>
          <p className="text-sm text-neutral-600 border border-neutral-200 rounded-lg px-4 py-3 flex items-center gap-2 flex-wrap">
            <span className="font-mono">{charge.pendingPaymentLinkId}</span>
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${
                charge.pendingPaymentLinkIsReal ? "text-blue-700 border border-blue-200" : "text-neutral-500 border border-neutral-300"
              }`}
            >
              {charge.pendingPaymentLinkIsReal ? "Real" : "Simulated"}
            </span>
            <span className="text-xs text-neutral-400">
              {charge.pendingPaymentLinkIsReal
                ? "Only a real payment_link.paid webhook can resolve this."
                : "Will be resolved by the demo simulation on the next agent run — not by Razorpay."}
            </span>
          </p>
        </section>
      )}

      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-2">Recovery actions</h2>
        <ul className="space-y-2">
          {charge.actions.map((a) => (
            <li key={a.id} className="border border-neutral-200 rounded-lg px-4 py-3 text-sm">
              <div className="flex justify-between">
                <span className="font-semibold text-neutral-800">{a.type}</span>
                <span className="text-neutral-400">{formatDate(a.createdAt)}</span>
              </div>
              <p className="text-neutral-500 mt-1">{a.reasoning}</p>
              <div className="flex flex-wrap gap-3 mt-2 text-xs text-neutral-400">
                <span>decided by {actorLabel(a.decidedBy)}</span>
                {a.aiRecommended && (
                  <span className="text-neutral-500 font-medium">AI-recommended · {Math.round((a.confidence ?? 0) * 100)}% confidence</span>
                )}
                {a.requiresApproval && <span>requires approval{a.approvedAt ? ` · approved ${formatDate(a.approvedAt)}` : ""}</span>}
                {a.outcome && <span>outcome: {a.outcome}</span>}
                {a.razorpayPaymentLinkId && <span>link: {a.razorpayPaymentLinkId}</span>}
                {a.verifiedAt && <span className="text-emerald-700 font-medium">verified {formatDate(a.verifiedAt)}</span>}
              </div>
            </li>
          ))}
          {charge.actions.length === 0 && <p className="text-sm text-neutral-400">No recovery actions yet.</p>}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-2">Full audit trail</h2>
        <ol className="relative border-l border-neutral-200 ml-2 space-y-4">
          {timeline.map((t, i) => (
            <li key={i} className="ml-4">
              <div className="absolute -ml-[5px] w-2.5 h-2.5 rounded-full bg-neutral-400 mt-1.5" />
              <div className="text-xs text-neutral-400">{formatDate(t.at)}</div>
              <div className="text-sm font-medium text-neutral-700">{t.label}</div>
              <pre className="text-xs text-neutral-500 whitespace-pre-wrap break-words mt-1">{JSON.stringify(t.detail, null, 2)}</pre>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-neutral-200 rounded-md px-3 py-2.5">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className="text-sm font-medium break-all text-neutral-800">{value}</div>
    </div>
  );
}
