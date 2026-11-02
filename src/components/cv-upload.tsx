"use client";

import { useRef, useState } from "react";

type UploadResponse = {
  data: { id: string; status: string };
  upload: {
    url: string;
    fields: Record<string, string>;
    expiresAt: string;
  } | null;
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

export function CvUpload({
  candidateId,
  teamId,
  onComplete,
}: {
  candidateId: string;
  teamId: string;
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
    clientUploadId.current ||= crypto.randomUUID();
    const headers = { "Content-Type": "application/json", "X-Team-Id": teamId };
    try {
      setPhase("Preparing secure upload…");
      const ticket = await responseJson<UploadResponse>(
        await fetch(
          `/api/v1/candidates/${encodeURIComponent(candidateId)}/cvs/uploads`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              originalName: file.name,
              mimeType: file.type,
              sizeBytes: file.size,
              clientUploadId: clientUploadId.current,
            }),
          },
        ),
      );
      if (ticket.upload) {
        setPhase("Uploading CV…");
        const form = new FormData();
        for (const [key, value] of Object.entries(ticket.upload.fields))
          form.append(key, value);
        form.append("file", file);
        const sent = await fetch(ticket.upload.url, {
          method: "POST",
          body: form,
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (!sent.ok)
          throw new Error(
            `Private storage did not accept the upload (HTTP ${sent.status}). Check your connection and try again.`,
          );
        setPhase("Checking document format…");
        await responseJson(
          await fetch(
            `/api/v1/cvs/uploads/${encodeURIComponent(ticket.data.id)}/complete`,
            { method: "POST", headers },
          ),
        );
      }
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
