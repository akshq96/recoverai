import Razorpay from "razorpay";

let client: Razorpay | null = null;
function getClient(): Razorpay {
  if (!client) {
    client = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID ?? "",
      key_secret: process.env.RAZORPAY_KEY_SECRET ?? "",
    });
  }
  return client;
}

// Real Razorpay test-mode call: creates a short-lived payment link the
// customer can use to clear the failed charge. This is genuine API usage —
// no mocking when keys are configured — and is what SEND_REMINDER /
// OFFER_ALT_METHOD actions send. The resulting link id is stored on the
// charge and matched against the incoming payment_link.paid webhook, which
// is the only thing allowed to mark a recovery VERIFIED.
//
// NOTE: Razorpay does not expose a public "retry this subscription charge
// now" endpoint — recurring-charge retries are owned by the NPCI e-mandate /
// card-network retry schedule, not something a merchant can trigger directly.
// AUTO_RETRY therefore does not call this client; its outcome is produced by
// the documented simulation in src/lib/simulate-outcome.ts and can only ever
// be SIMULATED, never VERIFIED. This split is intentional — see README.
export async function createRecoveryPaymentLink(params: {
  amountPaise: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  description: string;
}): Promise<{ url: string | null; id: string | null; mocked: boolean; error?: string }> {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return { url: null, id: null, mocked: true };
  }

  try {
    const link = await getClient().paymentLink.create({
      amount: params.amountPaise,
      currency: "INR",
      description: params.description,
      customer: {
        name: params.customerName,
        email: params.customerEmail,
        contact: params.customerPhone,
      },
      notify: { sms: false, email: false },
      reminder_enable: false,
    });

    return { url: link.short_url, id: link.id, mocked: false };
  } catch (err) {
    // Bad test keys, network blip, rate limit — never let a Razorpay API
    // failure crash a batch run. Fall back to "mocked" so the recovery
    // pipeline keeps moving (the charge is clearly labeled SIMULATED
    // downstream); the error is surfaced to the audit log by the caller.
    return {
      url: null,
      id: null,
      mocked: true,
      error: err instanceof Error ? err.message : "Razorpay payment link creation failed",
    };
  }
}
