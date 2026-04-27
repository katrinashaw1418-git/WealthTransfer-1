// =============================================================================
// Task #294 — Pure helpers shared between the admin / adviser / client fee
// pages. Kept in `shared/` so the same logic is reused on every surface.
//
// nextChargeDate(effectiveDate, frequency)
//   Returns the next calendar date a deduction would be raised against this
//   rule, given its effective date and the consent's deduction cadence. The
//   computation is deliberately simple (calendar arithmetic only — no FX,
//   no business-day shifting) because it is a *forecast* rendered in the
//   "Next charge" column of the rules tables, not the date the engine
//   actually deducts on.
//
// Cadence semantics:
//   monthly    — same day-of-month each month (clamps to last day)
//   quarterly  — same day-of-month, +3 months
//   half_yearly — same day-of-month, +6 months
//   yearly / annually — same day-of-month, +12 months
//   anything else — null (frequency unknown / not yet captured)
//
// If `effectiveDate` itself is in the future, that date IS the next charge.
// =============================================================================

export type FeeFrequency =
  | "monthly"
  | "quarterly"
  | "half_yearly"
  | "yearly"
  | "annually"
  | string
  | null
  | undefined;

function addMonthsClamped(d: Date, months: number): Date {
  const targetMonth = d.getUTCMonth() + months;
  const next = new Date(
    Date.UTC(d.getUTCFullYear(), targetMonth, 1, 0, 0, 0, 0),
  );
  // Last day of the target month — used to clamp e.g. Jan 31 + 1 month → Feb 28/29.
  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();
  next.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return next;
}

function frequencyMonths(freq: FeeFrequency): number | null {
  switch (freq) {
    case "monthly":
      return 1;
    case "quarterly":
      return 3;
    case "half_yearly":
      return 6;
    case "yearly":
    case "annually":
      return 12;
    default:
      return null;
  }
}

export function nextChargeDate(
  effectiveDate: string | Date | null | undefined,
  frequency: FeeFrequency,
  now: Date = new Date(),
): Date | null {
  if (!effectiveDate) return null;
  const months = frequencyMonths(frequency);
  if (months == null) return null;
  const eff =
    effectiveDate instanceof Date ? effectiveDate : new Date(effectiveDate);
  if (Number.isNaN(eff.getTime())) return null;
  // If the effective date is still in the future, it IS the next charge date.
  if (eff.getTime() > now.getTime()) return eff;
  // Otherwise advance by `months` until we land strictly after `now`.
  let next = eff;
  // Cap iterations defensively so a malformed input can't spin forever.
  for (let i = 0; i < 240 && next.getTime() <= now.getTime(); i += 1) {
    next = addMonthsClamped(next, months);
  }
  return next;
}

// Convenience formatter for the "Next charge" cell — returns YYYY-MM-DD or
// "—" when the inputs are insufficient to compute a date.
export function formatNextChargeCell(
  effectiveDate: string | Date | null | undefined,
  frequency: FeeFrequency,
): string {
  const d = nextChargeDate(effectiveDate, frequency);
  if (!d) return "—";
  return d.toISOString().slice(0, 10);
}
