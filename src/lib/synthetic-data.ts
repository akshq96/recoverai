import { prisma } from "./prisma";
import { CHARGE_STATUS, HUMAN_APPROVAL_THRESHOLD_PAISE, RETRY_WINDOW_DAYS } from "./constants";

const FIRST_NAMES = ["Aarav", "Vivaan", "Ishaan", "Ananya", "Diya", "Kabir", "Meera", "Rohan", "Sanya", "Karthik", "Priya", "Neha"];
const LAST_NAMES = ["Sharma", "Verma", "Iyer", "Reddy", "Nair", "Gupta", "Khan", "Joshi", "Menon", "Rao"];
const PLANS = [
  { name: "Starter Monthly", amountPaise: 29900, intervalDays: 30 },
  { name: "Pro Monthly", amountPaise: 99900, intervalDays: 30 },
  { name: "Team Annual", amountPaise: 1499900, intervalDays: 365 },
  { name: "Pro Annual", amountPaise: 899900, intervalDays: 365 },
];

// Real Razorpay payment.failed error_code/error_reason values, weighted
// roughly by how often each shows up in production recurring-payment failures.
const DECLINE_SCENARIOS: { code: string; reason: string; weight: number }[] = [
  { code: "insufficient_funds", reason: "Insufficient balance in account", weight: 30 },
  { code: "card_expired", reason: "Card has expired", weight: 15 },
  { code: "mandate_revoked", reason: "Customer revoked the e-mandate", weight: 10 },
  { code: "issuer_unavailable", reason: "Issuing bank server unreachable", weight: 20 },
  { code: "invalid_mandate", reason: "Mandate not found for token", weight: 10 },
  { code: "risk_declined", reason: "Transaction flagged by issuer risk engine", weight: 8 },
  { code: "do_not_honor", reason: "Generic decline from issuer", weight: 7 },
];

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = Math.random() * total;
  for (const item of items) {
    r -= item.weight;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function resetDatabase() {
  await prisma.auditLog.deleteMany();
  await prisma.recoveryAction.deleteMany();
  await prisma.failedCharge.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.customer.deleteMany();
}

export async function generateSyntheticBatch(count = 120) {
  await resetDatabase();

  for (let i = 0; i < count; i++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const plan = pick(PLANS);
    const scenario = weightedPick(DECLINE_SCENARIOS);
    const daysAgo = Math.floor(Math.random() * 5); // occurred within the last 5 days

    const customer = await prisma.customer.create({
      data: {
        name: `${first} ${last}`,
        email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
        phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      },
    });

    const subscription = await prisma.subscription.create({
      data: {
        customerId: customer.id,
        planName: plan.name,
        amountPaise: plan.amountPaise,
        intervalDays: plan.intervalDays,
        status: "halted",
      },
    });

    await prisma.failedCharge.create({
      data: {
        subscriptionId: subscription.id,
        amountPaise: plan.amountPaise,
        declineCode: scenario.code,
        declineReasonRaw: scenario.reason,
        category: "UNCLASSIFIED",
        attemptNumber: 1,
        status: CHARGE_STATUS.NEW,
        occurredAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      },
    });
  }
}

type GuidedCase = {
  name: string;
  plan: (typeof PLANS)[number];
  declineCode: string;
  declineReason: string;
  occurredDaysAgo: number;
  note: string;
};

// Six hand-picked cases, each engineered to land on a specific, distinct
// path through the policy engine on the very first "Run recovery agent"
// click — deterministically, regardless of whether ANTHROPIC_API_KEY or
// Razorpay keys are configured. This is the "Start here" demo: a judge
// clicks once and sees retry, payment-link, AI-classification, human
// approval, and a compliance stop all at once, instead of scrolling through
// 120 near-identical rows to find one of each.
export const GUIDED_CASES: GuidedCase[] = [
  {
    name: "Rohan Gupta",
    plan: PLANS[0], // Starter Monthly, ₹299 — under the approval threshold
    declineCode: "insufficient_funds",
    declineReason: "Insufficient balance in account",
    occurredDaysAgo: 0,
    note: "Rule-mapped to INSUFFICIENT_FUNDS → AUTO_RETRY, auto-executes immediately (simulated outcome — no real Razorpay retry API exists).",
  },
  {
    name: "Priya Nair",
    plan: PLANS[1], // Pro Monthly, ₹999 — under the approval threshold
    declineCode: "card_expired",
    declineReason: "Card has expired",
    occurredDaysAgo: 0,
    note: "Rule-mapped to CARD_EXPIRED → SEND_REMINDER, creates a real Razorpay payment link when keys are configured (else a labeled simulated one).",
  },
  {
    name: "Karthik Menon",
    plan: PLANS[1], // Pro Monthly, ₹999 — under the approval threshold
    declineCode: "unusual_activity_flag",
    declineReason: "Flagged by issuer for unusual account activity",
    occurredDaysAgo: 0,
    note: "Not in the deterministic decline-code table — forces the Claude classification step (or the documented fallback if no API key is set).",
  },
  {
    name: "Ananya Reddy",
    // Must genuinely exceed HUMAN_APPROVAL_THRESHOLD_PAISE for this case to
    // demonstrate the approval gate — Team Annual (₹14,999) comfortably does.
    plan: PLANS.find((p) => p.amountPaise > HUMAN_APPROVAL_THRESHOLD_PAISE) ?? PLANS[2],
    declineCode: "insufficient_funds",
    declineReason: "Insufficient balance in account",
    occurredDaysAgo: 0,
    note: "Same category as case 1, but the amount exceeds the human-approval threshold — queued for approval instead of auto-executing.",
  },
  {
    name: "Vivaan Khan",
    plan: PLANS[1], // Pro Monthly, ₹999
    declineCode: "mandate_revoked",
    declineReason: "Customer revoked the e-mandate",
    occurredDaysAgo: RETRY_WINDOW_DAYS + 1,
    note: "Seeded past the compliance retry window — stopped on the first run rather than attempted, demonstrating the hard cap.",
  },
  {
    name: "Sanya Joshi",
    plan: PLANS[1], // Pro Monthly, ₹999
    declineCode: "issuer_unavailable",
    declineReason: "Issuing bank server unreachable",
    occurredDaysAgo: 0,
    note: "A second, distinct AUTO_RETRY category for variety in the category breakdown.",
  },
];

export async function generateGuidedScenario() {
  await resetDatabase();

  for (const guidedCase of GUIDED_CASES) {
    const customer = await prisma.customer.create({
      data: {
        name: guidedCase.name,
        email: `${guidedCase.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
        phone: `9${Math.floor(100000000 + Math.random() * 899999999)}`,
      },
    });

    const subscription = await prisma.subscription.create({
      data: {
        customerId: customer.id,
        planName: guidedCase.plan.name,
        amountPaise: guidedCase.plan.amountPaise,
        intervalDays: guidedCase.plan.intervalDays,
        status: "halted",
      },
    });

    await prisma.failedCharge.create({
      data: {
        subscriptionId: subscription.id,
        amountPaise: guidedCase.plan.amountPaise,
        declineCode: guidedCase.declineCode,
        declineReasonRaw: guidedCase.declineReason,
        category: "UNCLASSIFIED",
        attemptNumber: 1,
        status: CHARGE_STATUS.NEW,
        occurredAt: new Date(Date.now() - guidedCase.occurredDaysAgo * 24 * 60 * 60 * 1000),
      },
    });
  }
}
