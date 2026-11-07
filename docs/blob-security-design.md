# Private Blob CV storage: security design

**Status: Blob is the hosted CV storage provider through Vercel OIDC, enabled in code (job 030, owner decision DEC-01 of 7 November 2026).** Switch-on needs the owner's environment settings ([deployment §5](deployment.md#5-cv-storage)), migration `0018_blob_storage_enablement.sql` and a rerun of the role template; none of this has been done yet. The protocol below is wired into the reservation, completion, manifest and chunk routes, the browser uploader and downloader, and the legacy importer, and is tested against an in-memory fake client with a synthetic signer (`tests/cv-blob-transfer.test.ts`). For a Blob binding `getStorage` builds the real client on the official `@vercel/blob` 2.8.2 SDK (`src/lib/vercel-blob-client.ts`) in OIDC mode; it passes the same gateway contract cases as the fake against a stub provider in both OIDC and read-write token modes (`tests/blob-client-contract.test.ts`). The owner's live provider results are recorded [below](#live-provider-verification). The S3 implementation validates an object and pins subsequent reads to its immutable S3 version. Vercel Blob signed GETs do not provide an equivalent documented version identifier. A private store or a no-overwrite upload setting alone does not prove that a later download returns the validated bytes.

The approach below gives equivalent **download integrity**, not equivalent durability or availability: if a Blob object is replaced or deleted, the application rejects the download rather than retrieving the earlier version. Independent security review and hosted Preview verification of the OIDC credential are still open.

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

**Resolution (job 030).** The owner's live run (below) refused a PUT started after expiry and a PUT that started before expiry and finished after it, so no valid ticket outlives its reservation's `expires_at`; but a still-valid ticket recreated a deleted object. Cleanup therefore deletes only after `expires_at + 10 min`, keeps the charge retained until `head` confirms the object missing, and repeats the deletion on every later sweep. Quota is reported as an application limit, not a hard Blob storage or billing cap, because multipart can bypass the size limit (see [residual risk](#residual-risk)). The original analysis follows.

There was an unresolved race: the public documentation reviewed does not establish whether a PUT started before its signed URL expires can finish after expiration, or supply a firm maximum in-flight lifetime. Deleting after the expiry time alone could be followed by a late completion. Before claiming a hard physical quota, establish a provider-enforced one-shot or cancellation mechanism, or a documented in-flight bound with a suitable delayed cleanup and ongoing reconciliation. If that cannot be established, report quota as a logical application limit rather than a hard Blob storage or billing cap and keep the provider disabled under the current requirements.

A conservative alternative to investigate is to **never release or reuse the reservation or pathname of any issued upload ticket**, including abandoned tickets, unless the provider can establish that no upload remains in flight. This sacrifices capacity and can let abandoned tickets exhaust a team's allowance. It could bound allocation only if synthetic live tests and provider guarantees establish that each issued capability atomically creates at most one object, cannot overwrite it, cannot bypass its maximum size or create multipart leftovers, and that paths are never reused. It also requires a global account/store allocation across all teams and control over other writers. Tests alone do not prove undocumented behavior. This alternative has not been implemented or verified, and does not establish a hard billing limit.

## Required evidence before enabling

- Persist each CV's storage provider and store binding alongside its validated reference; explicitly preserve existing S3 references and fail closed if the configured provider or store does not match. The current global provider setting cannot safely distinguish existing S3 version IDs from future Blob digests. **Binding implemented locally** (migration `0007_blob_allocation_schema.sql`): each reference stores provider, environment and store, with the S3 VersionId and the Blob SHA-256 and size in separate typed columns. A mismatch returns `409 CV_STORAGE_BINDING_MISMATCH` before any storage call, and pre-`0007` S3 references are preserved but refused until re-bound. **Blob completion implemented locally behind a fake client**: it records the server-computed SHA-256 and exact size of the validated bytes.
- Update and test the browser uploader, legacy importer, API contract and narrowly scoped content security policy for any new Blob PUT and chunked-download protocol. Authenticate and authorize every chunk, including token scope checks and revocation, and bound provider read time and concurrency. **Implemented locally behind a fake client:**
  - Reservations return a tagged `upload` (`s3-form-v1` or `blob-put-v1`); the browser uploader, bulk import (`src/components/cv-transfer.ts`) and the importer (`scripts/legacy/apply.ts`) switch on that tag and never infer it from a hostname.
  - The CSP `connect-src` lists only the configured provider's upload hosts: the path-scoped `https://vercel.com/api/blob/` only when `CV_STORAGE_PROVIDER` is `blob` or `vercel-blob`, the S3 host patterns only for `s3`, and neither for any other value (`next.config.ts`, `tests/csp.test.ts`). An unset provider means Blob.
  - OpenAPI documents both upload variants, `downloadProtocol`, and `GET /api/v1/cvs/{id}/manifest` and `/chunks?index=N`.
  - Every chunk request reauthorizes through `runApi` and `withTeam`, reads the whole object under one 15 s deadline that also bounds opening it, and releases at most 4 MiB only after the full digest matches. Tests cover replacement and deletion between chunks and token revocation mid-download.
  - Chunk reads stream-hash the whole object and keep only the requested slice (`readVerifiedBlobSlice` in `src/lib/blob-integrity.ts`), so a chunk request holds at most 4 MiB instead of the full 10 MiB object; completion still reads the full object once for format validation (`tests/storage-blob-integrity.test.ts`).
  - Provider reads are limited **across server instances** by database leases: 2 per team and 8 per store, through `tenant_context.acquire_blob_read` and `tenant_context.release_blob_read` (migration `0009_blob_read_leases.sql`), called from `src/lib/cvs.ts` around completion and every chunk read. A lease commits before the provider call, is released afterwards whatever the outcome, and expires on its own after 30 s, so a crashed instance frees its slot within one request lifetime. A read over either cap fails at once with 503 `STORAGE_UNAVAILABLE` and makes no provider call, and a refused completion stays pending (`tests/cv-blob-transfer.test.ts`, "bounded provider reads", including leases held by another instance; `tests/cv-allocation-ledger.test.ts` for the role boundary). The caps are fixed in the owner-run helper and are placeholders until hosted measurement.
  - Every stream the provider opens is read to the end or closed, including one that opens after the deadline and one refused for a size or MIME mismatch before it is read.
  - `createVercelBlobClient` refuses to start, before any SDK call, when `VERCEL_BLOB_API_URL` or `NEXT_PUBLIC_VERCEL_BLOB_API_URL` is set, or when `VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API` or `NEXT_PUBLIC_VERCEL_BLOB_PROXY_THROUGH_ALTERNATIVE_API` is present at all, even empty, because the SDK then adds an `x-proxy-through-alternative-api` header to every request (`tests/blob-client-contract.test.ts`).
  - Every storage setup refusal reaches users as the same plain message, "CV storage is not set up yet. Ask an administrator to finish setting it up, then try again." (`STORAGE_SETUP_REQUIRED_MESSAGE`, 503 `STORAGE_SETUP_REQUIRED`). The specific reason, which can name a provider or setting, stays in the code and is not shown (`tests/cvs.test.ts`).
  - The owner's live provider results are recorded below, with the mitigation for each FAIL and OBSERVED item.
- Unit and integration tests for authorization, team and environment isolation, exact upload path and constraints, retries, signed-ticket replay, concurrent completion, reservation accounting and all rejection paths.
- Replace, delete, recreate and mutate objects at every boundary between head, read, validation, commit and download. Verify no changed or partial bytes are returned, including across separate chunk requests.
- Test truncated, oversized and malformed files, invalid callback signatures, chunk bounds, concurrent expiry, interruption, cleanup failures, delayed uploads and orphan reconciliation using only synthetic documents.
- Verify the actual private Blob signed-upload constraints, OIDC and static-token behavior (see [Credentials](#credentials-vercel-oidc-versus-read-write-token) for the chosen credential and what is unverified), consistency, cache bypass and Function payload limits in an isolated protected deployment. A local mock cannot prove provider behavior.
- Review browser and API-token download flows, test files up to 10 MiB, and independently review the implementation. The `provider_disabled` guard was removed in job 030 after the live run and the mitigations below; the hosted OIDC-only credential checks replace it.

## Credentials: Vercel OIDC versus read-write token

**OIDC mode built (job 030).** `createVercelBlobClient({ storeId, oidcToken })` reads the token function before every SDK call and passes `{ oidcToken, storeId }` explicitly, never `token`, so the SDK fallback is never used. `getStorage` builds it for a Blob binding only on Vercel (`oidc_not_hosted` otherwise), refuses with `blob_token_present` while `BLOB_READ_WRITE_TOKEN` is present at all, even empty, and checks the request-context token with the same helper as the AWS path (`assertHostedOidcToken`, then the `getVercelOidcTokenSync()` equality check, `oidc_context_changed`); it never calls the async refresh helper. The client also refuses `blob_token_present` itself in OIDC mode, and `blob_client_invalid` for a malformed store id and the endpoint and proxy overrides (`tests/storage.test.ts`, `tests/blob-client-contract.test.ts`). The static token is refused in hosted environments.

- **Read-write token.** It is long-lived and store-wide: it can read, write, delete and list every object in its store. It sits in an environment variable and has no expiry unless someone rotates it manually. Its store is fixed by the token itself, so `createVercelBlobClient` can check that the token names `storeId`.
- **OIDC.**
  - `@vercel/blob` 2.8.2 supports it through explicit `oidcToken` and `storeId` options (`resolveBlobAuth` in `node_modules/@vercel/blob/dist/chunk-MITTIJDE.cjs`).
  - The token is request-scoped and short-lived, and no Blob secret is stored. This matches how `getStorage` already handles AWS: it reads the request-context `x-vercel-oidc-token`, checks it with `assertHostedOidcToken`, and never calls the async refresh helper.
  - With OIDC, the store is chosen by the `storeId` option, not by the token. Separating Preview and Production stores therefore depends on the provider's project and environment scoping.
  - If the client passes neither `token` nor `oidcToken`, the SDK falls back to its own `getVercelOidcToken()`, which has a refresh path, and then to `BLOB_READ_WRITE_TOKEN`. The client must therefore always pass one explicit credential.
- **Choice.**
  - The hosted credential for enablement is **Vercel OIDC**: the request-context token, an explicit `storeId` equal to `binding.store`, and no `BLOB_READ_WRITE_TOKEN` in any hosted environment.
  - The current explicit read-write token is used only by tests and by the owner's `scripts/blob-live-verify.ts` against the Preview store, because that script runs outside a Vercel request and has no request OIDC token.
  - The OIDC client mode is built (job 030); `getStorage` never builds the token mode.
- **Still unverified.** These need the protected hosted Preview deployment:
  - signed-token issuance (`issueSignedToken`) and private uncached `get` both accept an OIDC token;
  - a Preview deployment's token is refused by the Production store, and by a store not connected to the project;
  - token expiry within a 30 s request is handled.

## Live provider verification

`scripts/blob-live-verify.ts` probes the Preview Blob store through the real client and gateway (`issuePutTicket`, `inspectUpload`, `readVerifiedSlice`). It uses only generated fictional bytes under `live-verification/<random-uuid>/`, deletes that prefix afterwards and reports leftovers. It prints one `PASS`, `FAIL` or `OBSERVED` line per check and never prints a token, signed URL or provider error. The checks are:

- `headers`: a PUT with only `content-type` succeeds; if not, whether `x-vercel-blob-access: private` is required.
- `no-overwrite`: a second ticket for the same pathname cannot replace the first bytes.
- `replay`: re-sending a used signed URL is refused.
- `constraints`: a wrong content type and an oversized body are refused and leave no object.
- `late-completion`: whether a PUT started before expiry can finish after it, and that a PUT started after expiry is refused.
- `multipart`: whether `/mpu` accepts the PUT ticket, and whether the size limit holds.
- `deletion`: a deleted object reads as missing, and whether the still-valid ticket can recreate it.

Only the owner runs it, against the Preview store with a Preview read-write token. Agents never run it. It refuses to start without the confirmation flag, a valid store id, and a read-write token for that same store (the SDK reaches whichever store the token names, so `createVercelBlobClient` refuses a mismatch too), or when `VERCEL_ENV` is `production`. Do not run it with `DEBUG=blob`, which makes the SDK log responses:

```
BLOB_READ_WRITE_TOKEN=<Preview token> npx tsx scripts/blob-live-verify.ts --confirm-live-preview-blob --store store_<id>
```

### Results of the owner's run, 7 November 2026

The owner ran the script against the Preview store on 7 November 2026. Agents did not run it.

- PASS `headers`: a PUT with only `content-type` succeeds.
- PASS `no-overwrite`: a second ticket for the same pathname cannot replace the first bytes.
- PASS `replay`: re-sending a used signed URL is refused.
- PASS oversized single PUT refused.
- PASS PUT started after expiry refused.
- PASS deleted object reads missing.
- PASS cleanup.
- OBSERVED a PUT started before expiry and finished after it was refused (no object).
- FAIL a wrong content type was accepted by the provider.
- FAIL multipart with the PUT ticket bypassed the size limit (oversized parts and completion accepted; uncompleted parts cannot be listed).
- OBSERVED retrying a still-valid ticket after deletion recreated the object.

Mitigations (job 030):

- **Wrong content type accepted (FAIL).** Completion never trusts the provider for type: `inspectUpload` first calls `head` and rejects an object whose content type differs from the reservation without opening it, then compares the `get` content type again and validates the bytes with `validateCvBytes`. The upload becomes `rejected`, its charge stays retained, and the object is deleted after expiry by the cleanup below.
- **Multipart bypassed the size limit (FAIL).** Completion never trusts the provider for size: a `head` size that differs from the reserved size or exceeds 10 MiB is rejected without opening the object, and the read still requires the exact reserved byte count. The cleanup's list pass also deletes any object of the team's prefix whose size no longer matches its ready reference, and objects with no upload row. Uncompleted parts remain a residual risk (below).
- **PUT finishing after expiry refused (OBSERVED).** A 10 MiB PUT must finish within its ticket, so tickets stay capped at 300 s; Blob reservations are shortened from 60 to 15 minutes (`BLOB_RESERVATION_MS` in `src/lib/cvs.ts`). Cleanup still waits 10 minutes after the reservation's `expires_at` as a conservative grace.
- **A still-valid ticket recreated a deleted object (OBSERVED).** A rejected, expired or abandoned upload's object is deleted only once its last ticket expired: every ticket for a pathname ends at or before its row's `expires_at`, and deletion waits until `expires_at + 10 min`. The row pass of `src/lib/blob-reconcile.ts` deletes the object, confirms it missing with `head`, and only then calls `tenant_context.release_blob_charge`, which itself refuses an upload expired less than 10 minutes ago; a failed delete or an object still present keeps the charge retained, and every later sweep repeats the deletion. A released row whose object reappears is deleted again by the list pass. The sweep runs best effort on each new Blob reservation (row pass only, at most 5 rows) and fully through the owner or admin `POST /api/v1/cvs/storage-reconciliation`; it reports counts only.

### Residual risk

Multipart with a valid PUT ticket can bypass the size limit. Uncompleted parts cannot be listed or deleted by the application. A completed oversized or wrong-type object is rejected at completion and deleted only after its ticket expired. Store usage can therefore exceed the ledger until the provider discards uncompleted parts, and team limits and store budgets are application limits, not hard provider or billing caps.

Still unverified on a hosted Preview deployment: that `issueSignedToken`, private uncached `get`, `head`, `del` and `list` accept the request OIDC token; that a Preview deployment's token is refused by the Production store and by a store not connected to the project; and that token expiry within a 30 s request is handled.

`tests/blob-live-verify.test.ts` covers only the refusals.

References: [Vercel signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls), [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), and [Vercel Function limits](https://vercel.com/docs/functions/limitations).
