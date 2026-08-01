/**
 * GBP Insights — PARKED pending Google's restricted-access approval
 * (Dan: application submitted under the milo-test project).
 *
 * Once access lands: OAuth connect URL per gym (owner one-click, not configuration),
 * then location metrics (calls, directions, profile views) via Business Profile
 * Performance API flow into site_metrics like GSC/GA4.
 */
export interface GbpStatus {
  available: false;
  reason: string;
}

export function gbpStatus(): GbpStatus {
  return {
    available: false,
    reason:
      "Google Business Profile APIs are restricted-access — approval application pending. Places-API ratings/review metrics run in the meantime.",
  };
}
