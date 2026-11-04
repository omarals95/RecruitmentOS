# Private Blob CV storage: proposed security design

**Status: implemented locally behind a fake client and a real but unwired client; Blob CV uploads and downloads remain disabled.** The protocol below is wired into the reservation, completion, manifest and chunk routes, the browser uploader and downloader, and the legacy importer, and is tested against an in-memory fake client with a synthetic signer (`tests/cv-blob-transfer.test.ts`). A real client built on the official `@vercel/blob` 2.8.2 SDK (`src/lib/vercel-blob-client.ts`) passes the same gateway contract cases as the fake against a stub provider (`tests/blob-client-contract.test.ts`); only tests and the live verification script build it. `getStorage` still refuses Blob and never builds a Blob gateway, and live provider evidence is outstanding. The existing S3 implementation validates an object and pins subsequent reads to its immutable S3 version. Vercel Blob signed GETs do not provide an equivalent documented version identifier. A private store or a no-overwrite upload setting alone does not prove that a later download returns the validated bytes.

The approach below is a candidate for equivalent **download integrity**, not equivalent durability or availability: if a Blob object is replaced or deleted, the application would reject the download rather than retrieve the earlier version. No part of this document enables the provider. A complete implementation, security review, automated tests, and synthetic end-to-end testing against the actual provider are required before reconsidering the guard.

## Proposed upload and validation

1. Authenticate the user or scoped API token; authorize the team, candidate and upload action server-side. Enforce CSRF/origin checks for cookie-authenticated requests. Use separate Preview and Production stores and database credentials.
2. In a database transaction, lock team usage, enforce file and byte quotas, create an unguessable, unique object pathname and pending upload record, and reserve the declared exact file size. Limit retries and issuance. Keep the signed capability out of logs, URLs retained as records, and error messages.
3. Issue a short-lived, private, path-specific PUT capability that permits only the expected content type, rejects sizes above the reserved size, and explicitly disables overwrites and random pathname changes. It must not permit delete, list or reads. Bind the capability and any callback to this reservation. Vercel documents a maximum upload size constraint, not an exact minimum, so completion must check the actual size.
4. At completion, authenticate and authorize again, lock the pending record and check its expiry and status. Read the complete object once from private Blob with caching disabled, applying an abort timeout and a strict 10 MiB bound while reading. Require the exact reserved byte count and expected media type. Validate the file against the existing format rules, and compute SHA-256 over the **same complete bytes** that were validated. Never treat a client-supplied hash or content type as validation. Verify callback signatures if callbacks are used; a callback alone must not mark an upload complete.
5. While enforcing a single pending-to-ready transition, atomically record the verified hash and exact size alongside the tenant, candidate and pathname and convert the reservation to committed usage. Conflicting completion, rejection, expiry or retries must have deterministic, idempotent behavior. A failed or interrupted validation remains unavailable for download and must not free physical quota prematurely.

No-overwrite protects the normal upload path, but it does not stop a privileged actor from deleting or replacing an object. The hash is needed even when overwrite is prohibited. File-format validation is not malware scanning.

## Proposed download

On every chunk request, authenticate and authorize the current principal for the ready CV and its team. Fetch the whole private object without cache, enforce its recorded exact size and 10 MiB bound, and calculate SHA-256 over the bytes actually read. Compare it to the trusted database hash **before returning any file bytes**. A missing object, incomplete stream, incorrect length or hash mismatch fails closed. Return attachment-safe content headers and private/no-store caching; do not send a direct presigned Blob GET URL to a caller.

Vercel documents a 4.5 MB maximum Function response body. For the existing 10 MiB CV allowance, an application download protocol could return chunks of at most 4 MiB. Each independently authorized chunk request must re-read and verify the **entire** object before returning its slice (it stream-hashes the whole object and keeps only the requested slice in memory); the client assembles the chunks only after all succeed. Exact chunk indices, bounds and total size must be checked server-side, and client memory, cancellation, error handling, browser compatibility and API-token clients must be addressed. Never stream an unverified prefix or assume that a previous request proves the current Blob bytes are unchanged. This design increases reads, latency and transfer usage.

## Physical storage quota blocker

Database reservations alone do not bound actual Blob usage if an abandoned upload remains stored after the reservation is released. Cleanup must retain the quota charge until a rejected or expired object's deletion is confirmed and no valid upload capability can recreate it; it must be retried safely and reconciled with stored objects.

There is an unresolved race: the public documentation reviewed does not establish whether a PUT started before its signed URL expires can finish after expiration, or supply a firm maximum in-flight lifetime. Deleting after the expiry time alone could be followed by a late completion. Before claiming a hard physical quota, establish a provider-enforced one-shot or cancellation mechanism, or a documented in-flight bound with a suitable delayed cleanup and ongoing reconciliation. If that cannot be established, report quota as a logical application limit rather than a hard Blob storage or billing cap and keep the provider disabled under the current requirements.

A conservative alternative to investigate is to **never release or reuse the reservation or pathname of any issued upload ticket**, including abandoned tickets, unless the provider can establish that no upload remains in flight. This sacrifices capacity and can let abandoned tickets exhaust a team's allowance. It could bound allocation only if synthetic live tests and provider guarantees establish that each issued capability atomically creates at most one object, cannot overwrite it, cannot bypass its maximum size or create multipart leftovers, and that paths are never reused. It also requires a global account/store allocation across all teams and control over other writers. Tests alone do not prove undocumented behavior. This alternative has not been implemented or verified, and does not establish a hard billing limit.

## Required evidence before enabling

- Persist each CV's storage provider and store binding alongside its validated reference; explicitly preserve existing S3 references and fail closed if the configured provider or store does not match. The current global provider setting cannot safely distinguish existing S3 version IDs from future Blob digests. **Binding implemented locally** (migration `0007_blob_allocation_schema.sql`): each reference stores provider, environment and store, with the S3 VersionId and the Blob SHA-256 and size in separate typed columns. A mismatch returns `409 CV_STORAGE_BINDING_MISMATCH` before any storage call, and pre-`0007` S3 references are preserved but refused until re-bound. **Blob completion implemented locally behind a fake client**: it records the server-computed SHA-256 and exact size of the validated bytes.
- Update and test the browser uploader, legacy importer, API contract and narrowly scoped content security policy for any new Blob PUT and chunked-download protocol. Authenticate and authorize every chunk, including token scope checks and revocation, and bound provider read time and concurrency. **Implemented locally behind a fake client:**
  - Reservations return a tagged `upload` (`s3-form-v1` or `blob-put-v1`); the browser uploader, bulk import (`src/components/cv-transfer.ts`) and the importer (`scripts/legacy/apply.ts`) switch on that tag and never infer it from a hostname.
  - The CSP `connect-src` lists only the configured provider's upload hosts: the path-scoped `https://vercel.com/api/blob/` only when `CV_STORAGE_PROVIDER` is `blob` or `vercel-blob`, the S3 host patterns only for `s3`, and neither for any other value (`next.config.ts`, `tests/csp.test.ts`). Blob stays disabled either way.
  - OpenAPI documents both upload variants, `downloadProtocol`, and `GET /api/v1/cvs/{id}/manifest` and `/chunks?index=N`.
  - Every chunk request reauthorizes through `runApi` and `withTeam`, reads the whole object under one 15 s deadline that also bounds opening it, and releases at most 4 MiB only after the full digest matches. Tests cover replacement and deletion between chunks and token revocation mid-download.
  - Chunk reads stream-hash the whole object and keep only the requested slice (`readVerifiedBlobSlice` in `src/lib/blob-integrity.ts`), so a chunk request holds at most 4 MiB instead of the full 10 MiB object; completion still reads the full object once for format validation (`tests/storage-blob-integrity.test.ts`).
  - Provider reads are capped per server instance at 2 per team (`MAX_BLOB_READS_PER_TEAM`) and 8 per store (`MAX_BLOB_READS_PER_STORE`) in `src/lib/blob-storage.ts`. A read over either cap fails at once with 503 `STORAGE_UNAVAILABLE` and makes no provider call, and a refused completion stays pending (`tests/cv-blob-transfer.test.ts`, "bounded provider reads"). The caps are placeholders until hosted measurement and do not coordinate across instances.
  - Every stream the provider opens is read to the end or closed, including one that opens after the deadline and one refused for a size or MIME mismatch before it is read.
  - Live provider evidence is outstanding (see below).
- Unit and integration tests for authorization, team and environment isolation, exact upload path and constraints, retries, signed-ticket replay, concurrent completion, reservation accounting and all rejection paths.
- Replace, delete, recreate and mutate objects at every boundary between head, read, validation, commit and download. Verify no changed or partial bytes are returned, including across separate chunk requests.
- Test truncated, oversized and malformed files, invalid callback signatures, chunk bounds, concurrent expiry, interruption, cleanup failures, delayed uploads and orphan reconciliation using only synthetic documents.
- Verify the actual private Blob signed-upload constraints, OIDC and static-token behavior, consistency, cache bypass and Function payload limits in an isolated protected deployment. A local mock cannot prove provider behavior.
- Review browser and API-token download flows, test files up to 10 MiB, and independently review the implementation. Keep the existing fail-closed provider guard until every requirement and remaining quota race is resolved.

## Live provider verification

`scripts/blob-live-verify.ts` probes the Preview Blob store through the real client and gateway (`issuePutTicket`, `inspectUpload`, `readVerifiedSlice`). It uses only generated fictional bytes under `live-verification/<random-uuid>/`, deletes that prefix afterwards and reports leftovers. It prints one `PASS`, `FAIL` or `OBSERVED` line per check and never prints a token, signed URL or provider error. The checks are:

- `headers`: a PUT with only `content-type` succeeds; if not, whether `x-vercel-blob-access: private` is required.
- `no-overwrite`: a second ticket for the same pathname cannot replace the first bytes.
- `replay`: re-sending a used signed URL is refused.
- `constraints`: a wrong content type and an oversized body are refused and leave no object.
- `late-completion`: whether a PUT started before expiry can finish after it, and that a PUT started after expiry is refused.
- `multipart`: whether `/mpu` accepts the PUT ticket, and whether the size limit holds.
- `deletion`: a deleted object reads as missing, and whether the still-valid ticket can recreate it.

Only the owner runs it, against the Preview store with a Preview read-write token. Agents never run it. It refuses to start without the confirmation flag, a valid store id, a token, or when `VERCEL_ENV` is `production`:

```
BLOB_READ_WRITE_TOKEN=<Preview token> npx tsx scripts/blob-live-verify.ts --confirm-live-preview-blob --store store_<id>
```

Its results are still outstanding. `tests/blob-live-verify.test.ts` covers only the refusals.

References: [Vercel signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls), [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), and [Vercel Function limits](https://vercel.com/docs/functions/limitations).
