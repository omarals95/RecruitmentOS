import { afterEach, describe, expect, it, vi } from "vitest";
import { mailConfigured, sendAuthMail } from "@/lib/mail";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("hosted mail safety", () => {
  it("does not print development mail on Vercel even with a development NODE_ENV", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("DEV_MAIL_MODE", "console");
    vi.stubEnv("RESEND_API_KEY", undefined);
    vi.stubEnv("EMAIL_FROM", undefined);
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(mailConfigured()).toBe(false);
    await expect(
      sendAuthMail({
        to: "fictional@example.test",
        subject: "Synthetic",
        text: "fictional content",
      }),
    ).rejects.toMatchObject({ code: "MAIL_NOT_CONFIGURED" });
    expect(output).not.toHaveBeenCalled();
    vi.stubEnv("VERCEL", "true");
    expect(mailConfigured()).toBe(false);
    await expect(
      sendAuthMail({
        to: "fictional@example.test",
        subject: "Synthetic",
        text: "fictional content",
      }),
    ).rejects.toMatchObject({ code: "MAIL_NOT_CONFIGURED" });
    expect(output).not.toHaveBeenCalled();
  });

  it("keeps explicit console mail available for local development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("VERCEL", undefined);
    vi.stubEnv("DEV_MAIL_MODE", "console");
    const output = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(mailConfigured()).toBe(true);
    await sendAuthMail({
      to: "fictional@example.test",
      subject: "Synthetic",
      text: "fictional content",
    });
    expect(output).toHaveBeenCalledOnce();
  });
});
