import { prisma } from "./prisma";

export async function getSimTime(): Promise<Date> {
  const clock = await prisma.simClock.upsert({
    where: { id: "singleton" },
    update: {},
    create: { id: "singleton" },
  });
  return clock.currentTime;
}

export async function advanceSimClock(days: number): Promise<Date> {
  const current = await getSimTime();
  const next = new Date(current.getTime() + days * 24 * 60 * 60 * 1000);
  await prisma.simClock.upsert({
    where: { id: "singleton" },
    update: { currentTime: next },
    create: { id: "singleton", currentTime: next },
  });
  return next;
}

export async function resetSimClock(): Promise<Date> {
  const now = new Date();
  await prisma.simClock.upsert({
    where: { id: "singleton" },
    update: { currentTime: now },
    create: { id: "singleton", currentTime: now },
  });
  return now;
}
