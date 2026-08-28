"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";

// Purely a UI progression — the underlying server action is a single call,
// there's no real per-stage server signal to hook into. Cycling through
// these labels while the action is pending turns "numbers silently change"
// into a legible sense of what the agent is doing, without fabricating any
// data (nothing here is written to the database or shown as a result).
//
// The final stage is environment-aware on purpose: this batch may contain
// zero real Razorpay payment links (no keys configured, or every charge in
// it resolved via AUTO_RETRY / simulation), so it must never unconditionally
// claim to be "waiting for Razorpay" — that would misrepresent a purely
// simulated run as involving a real payment.
const BASE_STAGES = ["Detecting failures", "Diagnosing", "Selecting recovery strategy", "Applying policy", "Executing recovery"];

export function RunAgentButton({ razorpayLive }: { razorpayLive: boolean }) {
  const { pending } = useFormStatus();
  const [stageIndex, setStageIndex] = useState(0);
  const stages = [...BASE_STAGES, razorpayLive ? "Waiting for Razorpay confirmation" : "Applying simulated outcome"];

  useEffect(() => {
    if (!pending) {
      setStageIndex(0);
      return;
    }
    const interval = setInterval(() => {
      setStageIndex((i) => Math.min(i + 1, stages.length - 1));
    }, 450);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-70 disabled:cursor-wait min-w-[190px] justify-center"
    >
      {pending ? (
        <>
          <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin shrink-0" />
          <span>{stages[stageIndex]}…</span>
        </>
      ) : (
        "Run recovery agent"
      )}
    </button>
  );
}

export function SubmitButton({ children, className }: { children: ReactNode; className: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={`${className} disabled:opacity-60 disabled:cursor-wait`}>
      {pending ? "Working…" : children}
    </button>
  );
}
