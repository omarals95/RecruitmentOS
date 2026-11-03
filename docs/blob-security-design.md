# Private Blob CV storage: proposed security design

**Status: design only. Blob CV uploads and downloads remain disabled.** The existing S3 implementation validates an object and pins subsequent reads to its immutable S3 version. Vercel Blob signed GETs do not provide an equivalent documented version identifier. A private store or a no-overwrite upload setting alone does not prove that a later download returns the validated bytes.

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

Vercel documents a 4.5 MB maximum Function response body. For the existing 10 MiB CV allowance, an application download protocol could return chunks of at most 4 MiB. Each independently authorized chunk request must re-read and verify the **entire** object before returning its slice; the client assembles the chunks only after all succeed. Exact chunk indices, bounds and total size must be checked server-side, and client memory, cancellation, error handling, browser compatibility and API-token clients must be addressed. Never stream an unverified prefix or assume that a previous request proves the current Blob bytes are unchanged. This design increases reads, latency and transfer usage.

## Physical storage quota blocker

Database reservations alone do not bound actual Blob usage if an abandoned upload remains stored after the reservation is released. Cleanup must retain the quota charge until a rejected or expired object's deletion is confirmed and no valid upload capability can recreate it; it must be retried safely and reconciled with stored objects.

There is an unresolved race: the public documentation reviewed does not establish whether a PUT started before its signed URL expires can finish after expiration, or supply a firm maximum in-flight lifetime. Deleting after the expiry time alone could be followed by a late completion. Before claiming a hard physical quota, establish a provider-enforced one-shot or cancellation mechanism, or a documented in-flight bound with a suitable delayed cleanup and ongoing reconciliation. If that cannot be established, report quota as a logical application limit rather than a hard Blob storage or billing cap and keep the provider disabled under the current requirements.

A conservative alternative to investigate is to **never release or reuse the reservation or pathname of any issued upload ticket**, including abandoned tickets, unless the provider can establish that no upload remains in flight. This sacrifices capacity and can let abandoned tickets exhaust a team's allowance. It could bound allocation only if synthetic live tests and provider guarantees establish that each issued capability atomically creates at most one object, cannot overwrite it, cannot bypass its maximum size or create multipart leftovers, and that paths are never reused. It also requires a global account/store allocation across all teams and control over other writers. Tests alone do not prove undocumented behavior. This alternative has not been implemented or verified, and does not establish a hard billing limit.

## Required evidence before enabling

- Unit and integration tests for authorization, team and environment isolation, exact upload path and constraints, retries, signed-ticket replay, concurrent completion, reservation accounting and all rejection paths.
- Replace, delete, recreate and mutate objects at every boundary between head, read, validation, commit and download. Verify no changed or partial bytes are returned, including across separate chunk requests.
- Test truncated, oversized and malformed files, invalid callback signatures, chunk bounds, concurrent expiry, interruption, cleanup failures, delayed uploads and orphan reconciliation using only synthetic documents.
- Verify the actual private Blob signed-upload constraints, OIDC and static-token behavior, consistency, cache bypass and Function payload limits in an isolated protected deployment. A local mock cannot prove provider behavior.
- Review browser and API-token download flows, test files up to 10 MiB, and independently review the implementation. Keep the existing fail-closed provider guard until every requirement and remaining quota race is resolved.

References: [Vercel signed URLs](https://vercel.com/docs/vercel-blob/vercel-signed-urls), [Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk), and [Vercel Function limits](https://vercel.com/docs/functions/limitations).
