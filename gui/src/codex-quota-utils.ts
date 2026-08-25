export interface AccountQuota {
  weeklyPercent?: number;
  fiveHourPercent?: number;
  /** Codex WHAM sub-day window; only 18,000 seconds is rendered as the 5-hour limit. */
  shortPercent?: number;
  monthlyPercent?: number;
  weeklyResetAt?: number;
  fiveHourResetAt?: number;
  shortResetAt?: number;
  shortWindowSeconds?: number;
  monthlyResetAt?: number;
  customWindows?: { label: string; percent: number; resetAt?: number }[];
  resetCredits?: number;
  updatedAt: number;
}

export function isThirtyDayOnlyPlan(plan: string | null | undefined): boolean {
  const normalized = plan?.trim().toLowerCase();
  return normalized === "go" || normalized === "free";
}

export function normalizeQuotaForPlan(quota: AccountQuota | null, plan: string | null | undefined): AccountQuota | null {
  if (!quota || !isThirtyDayOnlyPlan(plan)) return quota;
  return {
    ...(quota.monthlyPercent !== undefined ? { monthlyPercent: quota.monthlyPercent } : {}),
    ...(quota.monthlyResetAt !== undefined ? { monthlyResetAt: quota.monthlyResetAt } : {}),
    ...(quota.resetCredits !== undefined ? { resetCredits: quota.resetCredits } : {}),
    updatedAt: quota.updatedAt,
  };
}
