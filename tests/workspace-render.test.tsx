import {
  isValidElement,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceProvider } from "../src/components/workspace/client";
import { DisplayModeToggle } from "../src/components/workspace/display-mode-toggle";
import {
  BulkCvImport,
  BulkCvImportDialog,
  RecentImports,
  type CvImportState,
  type RecentImportsPage,
} from "../src/components/workspace/bulk-cv-import";
import {
  BULK_INTAKE_MAX_FILES,
  BULK_INTAKE_RECOVERY_HOURS,
} from "../src/domain/records";
import { ConfirmDialog } from "../src/components/ui/confirm-dialog";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Recruiter",
    email: "recruiter@example.test",
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "recruiter",
  environment: "Local development",
};
const buttonSvg = (markup: string, label: string) =>
  new RegExp(`aria-label="${label}"[^>]*>(<svg[\\s\\S]*?</svg>)`).exec(
    markup,
  )?.[1];

describe("display mode toggle", () => {
  it("uses a distinct board icon and hides every icon from assistive technology", () => {
    const markup = renderToStaticMarkup(
      <DisplayModeToggle board mode="board" onChange={() => {}} />,
    );
    const board = buttonSvg(markup, "Board view");
    const cards = buttonSvg(markup, "Card view");
    expect(board).toBeDefined();
    expect(cards).toBeDefined();
    expect(board).not.toBe(cards);
    const svgs = markup.match(/<svg[^>]*>/g) ?? [];
    expect(svgs).toHaveLength(3);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
  });
});

describe("confirm dialog", () => {
  it("is a labelled, described alertdialog that starts on Cancel", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog
        title="Revoke token?"
        message="Revoke “Fictional token”? Integrations using this token will lose access."
        confirmLabel="Revoke token"
        destructive
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    const dialog = /<dialog[^>]*>/.exec(markup)![0];
    expect(dialog).toContain('role="alertdialog"');
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(dialog)![1];
    const describedBy = /aria-describedby="([^"]+)"/.exec(dialog)![1];
    expect(markup).toContain(`<h2 id="${labelledBy}">Revoke token?</h2>`);
    expect(markup).toContain(
      `<p id="${describedBy}">Revoke “Fictional token”? Integrations using this token will lose access.</p>`,
    );
    const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)];
    const cancel = buttons.findIndex((match) => match[1] === "Cancel");
    const confirm = buttons.findIndex((match) => match[1] === "Revoke token");
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(cancel).toBeLessThan(confirm);
    expect(buttons[cancel][0]).toContain("autofocus");
    expect(buttons[confirm][0]).toContain('class="button danger"');
    expect(
      renderToStaticMarkup(
        <ConfirmDialog
          title="Switch team?"
          message="Fictional message"
          confirmLabel="Switch team"
          onConfirm={() => {}}
          onCancel={() => {}}
        />,
      ),
    ).not.toContain("button danger");
  });
});

describe("Import CVs", () => {
  it("shows only the capability check before the availability answer arrives", () => {
    const markup = renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <BulkCvImport onClose={() => {}} onChanged={() => {}} />
      </WorkspaceProvider>,
    );
    expect(markup).toContain("Checking CV import availability");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("unavailable");
    expect(markup).not.toContain("not set up");
  });

  const dialog = (importState: CvImportState) =>
    renderToStaticMarkup(
      <WorkspaceProvider value={workspace}>
        <BulkCvImportDialog
          importState={importState}
          capabilityError={importState === "error" ? "Network unavailable" : ""}
          onCapabilityLost={() => {}}
          onClose={() => {}}
          onChanged={() => {}}
        />
      </WorkspaceProvider>,
    );
  it.each(["checking", "not-set-up", "unavailable", "error"] as const)(
    "shows only the explanation and Close while %s",
    (importState) => {
      const markup = dialog(importState);
      expect(markup).not.toContain('type="file"');
      expect(markup).not.toContain("Import reviewed");
      expect(markup).not.toContain("prepare a review draft");
      expect(markup).not.toContain("Recent imports");
      expect(markup).toContain(">Close</button>");
    },
  );
  it("explains each unavailable state in plain words", () => {
    expect(dialog("not-set-up")).toContain("CV uploads are not set up yet.");
    expect(dialog("unavailable")).toContain(
      "CV import is not available right now. You can still add and edit candidate details in the candidate directory.",
    );
    expect(dialog("error")).toContain(
      "Could not check import availability. Network unavailable",
    );
  });
  it("shows the limits before any work once uploads are ready", () => {
    const markup = dialog("ready");
    const limits = `Up to ${BULK_INTAKE_MAX_FILES} files per import, 10 MiB each. One CV uploads at a time in this browser. Import progress is kept on the server for ${BULK_INTAKE_RECOVERY_HOURS} hours; selected files and drafts stay only in this browser.`;
    expect(markup).toContain(`<p>${limits}</p>`);
    expect(markup.indexOf(limits)).toBeLessThan(markup.indexOf('type="file"'));
    expect(markup).toContain(
      `Recent imports (kept for ${BULK_INTAKE_RECOVERY_HOURS} hours)`,
    );
    expect(markup).toContain("Import reviewed (0)");
    expect(markup).not.toContain("Cancel import");
  });
  const recentPage = (totalPages: number): RecentImportsPage => ({
    data: [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        createdAt: "2030-01-01T09:00:00.000Z",
        expiresAt: "2030-01-02T09:00:00.000Z",
        items: [
          {
            id: "00000000-0000-4000-8000-0000000000c1",
            originalName: "fictional-cv.pdf",
            sizeBytes: 200,
            candidateId: "00000000-0000-4000-8000-0000000000d1",
            outcome: "cv-rejected",
          },
        ],
      },
    ],
    pagination: { page: 1, pageSize: 10, total: totalPages * 10, totalPages },
  });
  const recent = (page: RecentImportsPage) =>
    renderToStaticMarkup(
      <RecentImports
        page={page}
        error=""
        loading={false}
        currentBatchId="00000000-0000-4000-8000-0000000000b2"
        onPage={() => {}}
      />,
    );
  it("pages Recent imports only when there is more than one page", () => {
    const markup = recent(recentPage(2));
    const nav =
      /<nav class="pagination" aria-label="Recent import pages">[\s\S]*?<\/nav>/.exec(
        markup,
      )?.[0];
    expect(nav).toBeDefined();
    expect(nav).toContain("Page 1 of 2");
    expect(nav).toContain(">Next</button>");
    expect(nav).toMatch(/<button[^>]*disabled=""[^>]*>Previous<\/button>/);
    expect(markup).toContain("Candidate created, CV rejected");
    expect(markup).toContain("Open the candidate to attach the CV");
    const single = recent(recentPage(1));
    expect(single).toContain("fictional-cv.pdf");
    expect(single).not.toContain("<nav");
    expect(single).not.toContain("Recent import pages");
  });
  const emptyPage = (page: number): RecentImportsPage => ({
    data: [],
    pagination: { page, pageSize: 10, total: 3, totalPages: 1 },
  });
  /** The button with this label in an element tree; the component has no hooks, so it runs directly. */
  const buttonIn = (
    node: ReactNode,
    label: string,
  ): ReactElement<ButtonHTMLAttributes<HTMLButtonElement>> | undefined => {
    if (Array.isArray(node))
      return node.map((child) => buttonIn(child, label)).find(Boolean);
    if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
    if (node.type === "button" && node.props.children === label)
      return node as ReactElement<ButtonHTMLAttributes<HTMLButtonElement>>;
    return buttonIn(node.props.children, label);
  };
  it("offers Go to first page when a later Recent imports page is empty", () => {
    const markup = recent(emptyPage(2));
    expect(markup).toContain("No recent imports on this page.");
    expect(markup).not.toContain("No other recent imports.");
    const button = /<button[^>]*>Go to first page<\/button>/.exec(markup)?.[0];
    expect(button).toBeDefined();
    expect(button).toContain('class="button secondary small"');
    expect(button).not.toContain("disabled");
    expect(markup).not.toContain("<nav");
    // A later page holding only the batch this dialog is running counts as empty as well.
    const onlyCurrent = recent({
      ...emptyPage(2),
      data: [
        {
          ...recentPage(1).data[0],
          id: "00000000-0000-4000-8000-0000000000b2",
        },
      ],
    });
    expect(onlyCurrent).toContain("No recent imports on this page.");
    expect(onlyCurrent).toContain("Go to first page");
    expect(onlyCurrent).not.toContain("fictional-cv.pdf");

    const onPage = vi.fn();
    const tree = RecentImports({
      page: emptyPage(2),
      error: "",
      loading: false,
      currentBatchId: "00000000-0000-4000-8000-0000000000b2",
      onPage,
    });
    const first = buttonIn(tree, "Go to first page");
    expect(first).toBeDefined();
    first!.props.onClick!({} as MouseEvent<HTMLButtonElement>);
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenCalledWith(1);

    const loading = renderToStaticMarkup(
      <RecentImports
        page={emptyPage(2)}
        error=""
        loading
        currentBatchId="00000000-0000-4000-8000-0000000000b2"
        onPage={() => {}}
      />,
    );
    expect(loading).toMatch(
      /<button[^>]*disabled=""[^>]*>Go to first page<\/button>/,
    );
  });
  it("keeps the plain empty text on the first Recent imports page", () => {
    const markup = recent(emptyPage(1));
    expect(markup).toContain("No other recent imports.");
    expect(markup).not.toContain("No recent imports on this page.");
    expect(markup).not.toContain("Go to first page");
  });
});
