// Where a field of a kind schema is used (ADM-29, FLD-015): an ordered list of sources, each giving
// its entries for one field. Pure and client-safe, so the Fields page and its archive confirm share
// it. Screens are the only source today; workflow conditions, templates and notification rules add
// their own source here when they exist, and until then nothing stands in for them.
import type { KindSchemaBody } from "./config";
import type { Screen } from "./screens";

export type WhereUsedSource = "screen";
/** One use of a field: its source and a plain label; hidden when the source lists it hidden. */
export type WhereUsedEntry = {
  source: WhereUsedSource;
  label: string;
  hidden: boolean;
};

const ACTION_LABELS: Record<Screen["action"], string> = {
  create: "Create",
  edit: "Edit",
  view: "View",
  transition: "Transition",
};
/** A screen's plain name: its action, and its record type when it is not the default screen. */
export const screenLabel = (screen: Screen) =>
  `${ACTION_LABELS[screen.action]} screen${screen.type ? ` (type ${screen.type})` : ""}`;

/** Each screen of the body that lists the field, in body order. */
function screenUses(body: KindSchemaBody, key: string): WhereUsedEntry[] {
  return body.screens.flatMap((screen) => {
    const entry = screen.groups
      .flatMap((group) => group.fields)
      .find((item) => item.key === key);
    return entry
      ? [
          {
            source: "screen",
            label: screenLabel(screen),
            hidden: !!entry.hidden,
          },
        ]
      : [];
  });
}

const SOURCES: readonly ((
  body: KindSchemaBody,
  key: string,
) => WhereUsedEntry[])[] = [screenUses];

/** The field's uses, source by source in SOURCES order; empty when nothing uses it. */
export function fieldWhereUsed(
  body: KindSchemaBody,
  key: string,
): WhereUsedEntry[] {
  return SOURCES.flatMap((source) => source(body, key));
}

/** One entry as the page shows it: its label, marked hidden when listed hidden. */
export const whereUsedText = (entry: WhereUsedEntry) =>
  entry.hidden ? `${entry.label} (hidden)` : entry.label;
