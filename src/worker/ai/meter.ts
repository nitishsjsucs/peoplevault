// The neuron meter (SPEC.md section 30.3.6). Before a call the route reserves the call's worst case in D1 `ai_usage`
// with one conditional upsert, which succeeds only while today's total plus the reservation stays within
// AI_DAILY_NEURONS; after the call it settles the reservation to the measured neurons. A failed call keeps its
// reservation (the model may have billed it), so concurrent calls can never take a day past the cap.

export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

/** Reserves `neurons` for one call of `model` today; false when the cap would be passed. `cap` null = unlimited. */
export async function reserve(db: D1Database, day: string, model: string, neurons: number, cap: number | null): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO ai_usage (day, model, neurons, calls)
       SELECT ?1, ?2, ?3, 1 WHERE ?4 IS NULL OR (SELECT COALESCE(SUM(neurons), 0) FROM ai_usage WHERE day = ?1) + ?3 <= ?4
       ON CONFLICT (day, model) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + 1`,
    )
    .bind(day, model, neurons, cap)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Replaces a reservation with the measured neurons (`delta` = measured - reserved, usually negative). */
export async function settle(db: D1Database, day: string, model: string, delta: number): Promise<void> {
  if (delta === 0) return;
  await db.prepare("UPDATE ai_usage SET neurons = MAX(0, neurons + ?3) WHERE day = ?1 AND model = ?2").bind(day, model, delta).run();
}

export interface DayUsage {
  day: string;
  neurons: number;
  calls: number;
  byModel: { model: string; neurons: number; calls: number }[];
}

export async function usageOn(db: D1Database, day: string): Promise<DayUsage> {
  const { results } = await db.prepare("SELECT model, neurons, calls FROM ai_usage WHERE day = ? ORDER BY model").bind(day).all<{ model: string; neurons: number; calls: number }>();
  return { day, neurons: results.reduce((n, r) => n + r.neurons, 0), calls: results.reduce((n, r) => n + r.calls, 0), byModel: results };
}
