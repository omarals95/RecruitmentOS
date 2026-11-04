import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  resourceToKind,
  referencesByKind,
  type ResourceName,
} from "../../src/domain/records";
import { readSourceBytes } from "./files";
import {
  RESOURCE_ORDER,
  text,
  type MigrationPlan,
  type PlannedRecord,
  type Row,
  type Source,
} from "./plan";

interface Existing extends Row {
  id: string;
  legacyId: string | null;
  version: number;
  data: Row;
  archivedAt: string | null;
  importMeta?: Row;
}
export interface ApplyOptions {
  apiUrl: string;
  teamId: string;
  token: string;
  updateExisting?: boolean;
  uploadAttempt?: number;
  fetchImpl?: typeof fetch;
  onProgress?: (message: string) => void;
}
export interface ApplyResult {
  created: number;
  updated: number;
  skipped: number;
  statesImported: number;
  notificationsImported: number;
  notificationsUnchangedOrStale: number;
  uploadsReady: number;
  uploadsSkipped: number;
  conflicts: string[];
  errors: { location: string; code: string; message: string }[];
  mapping: Record<string, string>;
  sourceMapping: Record<string, string>;
  notificationMapping: Record<string, string>;
  notificationReads: Row[];
}
const key = (resource: ResourceName, id: string) => `${resource}:${id}`;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function validateApiUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new Error(
      "API URL must be a clean HTTPS origin without credentials, a path, query or fragment.",
    );
  if (
    url.protocol !== "https:" &&
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  )
    throw new Error("HTTP is allowed only for a local development server.");
  return url.origin;
}
function uploadId(source: Source, attempt: number): string {
  const hex = hash([
    source.id,
    source.relativePath,
    source.sizeBytes,
    source.mtimeMs,
    attempt,
  ]);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export class ImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ImportError(
      "INVALID_RESPONSE",
      "Server returned an unexpected JSON object.",
    );
  return value as Row;
}
function assertId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      value,
    )
  )
    throw new ImportError(
      "INVALID_RESPONSE",
      "Server returned an invalid record identifier.",
    );
  return value;
}
function awsTicket(urlValue: unknown): string {
  if (typeof urlValue !== "string")
    throw new ImportError("INVALID_UPLOAD_TICKET", "Missing S3 upload URL.");
  const url = new URL(urlValue);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !/(?:^|\.)s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com(?:\.cn)?$/i.test(
      url.hostname,
    )
  )
    throw new ImportError(
      "INVALID_UPLOAD_TICKET",
      "Upload target is not an HTTPS AWS S3 endpoint.",
    );
  return url.href;
}
/** Only an exact private Vercel Blob PUT for this file; the server's tag, never the host, decides. */
function blobTicket(
  ticket: Row,
  mimeType: string | undefined,
  sizeBytes: number | undefined,
): { url: string; contentType: string } {
  const invalid = () =>
    new ImportError(
      "INVALID_UPLOAD_TICKET",
      "Upload target is not a Vercel Blob PUT ticket for this exact file.",
    );
  if (typeof ticket.url !== "string") throw invalid();
  let url: URL;
  try {
    url = new URL(ticket.url);
  } catch {
    throw invalid();
  }
  const headers = ticket.headers;
  if (
    typeof mimeType !== "string" ||
    url.protocol !== "https:" ||
    url.origin !== "https://vercel.com" ||
    url.pathname !== "/api/blob/" ||
    url.username ||
    url.password ||
    ticket.url.includes("#") ||
    ticket.method !== "PUT" ||
    !headers ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    Object.keys(headers).length !== 1 ||
    (headers as Row)["content-type"] !== mimeType ||
    !Number.isSafeInteger(sizeBytes) ||
    ticket.maxBytes !== sizeBytes
  )
    throw invalid();
  return { url: ticket.url, contentType: mimeType };
}

export async function applyPlan(
  plan: MigrationPlan,
  options: ApplyOptions,
): Promise<ApplyResult> {
  if (plan.issues.some((issue) => issue.severity === "error"))
    throw new Error(
      "Resolve every dry-run error before applying this migration.",
    );
  const api = validateApiUrl(options.apiUrl);
  if (!options.token || !options.teamId)
    throw new Error("API_TOKEN and --team are required when applying.");
  const fetcher = options.fetchImpl || fetch;
  const result: ApplyResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    statesImported: 0,
    notificationsImported: 0,
    notificationsUnchangedOrStale: 0,
    uploadsReady: 0,
    uploadsSkipped: 0,
    conflicts: [],
    errors: [],
    mapping: {},
    sourceMapping: {},
    notificationMapping: {},
    notificationReads: plan.notificationReads,
  };
  let lastRequest = 0;
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<Row> => {
    if (!path.startsWith("/api/v1/") || path.includes("://"))
      throw new Error("Only RecruitmentOS API paths are allowed.");
    if (
      body !== undefined &&
      Buffer.byteLength(JSON.stringify(body), "utf8") > 262144
    )
      throw new ImportError(
        "PAYLOAD_TOO_LARGE",
        "The complete API payload exceeds 262144 bytes. No request was sent for this record.",
      );
    // API tokens allow 60 requests/minute. The real importer deliberately stays below that rate.
    if (!options.fetchImpl) {
      const delay = 1100 - (Date.now() - lastRequest);
      if (delay > 0) await new Promise((done) => setTimeout(done, delay));
    }
    lastRequest = Date.now();
    let response: Response;
    try {
      response = await fetcher(`${api}${path}`, {
        method,
        redirect: "error",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${options.token}`,
          "X-Team-Id": options.teamId,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
    } catch {
      throw new ImportError(
        "NETWORK_OUTCOME_UNCERTAIN",
        "The API request did not finish. Rerun with the same source; deterministic idempotency keys and legacy IDs prevent duplicate creates.",
      );
    }
    let payload: Row;
    try {
      payload = object(await response.json());
    } catch {
      throw new ImportError(
        "INVALID_RESPONSE",
        `API returned HTTP ${response.status} without a valid JSON response.`,
      );
    }
    if (!response.ok) {
      const serverError =
        payload.error && typeof payload.error === "object"
          ? object(payload.error)
          : payload;
      const code =
        typeof serverError.code === "string" &&
        /^[a-z0-9_]{1,80}$/i.test(serverError.code)
          ? serverError.code
          : `HTTP_${response.status}`;
      throw new ImportError(
        code,
        `API request returned HTTP ${response.status}. Candidate contents and credentials are omitted from this report.`,
      );
    }
    return payload;
  };
  const failure = (location: string, error: unknown) => {
    result.errors.push({
      location,
      code: error instanceof ImportError ? error.code : "IMPORT_ERROR",
      message:
        error instanceof ImportError
          ? error.message
          : "This migration step failed. Check the private source report; no automatic rollback was attempted.",
    });
  };
  const existing = new Map<string, Existing>(),
    targetData = new Map<string, Row>();
  // Enumerate first: no mutation occurs if reading any source resource is forbidden or incomplete.
  for (const resource of RESOURCE_ORDER) {
    let page = 1,
      totalPages = 1;
    while (page <= totalPages) {
      const payload = await request(
          `/api/v1/${resource}?includeArchived=true&pageSize=100&page=${page}`,
        ),
        data = payload.data;
      if (!Array.isArray(data))
        throw new ImportError(
          "INVALID_RESPONSE",
          "Server list response has no data array.",
        );
      for (const raw of data) {
        const row = object(raw),
          id = assertId(row.id);
        if (row.legacyId) {
          const recordKey = key(resource, text(row.legacyId));
          if (existing.has(recordKey))
            throw new ImportError(
              "DUPLICATE_TARGET_LEGACY_ID",
              "The target contains duplicate legacy IDs; migration stopped before creating records.",
            );
          const record = { ...row, id } as Existing;
          existing.set(recordKey, record);
          targetData.set(recordKey, record.data);
          result.mapping[recordKey] = id;
        }
      }
      const pagination = object(payload.pagination);
      totalPages = Number(pagination.totalPages);
      if (
        !Number.isInteger(totalPages) ||
        totalPages < 0 ||
        totalPages > 100000
      )
        throw new ImportError(
          "INVALID_RESPONSE",
          "Server pagination is invalid.",
        );
      page++;
    }
  }
  function payloadFor(record: PlannedRecord): Row {
    const data: Row = { ...record.data },
      payload: Row = {
        data,
        legacyId: record.legacyId,
        importMeta: record.importMeta,
        archived: record.archived,
      };
    for (const [field, link] of Object.entries(record.refs)) {
      const id = result.mapping[key(link.resource, link.legacyId)];
      if (!id)
        throw new ImportError(
          "UNRESOLVED_REFERENCE",
          `Parent ${link.resource}:${link.legacyId} has not been imported.`,
        );
      payload[field] = id;
    }
    if (record.customValues) {
      const values: Row = {};
      for (const [id, value] of Object.entries(record.customValues)) {
        const newId = result.mapping[key("task-fields", id)];
        if (!newId)
          throw new ImportError(
            "UNRESOLVED_CUSTOM_FIELD",
            `Custom field ${id} has not been imported.`,
          );
        values[newId] = value;
      }
      data.customValues = values;
    }
    if (record.resource === "views" && record.importMeta.viewVacancyLegacyId) {
      const id =
        result.mapping[
          key("vacancies", text(record.importMeta.viewVacancyLegacyId))
        ];
      if (!id)
        throw new ImportError(
          "UNRESOLVED_VIEW_VACANCY",
          "Saved view references a vacancy absent from the import.",
        );
      data.query = { ...object(data.query), vacancyId: id };
    }
    return payload;
  }
  for (const record of plan.records) {
    const recordKey = key(record.resource, record.legacyId);
    try {
      const payload = payloadFor(record),
        old = existing.get(recordKey);
      if (old) {
        const refsMatch = Object.keys(record.refs).every(
          (field) => (old[field] ?? null) === (payload[field] ?? null),
        );
        const equal =
          canonical(old.data) === canonical(payload.data) &&
          refsMatch &&
          !!old.archivedAt === record.archived &&
          canonical(old.importMeta || {}) === canonical(record.importMeta);
        if (equal) {
          result.skipped++;
          continue;
        }
        const immutableRefMismatch = Object.entries(
          referencesByKind[resourceToKind[record.resource]],
        ).some(
          ([field, rule]) =>
            rule.immutable && (old[field] ?? null) !== (payload[field] ?? null),
        );
        if (
          !options.updateExisting ||
          record.resource === "comments" ||
          immutableRefMismatch
        ) {
          result.conflicts.push(recordKey);
          if (immutableRefMismatch) delete result.mapping[recordKey];
          continue;
        }
        const patch: Row = { ...payload, version: old.version };
        delete patch.legacyId;
        for (const [field, rule] of Object.entries(
          referencesByKind[resourceToKind[record.resource]],
        ))
          if (rule.immutable) delete patch[field];
        const response = await request(
          `/api/v1/${record.resource}/${old.id}`,
          "PATCH",
          patch,
        );
        const saved = object(response.data);
        assertId(saved.id);
        targetData.set(
          recordKey,
          saved.data ? object(saved.data) : object(payload.data),
        );
        result.updated++;
      } else {
        const response = await request(
            `/api/v1/${record.resource}`,
            "POST",
            payload,
            `legacy_${hash([recordKey, payload])}`,
          ),
          saved = object(response.data);
        result.mapping[recordKey] = assertId(saved.id);
        targetData.set(
          recordKey,
          saved.data ? object(saved.data) : object(payload.data),
        );
        result.created++;
      }
    } catch (error) {
      failure(recordKey, error);
    }
    options.onProgress?.(
      `Records processed: ${result.created + result.updated + result.skipped}; conflicts: ${result.conflicts.length}; errors: ${result.errors.length}`,
    );
  }
  for (const state of plan.states) {
    const location = `private-state:${state.id}`;
    try {
      const id = result.mapping[key("candidates", state.id)];
      if (!id)
        throw new ImportError(
          "UNRESOLVED_CANDIDATE",
          "Personal state candidate was not imported.",
        );
      const current = object(
          (await request(`/api/v1/candidates/${id}/state`)).data,
        ),
        importMeta = {
          legacyUpdatedAt: state.updated,
          legacyCandidateId: state.id,
          ...(state.note !== state.note.trim()
            ? { originalNote: state.note }
            : {}),
        };
      const note = state.note.trim();
      const same =
        current.shortlisted === state.shortlisted &&
        current.status === state.status &&
        current.note === note &&
        canonical(current.importMeta || {}) === canonical(importMeta);
      if (same) continue;
      if (current.version !== 0 && !options.updateExisting) {
        result.conflicts.push(location);
        continue;
      }
      await request(`/api/v1/candidates/${id}/state`, "PATCH", {
        version: current.version,
        shortlisted: state.shortlisted,
        status: state.status,
        note,
        importMeta,
      });
      result.statesImported++;
    } catch (error) {
      failure(location, error);
    }
  }
  const notificationResources: Record<string, ResourceName> = {
    task: "tasks",
    interview: "interviews",
    offer: "offers",
    checklist: "checklist",
    vacancy: "vacancies",
    onboarding: "onboarding",
  };
  const notificationKeys: string[] = [];
  for (const row of plan.notificationReads) {
    const parts = text(row.Key).match(/^([^:]+):([^:]+):(.+)$/),
      resource = parts ? notificationResources[parts[1]] : undefined,
      mapped =
        parts && resource ? result.mapping[key(resource, parts[2])] : undefined;
    let due = parts?.[3] || "";
    if (parts?.[1] === "interview" && mapped) {
      const source = plan.records.find(
          (r) => r.resource === "interviews" && r.legacyId === parts[2],
        ),
        current = targetData.get(key("interviews", parts[2]));
      const instant = text(source?.data.startAt),
        date = instant
          ? new Intl.DateTimeFormat("en-CA", {
              timeZone: "Asia/Dubai",
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
            }).format(new Date(instant))
          : "";
      const sameReadDate =
        due === date ||
        (!Number.isNaN(Date.parse(due)) &&
          new Date(due).toISOString() === instant);
      due = current?.startAt === instant && sameReadDate ? instant : "";
    }
    if (parts && mapped && due) {
      const newKey = `${parts[1]}:${mapped}:${due}`;
      notificationKeys.push(newKey);
      result.notificationMapping[text(row.Key)] = newKey;
    } else {
      result.notificationsUnchangedOrStale++;
      result.errors.push({
        location: `notification:${text(row["Read ID"])}`,
        code: "NOTIFICATION_KEY_NOT_MAPPED",
        message:
          "The old read key did not match an unchanged known reminder. It remains in the private migration report; current reminders stay unread.",
      });
    }
  }
  const uniqueNotifications = [...new Set(notificationKeys)];
  for (let i = 0; i < uniqueNotifications.length; i += 100) {
    try {
      const batch = uniqueNotifications.slice(i, i + 100),
        response = await request("/api/v1/notifications", "POST", {
          keys: batch,
        }),
        updated = Number(response.updated);
      if (!Number.isInteger(updated) || updated < 0 || updated > batch.length)
        throw new ImportError(
          "INVALID_RESPONSE",
          "Notification response did not report a valid updated count.",
        );
      result.notificationsImported += updated;
      result.notificationsUnchangedOrStale += batch.length - updated;
    } catch (error) {
      failure("notification-reads", error);
    }
  }
  const uploadedPhysical = new Map<string, string>();
  for (const source of plan.sources) {
    if (!source.uploadable) {
      result.uploadsSkipped++;
      continue;
    }
    const location = `CV:${source.id}`;
    try {
      const candidateId =
        result.mapping[key("candidates", source.candidateIds[0])];
      if (!candidateId)
        throw new ImportError(
          "UNRESOLVED_CANDIDATE",
          "CV candidate was not imported.",
        );
      const physicalKey = `${candidateId}:${source.relativePath?.toLowerCase()}`,
        prior = uploadedPhysical.get(physicalKey);
      if (prior) {
        result.sourceMapping[source.id] = prior;
        result.uploadsSkipped++;
        continue;
      }
      const metadata = {
        originalName: basename(source.relativePath!),
        mimeType: source.mimeType,
        sizeBytes: source.sizeBytes,
        clientUploadId: uploadId(source, options.uploadAttempt || 1),
        legacySourceId: source.id,
        sourcePath: source.relativePath,
      };
      const initialized = await request(
          `/api/v1/candidates/${candidateId}/cvs/uploads`,
          "POST",
          metadata,
        ),
        cv = object(initialized.data),
        upload = initialized.upload;
      const cvId = assertId(cv.id);
      if (
        cv.candidateId !== candidateId ||
        cv.legacySourceId !== source.id ||
        cv.originalName !== metadata.originalName ||
        cv.mimeType !== metadata.mimeType ||
        cv.sizeBytes !== metadata.sizeBytes
      )
        throw new ImportError(
          "UPLOAD_METADATA_CONFLICT",
          "Server upload metadata did not match the approved source.",
        );
      if (upload === null) {
        if (cv.status !== "ready")
          throw new ImportError(
            "UPLOAD_NOT_READY",
            "Server returned no upload ticket for a CV that is not ready.",
          );
      } else {
        const ticket = object(upload);
        if (ticket.protocol === "s3-form-v1") {
          if (ticket.method !== "POST")
            throw new ImportError(
              "INVALID_UPLOAD_TICKET",
              "S3 upload tickets must use a form POST.",
            );
          const url = awsTicket(ticket.url),
            fields = object(ticket.fields),
            bytes = await readSourceBytes(plan, source),
            form = new FormData();
          for (const [name, value] of Object.entries(fields)) {
            if (typeof value !== "string")
              throw new ImportError(
                "INVALID_UPLOAD_TICKET",
                "S3 form fields must be strings.",
              );
            form.append(name, value);
          }
          form.append(
            "file",
            new Blob([new Uint8Array(bytes)], { type: source.mimeType }),
            metadata.originalName,
          );
          let uploaded: Response;
          try {
            uploaded = await fetcher(url, {
              method: "POST",
              body: form,
              redirect: "error",
              credentials: "omit",
              signal: AbortSignal.timeout(60000),
            });
          } catch {
            throw new ImportError(
              "UPLOAD_OUTCOME_UNCERTAIN",
              "S3 upload did not finish. Rerun to reuse its reservation and complete validation.",
            );
          }
          if (!uploaded.ok)
            throw new ImportError(
              "S3_UPLOAD_FAILED",
              `S3 returned HTTP ${uploaded.status}; no API token was sent to S3.`,
            );
        } else if (ticket.protocol === "blob-put-v1") {
          const target = blobTicket(
              ticket,
              source.mimeType,
              metadata.sizeBytes,
            ),
            bytes = await readSourceBytes(plan, source);
          let uploaded: Response;
          try {
            uploaded = await fetcher(target.url, {
              method: "PUT",
              body: new Uint8Array(bytes),
              headers: { "content-type": target.contentType },
              redirect: "error",
              credentials: "omit",
              signal: AbortSignal.timeout(60000),
            });
          } catch {
            throw new ImportError(
              "UPLOAD_OUTCOME_UNCERTAIN",
              "Blob upload did not finish. Rerun to reuse its reservation and complete validation.",
            );
          }
          if (!uploaded.ok)
            throw new ImportError(
              "BLOB_UPLOAD_FAILED",
              `Private Blob storage returned HTTP ${uploaded.status}; no API token was sent to it.`,
            );
        } else
          throw new ImportError(
            "UNSUPPORTED_UPLOAD_PROTOCOL",
            "The server returned an upload protocol this importer does not support. No CV bytes were sent.",
          );
        const completed = object(
          (await request(`/api/v1/cvs/uploads/${cvId}/complete`, "POST", {}))
            .data,
        );
        if (completed.status !== "ready")
          throw new ImportError(
            "CV_NOT_READY",
            "Server did not validate this CV as ready.",
          );
      }
      result.sourceMapping[source.id] = cvId;
      uploadedPhysical.set(physicalKey, cvId);
      result.uploadsReady++;
    } catch (error) {
      failure(location, error);
    }
    options.onProgress?.(
      `CVs ready: ${result.uploadsReady}; skipped: ${result.uploadsSkipped}; errors: ${result.errors.length}`,
    );
  }
  return result;
}
