"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import {
  type RecordDto,
  type ResourceName,
  type ReferenceField,
} from "@/domain/records";
import { useApi, useWorkspace } from "./client";
import {
  CandidateErased,
  CandidateErasureDialog,
  CandidateErasureSection,
  forgetErasedCandidate,
  type CandidateErasureResult,
} from "./candidate-erasure";
import { dataOf } from "./helpers";
import { useReadyTiming } from "./speed-log";
import { candidateProfileRequests } from "./tab-requests";
import { RecordEditor } from "./editor";
import { Loading, LoadError, RecordDetail } from "./records-screen";

export function CandidateProfile({ id }: { id: string }) {
  const { team, role } = useWorkspace();
  const result = useApi<{ data: RecordDto }>(candidateProfileRequests(id)[0]);
  useReadyTiming("candidate.open", !!result.data);
  const [erasing, setErasing] = useState(false);
  const [erased, setErased] = useState<CandidateErasureResult | null>(null);
  const [editor, setEditor] = useState<{
    resource: ResourceName;
    record?: RecordDto;
    references?: Partial<Record<ReferenceField, string>>;
    prefill?: Record<string, unknown>;
  } | null>(null);
  if (erased)
    return (
      <div className="stack">
        <h1 className="sr-only">Candidate profile</h1>
        <CandidateErased result={erased} />
      </div>
    );
  return (
    <div className="stack">
      <h1 className="sr-only">Candidate profile</h1>
      <div>
        <Link href="/app/candidates" className="text-link">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to candidates
        </Link>
      </div>
      {result.refreshing && (
        <p className="muted small-text" role="status">
          Refreshing candidate details. Your open tabs and drafts are retained.
        </p>
      )}
      {result.error && result.data && (
        <div className="notice error" role="alert">
          The latest details could not be refreshed: {result.error} Your open
          draft is retained.{" "}
          <button className="button secondary small" onClick={result.refresh}>
            Retry refresh
          </button>
        </div>
      )}
      {!result.data && result.error ? (
        <LoadError message={result.error} retry={result.refresh} />
      ) : result.loading ? (
        <Loading />
      ) : (
        result.data && (
          <RecordDetail
            key={id}
            record={result.data.data}
            inline
            onClose={() => {}}
            onEdit={() =>
              setEditor({ resource: "candidates", record: result.data!.data })
            }
            onRefresh={result.refresh}
            onCreate={(resource, references, prefill) =>
              setEditor({ resource, references, prefill })
            }
            onUpdated={(record) => result.setData({ data: record })}
          />
        )
      )}{" "}
      {result.data && (
        <CandidateErasureSection role={role} onStart={() => setErasing(true)} />
      )}
      {erasing && result.data && (
        <CandidateErasureDialog
          candidateId={id}
          name={String(dataOf(result.data.data).name ?? "")}
          onCancel={() => setErasing(false)}
          onErased={(outcome) => {
            setErasing(false);
            setErased(outcome);
            if (team) forgetErasedCandidate(team.id, id);
          }}
        />
      )}
      {editor && (
        <RecordEditor
          {...editor}
          onClose={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            result.refresh();
          }}
        />
      )}
    </div>
  );
}
