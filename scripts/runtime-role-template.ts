/**
 * The split runtime role template and the grant matrix it declares. The evidence script and the
 * tests read the expected privileges from here, so the template stays the only source of them.
 */
import { readFile } from "node:fs/promises";

export const runtimeRoleNames = {
  data: "recruitmentos_data",
  identity: "recruitmentos_identity",
} as const;

export type RoleMatrix = {
  attributes: Record<string, boolean>;
  database: string[];
  schemas: Record<string, string[]>;
  tables: Record<string, string[]>;
  execute: string[];
};

/** The reviewed split runtime role template, read unmodified. */
export function readRuntimeRoleTemplate(): Promise<string> {
  return readFile(
    new URL(
      "../infrastructure/postgres-split-runtime-roles.sql",
      import.meta.url,
    ),
    "utf8",
  );
}

const attributeKeywords: Record<string, [string, boolean]> = {
  LOGIN: ["rolcanlogin", true],
  NOLOGIN: ["rolcanlogin", false],
  SUPERUSER: ["rolsuper", true],
  NOSUPERUSER: ["rolsuper", false],
  INHERIT: ["rolinherit", true],
  NOINHERIT: ["rolinherit", false],
  CREATEROLE: ["rolcreaterole", true],
  NOCREATEROLE: ["rolcreaterole", false],
  CREATEDB: ["rolcreatedb", true],
  NOCREATEDB: ["rolcreatedb", false],
  REPLICATION: ["rolreplication", true],
  NOREPLICATION: ["rolreplication", false],
  BYPASSRLS: ["rolbypassrls", true],
  NOBYPASSRLS: ["rolbypassrls", false],
};

function unreadable(reason: string): never {
  throw new Error(`The runtime role template cannot be read: ${reason}.`);
}

/**
 * Every role the template creates, with the attributes it creates them with and every privilege it
 * grants them. A GRANT or CREATE ROLE this parser cannot read, such as WITH GRANT OPTION or a
 * parameter, type or language grant, is an error, never skipped; so is ALTER ROLE or DATABASE.
 */
export function templateGrantMatrix(
  template: string,
): Record<string, RoleMatrix> {
  const sql = template.replace(/--[^\n]*/g, "");
  if (/\bALTER (ROLE|USER|DATABASE)\b/.test(sql))
    unreadable("a role or database setting");
  const matrix: Record<string, RoleMatrix> = {};
  const roles = [...sql.matchAll(/\bCREATE ROLE (\w+) ([A-Z ]+);/g)];
  if (roles.length !== (sql.match(/\bCREATE ROLE\b/g) ?? []).length)
    unreadable("an unrecognised CREATE ROLE");
  for (const [, role, options] of roles) {
    const attributes = Object.fromEntries(
      options
        .trim()
        .split(/\s+/)
        .map((keyword) => attributeKeywords[keyword] ?? unreadable(keyword)),
    );
    if (Object.keys(attributes).length !== 7)
      unreadable(`${role} does not set every role attribute`);
    matrix[role] = {
      attributes,
      database: [],
      schemas: {},
      tables: {},
      execute: [],
    };
  }
  const grants = [
    ...sql.matchAll(
      /\bGRANT ([A-Z]+(?:, [A-Z]+)*) ON (DATABASE|SCHEMA|TABLE|FUNCTION) (%I|[\w."]+(?:\([\w, ]*\))?) TO (\w+(?:, \w+)*)(?=;|')/g,
    ),
  ];
  if (grants.length !== (sql.match(/\bGRANT\b/g) ?? []).length)
    unreadable("an unrecognised GRANT");
  for (const [, list, kind, object, grantees] of grants) {
    const privileges = list.split(", ");
    for (const role of grantees.split(", ")) {
      const entry = matrix[role] ?? unreadable(`a grant to ${role}`);
      if (kind === "DATABASE") entry.database.push(...privileges);
      else if (kind === "SCHEMA")
        (entry.schemas[object] ??= []).push(...privileges);
      else if (kind === "TABLE")
        (entry.tables[object] ??= []).push(...privileges);
      else if (list === "EXECUTE")
        entry.execute.push(object.replaceAll(", ", ","));
      else unreadable(`${list} on function ${object}`);
    }
  }
  const names = Object.keys(matrix).sort();
  if (names.join() !== Object.values(runtimeRoleNames).sort().join())
    unreadable("it must create exactly the two runtime roles");
  for (const entry of Object.values(matrix)) {
    entry.database.sort();
    entry.execute.sort();
    for (const map of [entry.schemas, entry.tables])
      for (const privileges of Object.values(map)) privileges.sort();
  }
  return matrix;
}
