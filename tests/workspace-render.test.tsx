import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkspaceProvider } from "../src/components/workspace/client";
import { DisplayModeToggle } from "../src/components/workspace/display-mode-toggle";
import { BulkCvImport } from "../src/components/workspace/bulk-cv-import";

const workspace = {
  user: {
    id: "fictional-user",
    name: "Fictional Recruiter",
    email: "recruiter@example.test",
  },
  team: { id: "fictional-team", name: "Fictional Team", slug: "fictional" },
  role: "recruiter",
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
