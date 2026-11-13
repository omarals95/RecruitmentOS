import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { DEFAULT_KIND_SCHEMAS } from "@/domain/config-defaults";
import {
  kindSchemaBodySchema,
  type ConfigurableKind,
  type KindSchemaBody,
} from "@/domain/config";
import type { CustomField, CustomFieldType } from "@/domain/field-types";
import type { ScreenAction } from "@/domain/screens";

// Kind schemas as an admin writer would publish them until R2b-09 adds a route.
/** The fictional default workspace every seeded team joins. */
export const WORKSPACE = "00000000-0000-4000-a000-000000000001";
/** A fictional custom field definition; a fresh key unless one is given. */
export const customField = (
  label: string,
  type: CustomFieldType,
  extra: Record<string, unknown> = {},
  key: string = randomUUID(),
) =>
  ({
    key,
    system: false,
    label,
    type,
    required: false,
    ...extra,
  }) as CustomField;
/**
 * The kind's default body plus the given custom fields, each listed at the end of every default
 * screen's group unless `screens` names the custom keys of a screen's action.
 */
export const kindBody = (
  kind: ConfigurableKind,
  custom: CustomField[],
  screens: Partial<Record<ScreenAction, string[]>> = {},
) => {
  const body = structuredClone(
    DEFAULT_KIND_SCHEMAS[kind].body,
  ) as KindSchemaBody;
  body.fields.push(...custom);
  for (const screen of body.screens)
    screen.groups[0].fields.push(
      ...(screens[screen.action] ?? custom.map((field) => field.key)).map(
        (key) => ({ key }),
      ),
    );
  return body;
};
/**
 * A fictional candidate body whose create, edit and view screens list every other key in an
 * unlabelled group, then a "Fictional contact" group with phone before email, the given flags on
 * email, and employer hidden (R2b-07).
 */
export const contactBody = (email: { mandatory?: boolean } = {}) => {
  const body = structuredClone(
    DEFAULT_KIND_SCHEMAS.candidate.body,
  ) as KindSchemaBody;
  for (const screen of body.screens)
    screen.groups = [
      {
        fields: screen.groups[0].fields.filter(
          ({ key }) => !["phone", "email", "employer"].includes(key),
        ),
      },
      {
        label: "Fictional contact",
        fields: [
          { key: "phone" },
          { key: "email", ...email },
          { key: "employer", hidden: true },
        ],
      },
    ];
  return kindSchemaBodySchema.parse(body);
};
/**
 * Publishes the body as the kind's next current version of the default workspace, or with `draft`
 * leaves it as the object's draft for publishConfigVersion; its version id. The client must already
 * run as a role that bypasses row security, and only the schema owner may insert a published row.
 */
export async function insertKindSchema(
  client: Pick<PGlite, "query">,
  createdBy: string,
  body: KindSchemaBody,
  { draft = false } = {},
): Promise<string> {
  const text = JSON.stringify(kindSchemaBodySchema.parse(body));
  const objectId =
    (
      await client.query<{ id: string }>(
        "SELECT id FROM app.config_objects WHERE workspace_id = $1 AND team_id IS NULL AND type = 'kind-schema' AND key = $2",
        [WORKSPACE, body.kind],
      )
    ).rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        "INSERT INTO app.config_objects(workspace_id, type, key, created_by) VALUES ($1, 'kind-schema', $2, $3) RETURNING id",
        [WORKSPACE, body.kind, createdBy],
      )
    ).rows[0].id;
  const versionId = (
    await client.query<{ id: string }>(
      draft
        ? "INSERT INTO app.config_versions(object_id, workspace_id, body) VALUES ($1, $2, $3::jsonb) RETURNING id"
        : "INSERT INTO app.config_versions(object_id, workspace_id, state, number, body, published_at) SELECT $1, $2, 'published', coalesce(max(number), 0) + 1, $3::jsonb, now() FROM app.config_versions WHERE object_id = $1 RETURNING id",
      [objectId, WORKSPACE, text],
    )
  ).rows[0].id;
  await client.query(
    draft
      ? "UPDATE app.config_objects SET draft_version_id = $1 WHERE id = $2"
      : "UPDATE app.config_objects SET current_version_id = $1 WHERE id = $2",
    [versionId, objectId],
  );
  return versionId;
}
