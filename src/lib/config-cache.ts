import { createHash } from "node:crypto";
import type { ConfigType } from "@/domain/config";

/** The instance cache bound: 8 MiB of body text, in UTF-8 bytes. */
export const CONFIG_CACHE_BYTES = 8_388_608;

/** One current published version as tenant_context.install returns it; body is the stored jsonb text. */
export type ConfigDocumentRow = {
  versionId: string;
  objectId: string;
  type: ConfigType;
  key: string;
  number: number;
  bodySha256: string;
  body: string;
};
/** A verified published version; the body is the parsed, deep-frozen object. */
export type ConfigDocument = Omit<ConfigDocumentRow, "body"> & {
  body: Readonly<Record<string, unknown>>;
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The hex SHA-256 of the exact body text must be the stored body_sha256, and the body an object. */
function verify(row: ConfigDocumentRow): ConfigDocument {
  const text = row.body;
  if (
    typeof text !== "string" ||
    createHash("sha256").update(text, "utf8").digest("hex") !== row.bodySha256
  )
    throw new Error("A configuration body did not match its hash.");
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("A configuration body is not an object.");
  const { versionId, objectId, type, key, number, bodySha256 } = row;
  return Object.freeze({
    versionId,
    objectId,
    type,
    key,
    number,
    bodySha256,
    body: deepFreeze(body as Record<string, unknown>),
  });
}

/**
 * Published bodies by version id. They never change once published, so an entry is never stale;
 * which version is current comes from install every transaction. Least recently used entries go
 * first when the byte total would pass the cap, and an evicted body is simply returned again.
 */
export class ConfigBodyCache {
  readonly cap: number;
  // Map order is use order: the first entry is the least recently used.
  readonly #entries = new Map<
    string,
    { document: ConfigDocument; bytes: number }
  >();
  #bytes = 0;

  constructor(cap = CONFIG_CACHE_BYTES) {
    this.cap = cap;
  }

  /** The UTF-8 bytes of every cached body text. */
  get bytes(): number {
    return this.#bytes;
  }

  /** The cached version ids, least recently used first. */
  ids(): string[] {
    return [...this.#entries.keys()];
  }

  /** Every cached document by version id, without counting as use. */
  entries(): Map<string, ConfigDocument> {
    return new Map(
      [...this.#entries].map(([id, entry]) => [id, entry.document]),
    );
  }

  /**
   * Verifies every row before storing any; one that fails throws and nothing is stored. A body
   * larger than the cap is returned but not stored.
   */
  add(...rows: ConfigDocumentRow[]): ConfigDocument[] {
    const verified = rows.map((row) => ({
      document: verify(row),
      bytes: Buffer.byteLength(row.body, "utf8"),
    }));
    for (const entry of verified) {
      this.#remove(entry.document.versionId);
      if (entry.bytes > this.cap) continue;
      this.#entries.set(entry.document.versionId, entry);
      this.#bytes += entry.bytes;
      for (const id of this.#entries.keys()) {
        if (this.#bytes <= this.cap) break;
        this.#remove(id);
      }
    }
    return verified.map((entry) => entry.document);
  }

  /** Marks a cached entry as just used; an entry evicted meanwhile stays out. */
  use(versionId: string): void {
    const entry = this.#entries.get(versionId);
    if (!entry) return;
    this.#entries.delete(versionId);
    this.#entries.set(versionId, entry);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  #remove(versionId: string) {
    const entry = this.#entries.get(versionId);
    if (!entry) return;
    this.#entries.delete(versionId);
    this.#bytes -= entry.bytes;
  }
}

/** The application's instance cache; tests pass their own instances. */
export const configBodyCache = new ConfigBodyCache();
