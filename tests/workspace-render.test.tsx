import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../src/components/workspace/client";
import { DisplayModeToggle } from "../src/components/workspace/display-mode-toggle";
import { BulkCvImport } from "../src/components/workspace/bulk-cv-import";
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
});
