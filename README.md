# RecoverAI

**Track:** AI Revenue Recovery — Razorpay AI Buildathon
**Direction:** Failed-subscription recovery

Detects failed recurring subscription charges, diagnoses why they failed, and runs a bounded, auditable recovery workflow to win the revenue back — with hard compliance caps, human approval for high-value actions, and a hard line between money that's actually been confirmed recovered and money that's only been recovered in a demo simulation.

## The problem

A recurring payment can fail for very different reasons — a card expired, the customer's balance was short, the issuing bank was briefly unreachable, an e-mandate got revoked. Each of those deserves a different response, and none of them should be handled by silently retrying forever or by an unbounded agent sending unlimited messages. This project treats "recover the revenue" as a diagnose → recommend → decide → act → confirm pipeline with hard stops at every stage, not a single retry button — and it never reports a recovery as real until Razorpay itself has confirmed it.

## How it works

1. **Detect** — a failed charge lands as a `FailedCharge` row, either from a seeded synthetic batch or a real Razorpay `payment.failed` webhook.
2. **Diagnose** — a deterministic table maps known Razorpay decline codes (`insufficient_funds`, `card_expired`, `mandate_revoked`, …) to a category. Only decline codes the table doesn't recognize fall through to an LLM classifier. This split is deliberate: known cases stay cheap and fully auditable; the LLM is reserved for the genuinely ambiguous ones.
3. **Recommend** — Claude looks at the category, attempt number, and amount, and recommends one lever from that category's allowed-action set, with a confidence score and reasoning. This is the *only* place the LLM has any influence over what happens — and even here it only recommends. A recommendation outside the allowed set for that category is rejected outright.
4. **Decide + bound it** — a deterministic policy engine validates the recommendation (or falls back to a fixed default if the LLM is unavailable or went out of policy) and enforces hard caps that no rule or LLM output can override: max 3 retries, a 7-day compliance window, and any action on a charge above ₹5,000 is queued for human approval before it executes.
5. **Act** — `AUTO_RETRY` outcomes are drawn from a documented, seeded probability model (see "Why simulation exists" below). `SEND_REMINDER` / `OFFER_ALT_METHOD` create a real Razorpay test-mode payment link (when `RAZORPAY_KEY_ID`/`SECRET` are configured) and an LLM-drafted message.
6. **Confirm** — a charge is only ever marked recovered through one of two paths, and the UI never blurs the line between them:
   - **VERIFIED** — a real Razorpay `payment_link.paid` webhook confirmed the money moved. The charge sits in `WAITING_FOR_PAYMENT` the entire time a real link is outstanding, and *nothing* in this codebase — not the simulator, not a batch run, not a timeout — is allowed to mark it recovered except that webhook.
   - **SIMULATED** — the outcome came from the probability model, used only when no real payment link exists (no Razorpay keys configured, or link creation failed). Simulated outcomes are clearly badged everywhere and excluded from the "Verified ₹ recovered" funnel metric.
7. **Audit** — every decision, rule fired, LLM call, and outcome is written to an append-only audit log, viewable per-charge as a lifecycle timeline (Failed → Diagnosed → Recommended → Policy approved → Action executed → Awaiting payment → Verified/simulated recovered), each step tagged with who/what made it (AI / rule engine / human / Razorpay).

A virtual clock lets the whole multi-day retry/backoff sequence be fast-forwarded for a demo instead of waiting on real time.

## Recovery attempts, not promises

There is no speculative "customer promised to pay" record anywhere in this codebase. A `RecoveryAction` row is only ever created when the policy engine actually decides to act, and it's only ever marked with an outcome once something real happens — a simulated dice-roll resolves it, or a Razorpay webhook confirms it. If you're looking for the old "promise-to-pay" concept from an earlier draft: it's gone, replaced by tracking the actual outstanding payment link (`FailedCharge.pendingPaymentLinkId` / `pendingPaymentLinkIsReal`) and resolving it through the same `RecoveryAction` audit trail as everything else.

## Stack

Next.js (App Router, TypeScript) · Prisma + SQLite · Anthropic SDK (Claude) · Razorpay Node SDK · Tailwind

## Running it

```bash
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY / RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET
npx prisma generate
npx prisma db push
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and click **Generate guided scenario** — it seeds 6 hand-picked charges engineered to each land on a different path (retry, real/simulated payment link, forced AI classification, human-approval gate, and a compliance stop) on the very first **Run recovery agent** click, deterministically, whether or not API keys are configured. `GUIDED_CASES` in `src/lib/synthetic-data.ts` documents exactly what each case demonstrates. A large random 120-charge batch is still available as an "Advanced" option for stress-testing the funnel numbers. Use **Fast-forward** to advance the virtual clock and watch retries and reminders resolve. The app runs without any keys configured too — it falls back to template messages, skips real payment-link creation, and every recovery is clearly labeled SIMULATED, so the whole flow is inspectable with zero setup.

To receive real Razorpay events instead of only synthetic ones, point a test-mode webhook at `POST /api/webhooks/razorpay` for `payment.failed` and `payment_link.paid`, and set `RAZORPAY_WEBHOOK_SECRET`. The webhook is idempotent: each delivery is recorded before handling and only marked processed after the handler succeeds, so a delivery that fails partway is safely retried by Razorpay rather than silently lost, and a delivery that already succeeded is never reprocessed.

## Why simulation exists at all

Razorpay doesn't expose an endpoint to make a recurring-charge retry succeed or fail on demand — that's owned by the NACH/card-network retry schedule, not something a merchant can trigger. And a real payment link genuinely requires a human to open it and pay. Neither is controllable from test mode. Rather than fake every outcome as a guaranteed success (which would make "money recovered" meaningless) or block the whole demo on a real bank/human, outcomes for these specific cases are drawn from a documented, seeded probability model (`src/lib/simulate-outcome.ts`) — but **only when there's no real Razorpay artifact to wait for**. The moment a real payment link exists, simulation is locked out for that charge; only the webhook can resolve it.

## What broke, and how I got out

- **Prisma 8 landed mid-build as the `latest` tag.** `npm install prisma` pulled a `8.0.0-rc.12` release candidate with a completely different CLI (no `generate`/`db push`, JSON-only output, driver-adapter config). Pinned to the latest *stable* major (`prisma@5`) instead of chasing the RC.
- **SQLite doesn't support Prisma's native `enum` type.** Switched status/type/actor fields to plain `String` with the allowed values enforced in `src/lib/constants.ts` instead — the app-level type stays just as strict, the DB layer doesn't need to support something SQLite can't do.
- **The first cut of webhook idempotency marked events processed *before* handling them.** That meant a delivery that crashed mid-handler would never be retried by Razorpay, silently dropping a real recovery confirmation. Fixed to a two-phase `RECEIVED → PROCESSED` ledger — only a delivery that actually finished successfully is treated as done.
- **The first cut of the demo simulator would resolve a real outstanding Razorpay payment link by dice roll**, which meant a genuinely pending real payment could get incorrectly marked "recovered (simulated)" before the customer had done anything. Fixed by splitting `RETRY_SCHEDULED` (simulation-eligible) from `WAITING_FOR_PAYMENT` (real link outstanding — simulator locked out, only the webhook or a compliance timeout can move it).
- **The first cut of human approval didn't re-check the charge before executing.** An approval queued against a charge that later got resolved through another path (a real webhook, a compliance stop) would still fire on stale state. Fixed with a re-fetch-and-validate step plus an atomic compare-and-swap on `approvedAt`/`executedAt`, so a stale or double-clicked approval is safely discarded instead of double-executing.
- **`markVerifiedRecovery()` read the payment-link id off the charge *after* the update that clears it.** Functionally the JS variable still held the pre-mutation value (so it happened to work), but it was fragile and, with a `?? undefined` fallback, could silently drop the match filter and update the wrong `RecoveryAction` if the link id were ever null. Rewrote it to capture the link id into a named variable first, look up and update the matching action, and only then mark the charge recovered.
- **A multi-day retry/backoff sequence can't play out in a 5-minute demo.** Added a single-row virtual clock (`SimClock`) that the policy engine reads instead of `Date.now()`, with a "fast-forward N days" control on the dashboard, and a curated 6-case guided scenario (see above) so a judge doesn't have to hunt through a random 120-row batch to see every path exercised.

## Known limitations

- `AUTO_RETRY` can never be VERIFIED — Razorpay has no API to trigger or confirm a recurring-charge retry, so that lever's outcome is always SIMULATED.
- The synthetic batch generator doesn't set `razorpaySubscriptionId`, so seeded charges can never receive a real `payment.failed` webhook — only charges created from a real webhook (or manually wired to a real subscription id) can.
- No authentication on the dashboard — it's a local demo tool, not a multi-tenant product.
