// Screens of a kind schema (architecture §1.4, §14.6): the one lookup by record type and action, and
// the one notion of a shown and a mandatory field, used by the server and the client alike. Pure,
// and it imports ./config for types only, so config.ts and field-types.ts can import it.
import type { KindSchemaBody } from "./config";

export type Screen = KindSchemaBody["screens"][number];
export type ScreenAction = Screen["action"];
export type ScreenGroup = Screen["groups"][number];
export type ScreenEntry = ScreenGroup["fields"][number];

/**
 * The key of a screen within its kind schema: the action for a default (untyped) screen, else the
 * type and the action. With the body's kind it is the screen key of architecture §14.6.
 */
export function screenKey(screen: { type?: string; action: ScreenAction }) {
  return screen.type ? `${screen.type}/${screen.action}` : screen.action;
}

/**
 * The screen of a record of `typeId` for `action`: the screen of that type, else the default screen
 * of the action. Every valid body has a default create, edit and view screen; a transition screen
 * may have neither, and then there is none.
 */
export function screenFor(
  body: Pick<KindSchemaBody, "screens">,
  typeId: string | null,
  action: Exclude<ScreenAction, "transition">,
): Screen;
export function screenFor(
  body: Pick<KindSchemaBody, "screens">,
  typeId: string | null,
  action: ScreenAction,
): Screen | undefined;
export function screenFor(
  body: Pick<KindSchemaBody, "screens">,
  typeId: string | null,
  action: ScreenAction,
): Screen | undefined {
  return (
    (typeId === null
      ? undefined
      : body.screens.find(
          (screen) => screen.type === typeId && screen.action === action,
        )) ??
    body.screens.find(
      (screen) => screen.type === undefined && screen.action === action,
    )
  );
}

/** The screen's groups in order, each with its shown entries in order: hidden entries are left out. */
export function shownGroups(screen: Screen): ScreenGroup[] {
  return screen.groups.map((group) => ({
    ...group,
    fields: group.fields.filter((entry) => !entry.hidden),
  }));
}

/**
 * The keys a screen shows, in group and entry order. A field is not shown when the screen does not
 * list it or lists it hidden.
 */
export function shownKeys(screen: Screen): string[] {
  return shownGroups(screen).flatMap((group) =>
    group.fields.map((entry) => entry.key),
  );
}

/**
 * The mandatory keys of a screen, in screen order: its shown entries whose field is not archived
 * and is required or flagged mandatory on the screen.
 */
export function mandatoryKeys(
  body: Pick<KindSchemaBody, "fields">,
  screen: Screen,
): string[] {
  const fields = new Map(body.fields.map((field) => [field.key, field]));
  return shownGroups(screen).flatMap((group) =>
    group.fields.flatMap((entry) => {
      const field = fields.get(entry.key);
      return field &&
        !(!field.system && field.archived) &&
        (field.required || entry.mandatory)
        ? [entry.key]
        : [];
    }),
  );
}
