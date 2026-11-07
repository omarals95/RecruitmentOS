"use client";

import { SpeedInsights } from "@vercel/speed-insights/next";
import { scrubSpeedEvent, speedInsightsSampleRate } from "@/lib/route-pattern";

/**
 * Vercel Speed Insights (free tier): Web Vitals with scrubbed route patterns, sent only to the
 * same-origin /_vercel/speed-insights endpoints. Development renders nothing, because the package
 * would load a remote debug script there. The sample rate is read at build time.
 */
export function SpeedInsightsReporter() {
  if (process.env.NODE_ENV !== "production") return null;
  return (
    <SpeedInsights
      sampleRate={speedInsightsSampleRate(
        process.env.NEXT_PUBLIC_SPEED_INSIGHTS_SAMPLE_RATE,
      )}
      beforeSend={scrubSpeedEvent}
    />
  );
}
