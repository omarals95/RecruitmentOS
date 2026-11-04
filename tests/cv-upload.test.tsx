import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CvUpload } from "../src/components/cv-upload";

const render = (storageConfigured: boolean) =>
  renderToStaticMarkup(
    <CvUpload
      candidateId="00000000-0000-4000-8000-000000000001"
      teamId="fictional-team"
      storageConfigured={storageConfigured}
    />,
  );

describe("CvUpload", () => {
  it("explains the setup-required state without upload controls or technical names", () => {
    const markup = render(false);
    expect(markup).toContain('aria-label="Upload candidate CV"');
    expect(markup).toContain("CV uploads are not set up yet.");
    expect(markup).toContain("administrator");
    expect(markup).not.toContain('type="file"');
    expect(markup).not.toContain("Upload CV");
    expect(markup).not.toMatch(
      /S3|AWS|Amazon|Blob|Vercel|_NAME|_ARN|environment/i,
    );
  });

  it("renders today's upload controls when storage is configured", () => {
    const markup = render(true);
    expect(markup).toContain("Attach a CV");
    expect(markup).toContain('type="file"');
    expect(markup).toContain("Upload CV");
    expect(markup).not.toContain("CV uploads are not set up yet.");
  });
});
