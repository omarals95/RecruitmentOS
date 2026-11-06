"use client";

import { useRef, useState } from "react";
import { storeCv, withUploadLock, type UploadTicket } from "./cv-transfer";

type UploadResponse = {
  data: { id: string; status: string };
  upload: UploadTicket | null;
};
async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      body?.error?.message ||
        "The request could not be completed. Your selected file is retained; try again.",
    );
  return body as T;
}

/**
 * Reserves the candidate's CV upload under `clientUploadId`, then stores the bytes and completes
 * once through `storeCv`, so a Blob PUT refused after a lost response is still completed. A ready
 * replay returns no ticket: nothing is sent and nothing is completed.
 */
export async function uploadCandidateCv({
  teamId,
  candidateId,
  file,
  clientUploadId,
  onPhase,
  fetchImpl = fetch,
}: {
  teamId: string;
  candidateId: string;
  file: File;
  clientUploadId: string;
  onPhase: (phase: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const headers = { "Content-Type": "application/json", "X-Team-Id": teamId };
  onPhase("Preparing secure upload…");
  const ticket = await responseJson<UploadResponse>(
    await fetchImpl(
      `/api/v1/candidates/${encodeURIComponent(candidateId)}/cvs/uploads`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          originalName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          clientUploadId,
        }),
      },
    ),
  );
  if (!ticket.upload) return;
  onPhase("Uploading CV…");
  await storeCv(
    ticket.upload,
    file,
    async () => {
      onPhase("Checking document format…");
      return responseJson(
        await fetchImpl(
          `/api/v1/cvs/uploads/${encodeURIComponent(ticket.data.id)}/complete`,
          { method: "POST", headers },
        ),
      );
    },
    undefined,
    fetchImpl,
  );
}

export function CvUpload({
  candidateId,
  teamId,
  storageConfigured,
  onComplete,
}: {
  candidateId: string;
  teamId: string;
  /** From the server capability; false shows the setup-required state before any file is chosen. */
  storageConfigured: boolean;
  onComplete?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const clientUploadId = useRef("");
  const input = useRef<HTMLInputElement>(null);
  const busy = Boolean(phase);

  async function upload() {
    if (!file || busy) return;
    setError("");
    setSuccess("");
    if (file.size < 1 || file.size > 10 * 1024 * 1024) {
      setError("Choose a CV between 1 byte and 10 MiB.");
      return;
    }
    const refused = await withUploadLock(() => send(file), navigator.locks);
    if (refused) setError(refused);
  }

  async function send(file: File) {
    clientUploadId.current ||= crypto.randomUUID();
    try {
      await uploadCandidateCv({
        teamId,
        candidateId,
        file,
        clientUploadId: clientUploadId.current,
        onPhase: setPhase,
      });
      setSuccess(
        "CV uploaded. Format checks passed; this does not mean the document has been scanned for malware.",
      );
      setFile(null);
      clientUploadId.current = "";
      if (input.current) input.current.value = "";
      onComplete?.();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The upload did not finish. Try again with the selected file.",
      );
    } finally {
      setPhase("");
    }
  }

  if (!storageConfigured)
    return (
      <section className="cv-upload" aria-label="Upload candidate CV">
        <strong>CV uploads are not set up yet.</strong>
        <p className="muted">
          Attaching CV files needs file storage that an administrator has to
          finish setting up. You can still add and edit this candidate&apos;s
          details.
        </p>
      </section>
    );
  return (
    <section className="cv-upload" aria-label="Upload candidate CV">
      <label htmlFor={`cv-upload-${candidateId}`}>Attach a CV</label>
      <p className="muted">
        PDF, Word, Pages, JPG or PNG · maximum 10 MiB · private team storage
      </p>
      <input
        ref={input}
        id={`cv-upload-${candidateId}`}
        type="file"
        accept=".pdf,.doc,.docx,.pages,.jpg,.jpeg,.jfif,.png"
        disabled={busy}
        onChange={(event) => {
          setFile(event.target.files?.[0] ?? null);
          clientUploadId.current = "";
          setError("");
          setSuccess("");
        }}
      />
      <button
        className="button button-primary"
        type="button"
        disabled={!file || busy}
        onClick={upload}
      >
        {phase || "Upload CV"}
      </button>
      <div role="status" aria-live="polite">
        {success}
      </div>
      {error && (
        <div role="alert" className="form-error">
          {error} {file && "You can retry without selecting the file again."}
        </div>
      )}
    </section>
  );
}
