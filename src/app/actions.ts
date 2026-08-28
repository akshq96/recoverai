"use server";

import { revalidatePath } from "next/cache";
import { generateSyntheticBatch, generateGuidedScenario } from "@/lib/synthetic-data";
import { runBatch, approvePendingAction } from "@/lib/policy-engine";
import { advanceSimClock, resetSimClock } from "@/lib/sim-clock";

export async function seedBatchAction(count: number) {
  await resetSimClock();
  await generateSyntheticBatch(count);
  revalidatePath("/");
}

export async function seedGuidedScenarioAction() {
  await resetSimClock();
  await generateGuidedScenario();
  revalidatePath("/");
}

export async function runBatchAction() {
  await runBatch();
  revalidatePath("/");
}

export async function approveActionAction(actionId: string) {
  await approvePendingAction(actionId);
  revalidatePath("/");
}

export async function advanceClockAction(days: number) {
  await advanceSimClock(days);
  revalidatePath("/");
}
