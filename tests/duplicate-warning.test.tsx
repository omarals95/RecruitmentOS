import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DuplicateWarning,
  duplicateQuery,
  type DuplicateLookup,
  type DuplicateMatch,
} from "../src/components/workspace/duplicate-warning";
import { requestJson } from "../src/components/workspace/client";

const match = (
  id: string,
  name: string,
  matches: string[] = ["email"],
): DuplicateMatch => ({
  id,
  name,
  email: "amira.fictional@example.test",
  phone: "",
  matches,
});
const render = (lookup: DuplicateLookup, excludeId?: string) =>
  renderToStaticMarkup(
    <DuplicateWarning lookup={lookup} excludeId={excludeId} />,
  );
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("duplicateQuery", () => {
  it("returns null without a complete email or seven phone digits", () => {
    expect(duplicateQuery("", "")).toBeNull();
    expect(duplicateQuery(undefined, null)).toBeNull();
    expect(duplicateQuery("amira@", "")).toBeNull();
    expect(duplicateQuery("", "+971 50 1")).toBeNull();
  });

  it("includes a valid email, trimmed", () => {
    expect(duplicateQuery(" amira.fictional@example.test ", "")).toEqual({
      email: "amira.fictional@example.test",
    });
  });

  it("includes a phone with at least seven digits, trimmed", () => {
    expect(duplicateQuery("", " +971 50 12 ")).toEqual({
      phone: "+971 50 12",
    });
  });

  it("includes both when both qualify and drops the one that does not", () => {
    expect(
      duplicateQuery("amira.fictional@example.test", "+971-50-123-4567"),
    ).toEqual({
      email: "amira.fictional@example.test",
      phone: "+971-50-123-4567",
    });
    expect(duplicateQuery("amira@", "+971-50-123-4567")).toEqual({
      phone: "+971-50-123-4567",
    });
    expect(duplicateQuery("amira.fictional@example.test", "123")).toEqual({
      email: "amira.fictional@example.test",
    });
  });
});

describe("DuplicateWarning", () => {
  const states: [string, DuplicateLookup][] = [
    ["idle", { status: "idle" }],
    ["checking", { status: "checking" }],
    ["error", { status: "error", message: "Fictional failure." }],
    ["none", { status: "result", matches: [], limited: false }],
    [
      "matches",
      {
        status: "result",
        matches: [match("c-1", "Amira Fictional", ["email", "phone"])],
        limited: false,
      },
    ],
    [
      "limited",
      {
        status: "result",
        matches: Array.from({ length: 20 }, (_, index) =>
          match(`c-${index}`, `Fictional ${index}`),
        ),
        limited: true,
      },
    ],
  ];

  it.each(states)(
    "labels the area, announces the summary and has no merge or confirm controls (%s)",
    (_, lookup) => {
      const markup = render(lookup);
      expect(markup).toContain("Possible duplicates</h3>");
      expect(markup).toMatch(/<section[^>]*aria-labelledby="([^"]+)"/);
      const labelledBy = markup.match(/aria-labelledby="([^"]+)"/)![1];
      expect(markup).toContain(`<h3 id="${labelledBy}"`);
      expect(markup.match(/role="status"/g)).toHaveLength(1);
      expect(markup).not.toContain("<button");
      expect(markup).not.toContain('type="checkbox"');
      expect(markup).not.toContain("<input");
      expect(markup).not.toContain("<select");
      expect(text(markup)).not.toMatch(/\bmerge\b/i);
    },
  );

  it("explains when the check runs while idle", () => {
    expect(text(render({ status: "idle" }))).toContain(
      "Possible duplicates are checked once a complete email or a phone number with at least seven digits is entered.",
    );
  });

  it("shows a checking message", () => {
    expect(text(render({ status: "checking" }))).toContain(
      "Checking for possible duplicates…",
    );
  });

  it("shows a non-blocking error", () => {
    const content = text(
      render({ status: "error", message: "Fictional failure." }),
    );
    expect(content).toContain("Possible duplicates could not be checked.");
    expect(content).toContain("Fictional failure.");
    expect(content).toContain("You can still save this candidate.");
  });

  it("says that no match does not prove the candidate is new", () => {
    const content = text(
      render({ status: "result", matches: [], limited: false }),
    );
    expect(content).toContain(
      "No team candidate has this exact email or phone.",
    );
    expect(content).toContain("does not prove the candidate is new");
    expect(content).toContain("different contact details");
    expect(render({ status: "result", matches: [], limited: false })).toMatch(
      /<p role="status">No team candidate/,
    );
  });

  it("lists matches as new-tab links with what matched, outside the status", () => {
    const markup = render({
      status: "result",
      matches: [
        match("c/1", "Amira Fictional", ["email", "phone"]),
        match("c-2", " ", ["phone"]),
      ],
      limited: false,
    });
    const content = text(markup);
    expect(content).toContain(
      "2 team candidates share this email or phone. Review them before saving. Nothing is merged or blocked automatically.",
    );
    expect(markup).toContain('href="/app/candidates/c%2F1"');
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(
      'Amira Fictional<span class="sr-only"> (opens in a new tab)</span></a>',
    );
    expect(content).toContain("email and phone match");
    expect(content).toContain(
      "Unnamed candidate (opens in a new tab) — phone match",
    );
    const status = markup.match(/<p role="status">([\s\S]*?)<\/p>/)![1];
    expect(status).not.toContain("<a");
  });

  it("never lists or counts the record being edited", () => {
    const markup = render(
      {
        status: "result",
        matches: [match("self", "Alex Example"), match("c-2", "Sam Fictional")],
        limited: false,
      },
      "self",
    );
    const content = text(markup);
    expect(content).toContain("1 other team candidate shares this email");
    expect(markup).not.toContain("Alex Example");
    expect(markup).not.toContain("/app/candidates/self");
    expect(markup).toContain("Sam Fictional");

    const onlySelf = text(
      render(
        {
          status: "result",
          matches: [match("self", "Alex Example")],
          limited: false,
        },
        "self",
      ),
    );
    expect(onlySelf).toContain(
      "No other team candidate has this exact email or phone.",
    );
    expect(onlySelf).toContain("does not prove the candidate is new");
    expect(onlySelf).not.toContain("Alex Example");
  });

  it("says when more matches exist than are listed", () => {
    const markup = render(states[5][1]);
    const content = text(markup);
    expect(content).toContain("More than 20 possible matches");
    expect(content).toContain("only some are listed here");
    expect(content).toContain("search the Candidates directory");
    expect(markup.match(/<li>/g)).toHaveLength(20);
  });
});

describe("requestJson data-changed event", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips the event for the duplicate lookup and keeps it for writes", async () => {
    const target = new EventTarget();
    const events: string[] = [];
    target.addEventListener("recruitmentos:data-changed", (event) =>
      events.push((event as CustomEvent<{ path: string }>).detail.path),
    );
    vi.stubGlobal("window", target);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [], limited: false })),
    );

    await requestJson("fictional-team", "/api/v1/candidates/duplicates", {
      method: "POST",
      body: JSON.stringify({ email: "amira.fictional@example.test" }),
    });
    expect(events).toEqual([]);

    await requestJson("fictional-team", "/api/v1/candidates", {
      method: "POST",
      body: JSON.stringify({ data: { name: "Amira Fictional" } }),
    });
    expect(events).toEqual(["/api/v1/candidates"]);
  });
});
