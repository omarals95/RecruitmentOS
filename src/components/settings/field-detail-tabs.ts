/**
 * The field detail tabs in order (architecture §14.6, ADM-29); each key is its `?tab=` value. Server
 * pages read it, so it lives outside "use client".
 */
export const FIELD_DETAIL_TABS = [
  { key: "contexts", label: "Contexts & options" },
  { key: "where-used", label: "Where used" },
] as const;
export type FieldDetailTab = (typeof FIELD_DETAIL_TABS)[number]["key"];

/** The tab a `?tab=` value opens: Contexts & options for a missing or unknown key. */
export function fieldDetailTab(value: unknown): FieldDetailTab {
  return FIELD_DETAIL_TABS.find((tab) => tab.key === value)?.key ?? "contexts";
}
