import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../src/components/workspace/client";
import {
  RecordCard,
  RecordDetail,
} from "../src/components/workspace/records-screen";
import {
  referenceFields,
  safeExternalUrl,
  type RecordDto,
  type RecordKind,
} from "../src/domain/records";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Recruiter",
    email: "recruiter@example.test",
    twoStepEnabled: false,
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "recruiter",
  environment: "Local development",
  canCreateTeam: true,
};
const SCRIPT = "<script>alert(1)</script>";
const IMAGE = "<img src=x onerror=alert(1)>";
const HOSTILE_URLS = [
  "javascript:alert(1)",
  " JaVaScRiPt:alert(1)",
  "\tjavascript:alert(1)",
  "data:text/html,x",
  "vbscript:x",
  "/relative",
];

function record(kind: RecordKind, data: Record<string, unknown>): RecordDto {
  return {
    ...Object.fromEntries(referenceFields.map((field) => [field, null])),
    id: "00000000-0000-4000-8000-0000000000a1",
    kind,
    version: 1,
    data,
    legacyId: null,
    createdAt: "2026-11-01T09:00:00.000Z",
    updatedAt: "2026-11-01T09:00:00.000Z",
    archivedAt: null,
    createdBy: "fictional-user",
    privateOwnerId: null,
  } as unknown as RecordDto;
}
const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <WorkspaceProvider value={workspace}>{node}</WorkspaceProvider>,
  );
const detail = (value: RecordDto) =>
  render(
    <RecordDetail
      record={value}
      onClose={() => {}}
      onEdit={() => {}}
      onRefresh={() => {}}
      onCreate={() => {}}
      onUpdated={() => {}}
    />,
  );
const decode = (value: string) =>
  value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** No element, attribute or link comes from the data; only its escaped text does. */
function expectInert(markup: string) {
  const tags = markup.match(/<[a-z][^>]*>/gi) ?? [];
  expect(tags.filter((tag) => /^<(script|img)\b/i.test(tag))).toEqual([]);
  expect(tags.filter((tag) => /\sonerror\s*=/i.test(tag))).toEqual([]);
  // Browsers ignore whitespace and control characters around a scheme, so drop them first.
  const hrefs = [...markup.matchAll(/\shref="([^"]*)"/gi)].map((match) =>
    [...decode(match[1])]
      .filter((char) => char.trim() && char.charCodeAt(0) > 0x1f)
      .join("")
      .toLowerCase(),
  );
  for (const href of hrefs)
    expect(href).not.toMatch(/^(javascript|data|vbscript):/);
  expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(markup).toContain("&lt;img src=x onerror=alert(1)&gt;");
}

describe("untrusted record values render as text", () => {
  it("links a meeting URL only when it is absolute http or https", () => {
    expect(safeExternalUrl("https://example.test/x")).toBe(
      "https://example.test/x",
    );
    expect(safeExternalUrl("http://example.test/meet?id=1")).toBe(
      "http://example.test/meet?id=1",
    );
    for (const value of [...HOSTILE_URLS, "", null, undefined, 42])
      expect(safeExternalUrl(value), String(value)).toBeNull();
  });

  it("shows a candidate's hostile name, email and notes as escaped text in detail and card views", () => {
    const candidate = record("candidate", {
      name: `Fictional ${SCRIPT}`,
      email: `${IMAGE}@example.test`,
      phone: "+971 50 000 0000",
      jobTitle: IMAGE,
      sourceNotes: `${SCRIPT} ${IMAGE} javascript:alert(1)`,
      skills: [SCRIPT, IMAGE],
      reviewStatus: "Needs review",
    });
    for (const markup of [
      detail(candidate),
      render(<RecordCard record={candidate} onOpen={() => {}} />),
    ])
      expectInert(markup);
  });

  for (const meetingUrl of HOSTILE_URLS)
    it(`renders no link for the meeting URL ${JSON.stringify(meetingUrl)}`, () => {
      const markup = detail(
        record("interview", {
          title: `Fictional interview ${SCRIPT}`,
          startAt: "2026-11-02T09:00:00.000Z",
          minutes: 60,
          interviewer: IMAGE,
          location: "",
          meetingUrl,
          status: "Scheduled",
          notes: `${SCRIPT} ${IMAGE}`,
        }),
      );
      expectInert(markup);
      expect(markup).not.toContain("Open meeting link");
    });

  it("links a valid https meeting URL", () => {
    const markup = detail(
      record("interview", {
        title: `Fictional interview ${SCRIPT}`,
        startAt: "2026-11-02T09:00:00.000Z",
        minutes: 60,
        interviewer: IMAGE,
        location: "",
        meetingUrl: "https://meet.example.test/fictional",
        status: "Scheduled",
        notes: "",
      }),
    );
    expectInert(markup);
    expect(markup).toContain('href="https://meet.example.test/fictional"');
    expect(markup).toContain("Open meeting link");
  });
});
