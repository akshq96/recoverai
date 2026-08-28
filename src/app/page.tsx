import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { getSimTime } from "@/lib/sim-clock";
import { formatPaise, formatDate, statusColor, recoveryModeBadge, eventModeBadge, shortActorLabel, humanizeAuditEntry } from "@/lib/format";
import { GUIDED_CASES } from "@/lib/synthetic-data";
import { MAX_RETRIES, RETRY_WINDOW_DAYS } from "@/lib/constants";
import { seedBatchAction, seedGuidedScenarioAction, runBatchAction, approveActionAction, advanceClockAction } from "./actions";
import { RunAgentButton, SubmitButton } from "./action-buttons";

const NOT_YET_RESOLVED_STATUSES = ["NEW", "RETRY_SCHEDULED", "WAITING_FOR_PAYMENT", "ESCALATED"];

export default async function Dashboard() {
  const [charges, pendingApprovals, simNow, total, recoveryAttemptCount, recentActivity] = await Promise.all([
    prisma.failedCharge.findMany({
      include: {
        subscription: { include: { customer: true } },
        actions: { orderBy: { createdAt: "desc" }, take: 1 },
      },
      orderBy: { occurredAt: "desc" },
      take: 300,
    }),
    prisma.recoveryAction.findMany({
      where: { requiresApproval: true, executedAt: null },
      include: { failedCharge: { include: { subscription: { include: { customer: true } } } } },
      orderBy: { createdAt: "asc" },
    }),
    getSimTime(),
    prisma.failedCharge.count(),
    prisma.recoveryAction.count(),
    prisma.auditLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { failedCharge: { include: { subscription: { include: { customer: true } } } } },
    }),
  ]);

  const recovered = charges.filter((c) => c.status === "RECOVERED");
  const verifiedRecovered = recovered.filter((c) => c.recoveryMode === "VERIFIED");
  const simulatedRecovered = recovered.filter((c) => c.recoveryMode === "SIMULATED");
  const escalated = charges.filter((c) => c.status === "ESCALATED");
  const stopped = charges.filter((c) => c.status === "STOPPED");
  const inProgress = charges.filter((c) => c.status === "NEW" || c.status === "RETRY_SCHEDULED" || c.status === "WAITING_FOR_PAYMENT");

  // Every number below traces back to exactly one bucket of charges — a
  // charge that's RECOVERED is never also counted as "at risk", and a
  // charge that's STOPPED is dead, not still eligible.
  const failedRevenuePaise = charges.reduce((s, c) => s + c.amountPaise, 0);
  const eligibleRevenuePaise = charges
    .filter((c) => NOT_YET_RESOLVED_STATUSES.includes(c.status))
    .reduce((s, c) => s + c.amountPaise, 0);
  const verifiedRecoveredPaise = verifiedRecovered.reduce((s, c) => s + c.amountPaise, 0);
  const simulatedRecoveredPaise = simulatedRecovered.reduce((s, c) => s + c.amountPaise, 0);
  const verifiedRate = total > 0 ? (verifiedRecovered.length / total) * 100 : 0;
  const totalRate = total > 0 ? (recovered.length / total) * 100 : 0;

  const razorpayLive = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const claudeLive = !!process.env.ANTHROPIC_API_KEY;

  const byCategory = new Map<string, { total: number; recovered: number }>();
  for (const c of charges) {
    const entry = byCategory.get(c.category) ?? { total: 0, recovered: 0 };
    entry.total += 1;
    if (c.status === "RECOVERED") entry.recovered += 1;
    byCategory.set(c.category, entry);
  }

  const activity = recentActivity.map((log) => humanizeAuditEntry(log, log.failedCharge.subscription.customer.name));

  return (
    <main className="mx-auto max-w-5xl w-full px-4 sm:px-6 py-10 space-y-10">
      {/* Masthead */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h1 className="text-4xl font-semibold tracking-tight text-neutral-900">RecoverAI</h1>
          <div className="flex items-center gap-4 text-xs text-neutral-400">
            <StatusDot label="Razorpay" state={razorpayLive ? "Test mode" : "Demo mode"} live={razorpayLive} />
            <StatusDot label="Claude" state={claudeLive ? "Configured" : "Fallback"} live={claudeLive} />
            <span className="font-mono tabular-nums">{formatDate(simNow)}</span>
          </div>
        </div>
        <p className="text-[15px] text-neutral-600 leading-relaxed max-w-2xl">
          Detects revenue at risk from failed recurring payments, determines the right intervention, and executes a
          bounded, auditable recovery workflow — Claude recommends, policy enforces the safety caps, Razorpay
          executes and confirms.
        </p>
      </header>

      {/* Headline numbers — a financial-statement strip, not a widget grid */}
      <section className="border-y border-neutral-200 py-5">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-6">
          <Stat label="Failed revenue" value={formatPaise(failedRevenuePaise)} sub={`${total} charges`} />
          <Stat label="Revenue at risk" value={formatPaise(eligibleRevenuePaise)} sub="still eligible" tone="amber" />
          <Stat label="Recovery attempts" value={String(recoveryAttemptCount)} sub="actions taken" />
          <Stat label="Verified recovered" value={formatPaise(verifiedRecoveredPaise)} sub="confirmed by Razorpay" tone="emerald" />
          <Stat label="Recovery rate" value={`${verifiedRate.toFixed(1)}%`} sub={`+${(totalRate - verifiedRate).toFixed(1)}% simulated`} tone="emerald" />
        </div>
      </section>

      {/* Built to the brief — proves the bar is actually met, in its own words */}
      <section>
        <div className="text-[11px] font-medium uppercase tracking-widest text-neutral-400 mb-2">Built to the brief</div>
        <blockquote className="text-sm text-neutral-500 italic border-l-2 border-neutral-200 pl-3 mb-4 max-w-2xl">
          &ldquo;Don&apos;t just identify the problem. Show measured money recovered across a batch, with compliant
          escalation, stopping rules, and an audit trail.&rdquo;
        </blockquote>
        <div className="grid sm:grid-cols-2 gap-3">
          <BarItem
            label="Measured money recovered"
            value={formatPaise(verifiedRecoveredPaise)}
            detail={`${verifiedRecovered.length} of ${total} charges verified by Razorpay`}
          />
          <BarItem
            label="Compliant escalation"
            value={String(escalated.length)}
            detail="handed to a human when no automated lever applies"
          />
          <BarItem
            label="Stopping rules"
            value={`${MAX_RETRIES} / ${RETRY_WINDOW_DAYS}d`}
            detail={`max retries / retry window enforced — ${stopped.length} stopped so far`}
          />
          <BarItem label="Audit trail" value={String(recoveryAttemptCount)} detail="logged decisions — open any charge for its full timeline" />
        </div>
      </section>

      {/* Start here */}
      <section className="border border-neutral-200 rounded-lg p-5 sm:p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-neutral-400 border border-neutral-300 rounded px-1.5 py-0.5">
            Start here
          </span>
          <h2 className="text-sm font-medium text-neutral-700">How to run the demo</h2>
        </div>

        <ol className="flex flex-wrap gap-x-5 gap-y-3 mb-5 text-sm">
          {WORKFLOW_STEPS.map((step, i) => (
            <li key={step.title} className="flex items-baseline gap-2 max-w-[150px]">
              <span className="font-mono text-[11px] text-neutral-300 tabular-nums">{String(i + 1).padStart(2, "0")}</span>
              <span>
                <span className="font-medium text-neutral-800">{step.title}</span>
                <span className="block text-[11px] text-neutral-400 leading-snug mt-0.5">{step.blurb}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap items-center gap-2.5">
          <form action={seedGuidedScenarioAction}>
            <SubmitButton className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700">
              Generate guided scenario
            </SubmitButton>
          </form>
          <form action={runBatchAction}>
            <RunAgentButton razorpayLive={razorpayLive} />
          </form>
          <div className="w-px h-5 bg-neutral-200 mx-1 hidden sm:block" />
          <form action={advanceClockAction.bind(null, 1)}>
            <SubmitButton className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
              +1 day
            </SubmitButton>
          </form>
          <form action={advanceClockAction.bind(null, 3)}>
            <SubmitButton className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
              +3 days
            </SubmitButton>
          </form>
        </div>

        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-600 select-none">
            What the 6 guided cases demonstrate
          </summary>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5 mt-3 text-xs text-neutral-500">
            {GUIDED_CASES.map((c) => (
              <div key={c.name}>
                <span className="font-medium text-neutral-700">{c.name}</span> — {c.note}
              </div>
            ))}
          </div>
        </details>

        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-neutral-400 hover:text-neutral-600 select-none">
            Advanced: generate a large random batch instead
          </summary>
          <form action={seedBatchAction.bind(null, 120)} className="mt-2">
            <SubmitButton className="rounded-md border border-neutral-300 px-3 py-2 text-xs font-medium text-neutral-600 hover:bg-neutral-50">
              Generate 120 random charges (resets current data)
            </SubmitButton>
          </form>
        </details>
      </section>

      {/* Funnel */}
      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-3">Recovery funnel</h2>
        <div className="flex flex-wrap items-stretch text-sm">
          <FunnelCell label="Failed revenue" value={formatPaise(failedRevenuePaise)} />
          <FunnelDivider />
          <FunnelCell label="Eligible revenue" value={formatPaise(eligibleRevenuePaise)} />
          <FunnelDivider />
          <FunnelCell label="Recovery attempts" value={String(recoveryAttemptCount)} />
          <FunnelDivider />
          <FunnelCell label="Successful recoveries" value={String(recovered.length)} sub={`${verifiedRecovered.length} verified · ${simulatedRecovered.length} simulated`} />
          <FunnelDivider />
          <FunnelCell label="Verified ₹ recovered" value={formatPaise(verifiedRecoveredPaise)} emphasize />
        </div>
        <p className="text-xs text-neutral-400 mt-3 max-w-2xl">
          &ldquo;Successful recoveries&rdquo; blends verified and simulated outcomes to show the decision logic working end to
          end — the final ₹ figure never does. Simulated ₹{formatPaise(simulatedRecoveredPaise)} is demo-only and
          excluded from every revenue total above.
        </p>
      </section>

      {/* Operational status */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <MiniStat label="Simulated recovered" value={formatPaise(simulatedRecoveredPaise)} sub={`${simulatedRecovered.length} charges — demo only`} />
        <MiniStat label="Awaiting real payment" value={String(charges.filter((c) => c.status === "WAITING_FOR_PAYMENT").length)} sub="real Razorpay link outstanding" tone="blue" />
        <MiniStat label="Escalated to human" value={String(escalated.length)} tone="orange" />
        <MiniStat label="Stopped (compliance)" value={String(stopped.length)} sub="retries or window exceeded" tone="red" />
      </section>

      {pendingApprovals.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-neutral-700 mb-3">Pending human approval — amount exceeds the auto-execute threshold</h2>
          <ul className="space-y-2">
            {pendingApprovals.map((a) => (
              <li key={a.id} className="flex items-center justify-between border-l-2 border-amber-400 bg-amber-50/50 pl-3.5 pr-3 py-2.5 rounded-r-md">
                <div className="text-sm">
                  <span className="font-medium text-neutral-800">{a.failedCharge.subscription.customer.name}</span>{" "}
                  <span className="text-neutral-500">
                    — {a.type} — {formatPaise(a.failedCharge.amountPaise)} — {a.failedCharge.subscription.planName}
                  </span>
                  <div className="text-xs text-neutral-500 mt-0.5">{a.reasoning}</div>
                  {a.aiRecommended && (
                    <div className="text-xs text-neutral-400 mt-0.5">
                      Recovery score {Math.round((a.confidence ?? 0) * 100)}% · AI-recommended
                    </div>
                  )}
                </div>
                <form action={approveActionAction.bind(null, a.id)}>
                  <SubmitButton className="rounded-md bg-emerald-700 text-white px-3.5 py-1.5 text-xs font-medium hover:bg-emerald-600 shrink-0">
                    Approve
                  </SubmitButton>
                </form>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Live activity */}
      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-3">Live agent activity</h2>
        <div className="border border-neutral-200 rounded-lg divide-y divide-neutral-100 max-h-96 overflow-y-auto">
          {activity.map((entry, i) => {
            const badge = eventModeBadge(entry.mode);
            return (
              <div key={i} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[10px] font-medium text-neutral-400 shrink-0 w-14">{shortActorLabel(entry.actorType)}</span>
                    <span className="text-neutral-700">{entry.headline}</span>
                    {badge && (
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${badge.className}`}>{badge.label}</span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-400 mt-0.5 pl-[3.75rem]">{entry.customerName}</div>
                </div>
                <div className="text-xs text-neutral-400 font-mono tabular-nums whitespace-nowrap">{formatDate(entry.at)}</div>
              </div>
            );
          })}
          {activity.length === 0 && <div className="px-4 py-8 text-center text-neutral-400 text-sm">No activity yet.</div>}
        </div>
      </section>

      {/* Category breakdown */}
      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-3">By decline category</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {[...byCategory.entries()].map(([category, stats]) => (
            <div key={category} className="border border-neutral-200 rounded-md p-3">
              <div className="text-[11px] text-neutral-400">{category}</div>
              <div className="text-lg font-semibold text-neutral-800 tabular-nums">
                {stats.recovered}/{stats.total}
              </div>
              <div className="text-[10px] text-neutral-400">recovered</div>
            </div>
          ))}
        </div>
      </section>

      {/* Charges table */}
      <section>
        <h2 className="text-sm font-medium text-neutral-700 mb-3">Failed charges ({inProgress.length} in progress)</h2>
        <div className="overflow-x-auto border border-neutral-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="text-neutral-400 text-left text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2.5 font-medium">Customer</th>
                <th className="px-3 py-2.5 font-medium">Plan</th>
                <th className="px-3 py-2.5 font-medium">Amount</th>
                <th className="px-3 py-2.5 font-medium">Category</th>
                <th className="px-3 py-2.5 font-medium">AI score</th>
                <th className="px-3 py-2.5 font-medium">Attempt</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-3 py-2.5 font-medium">Mode</th>
                <th className="px-3 py-2.5 font-medium">Next</th>
                <th className="px-3 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {charges.map((c) => {
                const badge = recoveryModeBadge(c.recoveryMode);
                const latestAction = c.actions[0];
                return (
                  <tr key={c.id} className="border-t border-neutral-100 hover:bg-neutral-50 transition-colors">
                    <td className="px-3 py-2.5">{c.subscription.customer.name}</td>
                    <td className="px-3 py-2.5 text-neutral-500">{c.subscription.planName}</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{formatPaise(c.amountPaise)}</td>
                    <td className="px-3 py-2.5 text-neutral-500">{c.category}</td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">
                      {latestAction?.aiRecommended ? (
                        <span className="text-neutral-700">{Math.round((latestAction.confidence ?? 0) * 100)}%</span>
                      ) : (
                        <span className="text-neutral-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono tabular-nums">{c.attemptNumber}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-block rounded border px-1.5 py-0.5 text-xs font-medium ${statusColor(c.status)}`}>{c.status}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      {badge && <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>}
                      {!badge && c.status === "WAITING_FOR_PAYMENT" && (
                        <span className="inline-block rounded px-1.5 py-0.5 text-xs font-medium text-blue-700 border border-blue-200">Real link</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-neutral-500">{c.nextRetryAt ? formatDate(c.nextRetryAt) : c.stoppedReason ?? "—"}</td>
                    <td className="px-3 py-2.5">
                      <Link href={`/charges/${c.id}`} className="text-neutral-500 hover:text-neutral-900 underline underline-offset-2">
                        Timeline
                      </Link>
                    </td>
                  </tr>
                );
              })}
              {charges.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-3 py-10 text-center text-neutral-400">
                    No data yet — click <span className="font-medium text-neutral-600">Generate guided scenario</span> above to begin.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function StatusDot({ label, state, live }: { label: string; state: string; live: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-amber-500"}`} />
      {label} <span className="text-neutral-500">{state}</span>
    </span>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "amber" | "emerald" }) {
  const valueTone = tone === "amber" ? "text-amber-700" : tone === "emerald" ? "text-emerald-700" : "text-neutral-900";
  return (
    <div>
      <div className="text-[11px] text-neutral-400 font-medium">{label}</div>
      <div className={`text-2xl font-semibold mt-1 tracking-tight tabular-nums ${valueTone}`}>{value}</div>
      {sub && <div className="text-[11px] text-neutral-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function MiniStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "blue" | "orange" | "red" }) {
  const valueTone = tone === "blue" ? "text-blue-700" : tone === "orange" ? "text-orange-700" : tone === "red" ? "text-red-700" : "text-neutral-700";
  return (
    <div className="border border-neutral-200 rounded-md p-3">
      <div className="text-[11px] text-neutral-400">{label}</div>
      <div className={`text-base font-semibold mt-1 tabular-nums ${valueTone}`}>{value}</div>
      {sub && <div className="text-[10px] text-neutral-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function BarItem({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="border border-neutral-200 rounded-md p-3.5 flex items-start gap-3">
      <span className="text-emerald-700 font-medium mt-0.5">✓</span>
      <div>
        <div className="text-sm text-neutral-800 font-medium">{label}</div>
        <div className="text-lg font-semibold text-neutral-900 tabular-nums">{value}</div>
        <div className="text-xs text-neutral-400 mt-0.5">{detail}</div>
      </div>
    </div>
  );
}

function FunnelCell({ label, value, sub, emphasize }: { label: string; value: string; sub?: string; emphasize?: boolean }) {
  return (
    <div className="flex-1 min-w-[130px] py-3">
      <div className="text-[11px] text-neutral-400">{label}</div>
      <div className={`text-base font-semibold mt-0.5 tabular-nums ${emphasize ? "text-emerald-700" : "text-neutral-800"}`}>{value}</div>
      {sub && <div className="text-[10px] text-neutral-400 mt-0.5">{sub}</div>}
    </div>
  );
}

function FunnelDivider() {
  return <div className="w-px bg-neutral-200 mx-3 hidden sm:block" aria-hidden />;
}

const WORKFLOW_STEPS: { title: string; blurb: string }[] = [
  { title: "Generate", blurb: "Seed failed payments — 6 curated cases or a large random batch." },
  { title: "Run agent", blurb: "One click processes every eligible failed charge." },
  { title: "AI diagnosis", blurb: "Decline code mapped to a category — rules first, Claude for the rest." },
  { title: "AI recommendation", blurb: "Claude proposes a lever + confidence. It never executes." },
  { title: "Policy / safety", blurb: "Hard caps: retries, window, ₹ threshold — no AI override." },
  { title: "Recovery action", blurb: "Auto-retry, or a Razorpay payment link + AI-drafted message." },
  { title: "Razorpay payment", blurb: "The customer pays a real link, or a demo simulation stands in." },
  { title: "Verified recovery", blurb: "Only a Razorpay webhook can mark this verified." },
];
