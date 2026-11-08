import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../src/components/ui/dialog";
import { humanError, requestJson } from "../src/components/workspace/client";
import {
  CandidateErased,
  CandidateErasedView,
  CandidateErasureDialogView,
  CandidateErasureSection,
  erasedMessage,
} from "../src/components/workspace/candidate-erasure";
import { formatDate } from "../src/components/workspace/helpers";

// Fictional candidate only; the components are rendered without a browser.
const NAME = "Zephyrine Quillfeather";
type ViewProps = Parameters<typeof CandidateErasureDialogView>[0];
const props = (overrides: Partial<ViewProps> = {}): ViewProps => ({
  name: NAME,
  typed: "",
  busy: false,
  error: "",
  ids: { description: "erase-what", input: "erase-input", name: "erase-name" },
  onTyped: () => {},
  onCancel: () => {},
  onConfirm: () => {},
  ...overrides,
});
const dialog = (overrides: Partial<ViewProps> = {}) =>
  renderToStaticMarkup(<CandidateErasureDialogView {...props(overrides)} />);
/** Text buttons in document order; the icon-only close button has no text label. */
const buttons = (markup: string) =>
  [...markup.matchAll(/<button([^>]*)>([^<]+)<\/button>/g)].map(
    ([, attributes, label]) => ({ attributes, label }),
  );
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

describe("Permanently erase candidate section", () => {
  it("is shown to owners only, after an explanation, with a danger button", () => {
    const markup = renderToStaticMarkup(
      <CandidateErasureSection role="owner" onStart={() => {}} />,
    );
    expect(markup).toContain(
      '<h2 id="candidate-erasure-title">Permanently erase candidate</h2>',
    );
    expect(text(markup)).toContain(
      "For data-protection requests only. This removes the candidate, their applications, interviews, offers, onboarding, comments, CV files and every member's follow-up notes, and cannot be undone. To keep the record but hide it, archive it instead.",
    );
    expect(buttons(markup)).toEqual([
      {
        attributes: ' type="button" class="button danger"',
        label: "Permanently erase candidate",
      },
    ]);
    for (const role of ["admin", "recruiter", "viewer", null])
      expect(
        renderToStaticMarkup(
          <CandidateErasureSection role={role} onStart={() => {}} />,
        ),
        String(role),
      ).toBe("");
  });
});

describe("typed erasure confirmation", () => {
  it("is a labelled alertdialog that says what is removed, kept and not covered", () => {
    const markup = dialog();
    const opening = /<dialog[^>]*>/.exec(markup)![0];
    expect(opening).toContain('role="alertdialog"');
    expect(opening).toContain('aria-describedby="erase-what"');
    const heading = /aria-labelledby="([^"]+)"/.exec(opening)![1];
    expect(markup).toContain(
      `<h2 id="${heading}">Permanently erase ${NAME}?</h2>`,
    );
    const described = text(
      /<div id="erase-what"[\s\S]*?<\/div>/.exec(markup)![0],
    );
    expect(described).toBe(
      "Removed: candidate details, applications, interviews, offers, onboarding and checklist items, comments, every member's follow-up notes and shortlist, CV files and AI suggestion records. Kept: tasks (unlinked from this candidate), activity entries without personal details, and a record of who erased the candidate and when. Not covered: CSV exports already downloaded are not affected. Ask whoever downloaded them to delete their copies.",
    );
    expect(markup).toContain(
      '<label for="erase-input">Type the candidate&#x27;s name to confirm</label>',
    );
    expect(markup).toMatch(
      /<input id="erase-input"[^>]*aria-describedby="erase-name"/,
    );
    expect(markup).toContain(
      `<small id="erase-name" class="muted">Name: <strong>${NAME}</strong></small>`,
    );
  });

  it("starts on Cancel and enables Permanently erase only for the exact trimmed name", () => {
    const [cancel, confirm] = buttons(dialog());
    expect(cancel.label).toBe("Cancel");
    expect(cancel.attributes).toContain("autofocus");
    expect(confirm.label).toBe("Permanently erase");
    expect(confirm.attributes).toContain('class="button danger"');
    for (const typed of [
      "",
      "   ",
      "Zephyrine",
      "zephyrine quillfeather",
      `${NAME}.`,
    ])
      expect(buttons(dialog({ typed }))[1].attributes, typed).toContain(
        "disabled",
      );
    for (const typed of [NAME, `  ${NAME}  `])
      expect(buttons(dialog({ typed }))[1].attributes, typed).not.toContain(
        "disabled",
      );
  });

  it("cancels on Escape and the close button through the dialog, and on Cancel", () => {
    const onCancel = vi.fn();
    const tree = CandidateErasureDialogView(props({ onCancel }));
    expect(isValidElement(tree) && tree.type).toBe(Dialog);
    // Dialog calls onClose for Escape (its cancel event) and for its close button.
    (tree.props as { onClose: () => void }).onClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the request in progress and keeps every control still", () => {
    const markup = dialog({ typed: NAME, busy: true });
    expect(/<dialog[^>]*>/.exec(markup)![0]).toContain('aria-busy="true"');
    const [cancel, confirm] = buttons(markup);
    expect(confirm.label).toBe("Erasing…");
    expect(confirm.attributes).toContain("disabled");
    expect(cancel.attributes).toContain("disabled");
    expect(markup).toMatch(/<input id="erase-input"[^>]*disabled=""/);
  });

  describe("server answers", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("shows a 400 message in an alert inside the open dialog", async () => {
      const message = "Type the candidate's name exactly as shown to confirm.";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            {
              error: {
                code: "erasure_confirmation_mismatch",
                message,
                correlationId: "fictional-correlation",
              },
            },
            { status: 400 },
          ),
        ),
      );
      const error = await requestJson<unknown>(
        "fictional-team",
        "/api/v1/candidates/00000000-0000-4000-8000-000000000001/erasure",
        { method: "POST", body: JSON.stringify({ confirmName: "Zephyrine" }) },
      ).then(
        () => "",
        (caught: unknown) => humanError(caught),
      );
      expect(error).toBe(message);
      const markup = dialog({ typed: "Zephyrine", error });
      const alert = /<p class="notice error" role="alert">([^<]*)<\/p>/.exec(
        markup,
      );
      expect(alert?.[1].replace(/&#x27;/g, "'")).toBe(message);
      expect(markup.indexOf(alert![0])).toBeLessThan(
        markup.indexOf("</dialog>"),
      );
      expect(dialog()).not.toContain('role="alert"');
    });

    it("replaces the profile with a status, the CV storage sentence and Back to candidates", () => {
      // The text the status receives after mount, rendered through the view.
      const erased = (cvStorage: {
        deleted: number;
        waiting: number;
        deleteAfter: string | null;
      }) =>
        renderToStaticMarkup(
          <CandidateErasedView
            message={erasedMessage({
              erasureId: "00000000-0000-4000-8000-0000000000e1",
              alreadyErased: false,
              cvStorage,
            })}
          />,
        );
      const status = (markup: string) =>
        text(
          /<p class="notice success" role="status" tabindex="-1">[^<]*<\/p>/.exec(
            markup,
          )![0],
        );
      const deleted = erased({ deleted: 1, waiting: 0, deleteAfter: null });
      expect(status(deleted)).toBe(
        "Candidate permanently erased. Their CV files were deleted from storage.",
      );
      expect(deleted).toMatch(
        /<a class="text-link" href="\/app\/candidates">Back to candidates<\/a>/,
      );
      const deleteAfter = "2026-11-07T10:25:00.000Z";
      expect(status(erased({ deleted: 0, waiting: 2, deleteAfter }))).toBe(
        `Candidate permanently erased. 2 CV file(s) will be deleted from storage by the next CV storage cleanup after ${formatDate(deleteAfter, true)}.`,
      );
      expect(
        status(erased({ deleted: 0, waiting: 0, deleteAfter: null })),
      ).toBe("Candidate permanently erased.");
      for (const markup of [
        deleted,
        erased({ deleted: 0, waiting: 0, deleteAfter: null }),
      ]) {
        expect(markup).not.toContain("<dialog");
        expect(markup).not.toContain("Permanently erase candidate");
      }
    });

    it("renders the success status empty and focusable first, so its text is announced", () => {
      const markup = renderToStaticMarkup(
        <CandidateErased
          result={{
            erasureId: "00000000-0000-4000-8000-0000000000e1",
            alreadyErased: false,
            cvStorage: { deleted: 1, waiting: 0, deleteAfter: null },
          }}
        />,
      );
      expect(markup).toContain(
        '<p class="notice success" role="status" tabindex="-1"></p>',
      );
      expect(markup).not.toContain("Candidate permanently erased.");
      expect(markup).toMatch(
        /<a class="text-link" href="\/app\/candidates">Back to candidates<\/a>/,
      );
    });
  });
});
