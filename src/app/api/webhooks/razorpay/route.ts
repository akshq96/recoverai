import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { CHARGE_STATUS } from "@/lib/constants";
import { markVerifiedRecovery } from "@/lib/policy-engine";

// Real Razorpay webhook receiver.
//
// Handles:
//   payment.failed      -> creates a FailedCharge that the next runBatch()
//                           picks up through the same policy engine as
//                           synthetic data. Deduped on the source Razorpay
//                           payment id, not just the webhook delivery.
//   payment_link.paid    -> the ONLY event allowed to mark a recovery
//                           VERIFIED. Matched against FailedCharge.pendingPaymentLinkId.
//
// Idempotency is two-phase (see WebhookEvent in schema.prisma): a delivery is
// marked RECEIVED before handling and only flipped to PROCESSED after the
// handler succeeds. A delivery that fails mid-handling is left at RECEIVED,
// so Razorpay's own retry (same event id) is allowed to reprocess it —
// nothing is marked "done" until it actually is. Only a delivery already at
// PROCESSED is treated as a true duplicate and skipped.
export async function POST(req: NextRequest) {
  let eventId: string | null = null;

  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      return NextResponse.json({ error: "webhook not configured" }, { status: 500 });
    }

    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    if (!signature) {
      return NextResponse.json({ error: "missing signature" }, { status: 400 });
    }

    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);
    const validSignature =
      expectedBuf.length === signatureBuf.length && crypto.timingSafeEqual(expectedBuf, signatureBuf);
    if (!validSignature) {
      return NextResponse.json({ error: "invalid signature" }, { status: 400 });
    }

    let event: { event?: string; payload?: Record<string, { entity?: Record<string, unknown> }> };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "malformed JSON body" }, { status: 400 });
    }

    eventId = req.headers.get("x-razorpay-event-id") ?? `body:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;

    const existing = await prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (existing?.status === "PROCESSED") {
      return NextResponse.json({ ok: true, duplicate: true });
    }
    if (!existing) {
      await prisma.webhookEvent.create({ data: { id: eventId, event: event.event ?? "unknown", status: "RECEIVED" } });
    }
    // else: existing row is still "RECEIVED" — a prior attempt crashed
    // mid-handling. Fall through and reprocess this delivery.

    if (event.event === "payment.failed") {
      await handlePaymentFailed(event.payload);
    } else if (event.event === "payment_link.paid") {
      await handlePaymentLinkPaid(event.payload);
    }
    // Unrecognized event types are accepted and marked processed — Razorpay
    // expects a 200 for any event type the merchant doesn't act on.

    await prisma.webhookEvent.update({ where: { id: eventId }, data: { status: "PROCESSED", processedAt: new Date() } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    // Deliberately leave the WebhookEvent row (if any) at "RECEIVED" here —
    // that's what makes this delivery retryable. Never leak internals (stack
    // traces, schema hints) to the caller.
    console.error("razorpay webhook error", eventId, err);
    return NextResponse.json({ error: "internal error" }, { status: 500 });
  }
}

async function handlePaymentFailed(payload?: Record<string, { entity?: Record<string, unknown> }>) {
  const payment = payload?.payment?.entity as
    | { id?: string; subscription_id?: string; amount?: number; error_code?: string; error_description?: string }
    | undefined;
  if (!payment?.subscription_id) return; // nothing actionable — gracefully ignored

  const subscription = await prisma.subscription.findFirst({
    where: { razorpaySubscriptionId: payment.subscription_id },
  });
  if (!subscription) return; // unknown subscription — no local record to attach to; ignored, not an error

  // Idempotency at the domain level, not just the webhook-delivery level: if
  // this exact Razorpay payment id already produced a FailedCharge (e.g. a
  // retried delivery that succeeded once already but crashed before the
  // WebhookEvent row could be flipped to PROCESSED), don't create a second one.
  if (payment.id) {
    const alreadyRecorded = await prisma.failedCharge.findFirst({
      where: { razorpaySourceFailedPaymentId: payment.id },
    });
    if (alreadyRecorded) return;
  }

  await prisma.failedCharge.create({
    data: {
      subscriptionId: subscription.id,
      amountPaise: payment.amount ?? 0,
      declineCode: payment.error_code ?? "unknown",
      declineReasonRaw: payment.error_description ?? "unknown",
      category: "UNCLASSIFIED",
      status: CHARGE_STATUS.NEW,
      razorpaySourceFailedPaymentId: payment.id ?? undefined,
    },
  });
}

async function handlePaymentLinkPaid(payload?: Record<string, { entity?: Record<string, unknown> }>) {
  const paymentLink = payload?.payment_link?.entity as { id?: string } | undefined;
  const payment = payload?.payment?.entity as { id?: string } | undefined;
  if (!paymentLink?.id || !payment?.id) return;

  const charge = await prisma.failedCharge.findFirst({
    where: { pendingPaymentLinkId: paymentLink.id },
  });
  if (!charge) return; // no matching local record — gracefully ignored, not an error

  await markVerifiedRecovery(charge.id, payment.id);
}
