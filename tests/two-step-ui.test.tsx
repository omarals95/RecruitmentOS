import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SetupKeyStep,
  TwoStepCode,
  TwoStepSetup,
  setupKey,
} from "../src/components/auth/two-step";
import { QR_LABEL } from "../src/components/auth/qr-code";

const URI =
  "otpauth://totp/RecruitmentOS:fictional%40example.test?secret=MZXW6YTBOJ2GS33OMFWHEZLDOJSXIZLTMVRXEZLUOM&issuer=RecruitmentOS&digits=6&period=30";
const source = (path: string) =>
  readFileSync(
    new URL(`../src/components/auth/${path}`, import.meta.url),
    "utf8",
  );
const escaped = (text: string) => text.replaceAll("'", "&#x27;");

describe("two-step setup screen", () => {
  it("shows the QR code as a labelled SVG, the grouped key and a one-time-code field", () => {
    const markup = renderToStaticMarkup(
      <SetupKeyStep totpURI={URI} email="fictional@example.test" />,
    );
    expect(markup).toMatch(/<svg[^>]*role="img"/);
    expect(markup).toContain(`aria-label="${escaped(QR_LABEL)}"`);
    expect(markup).toContain('fill="#ffffff"');
    expect(markup).toContain(
      "MZXW 6YTB OJ2G S33O MFWH EZLD OJSX IZLT MVRX EZLU OM",
    );
    for (const text of [
      "fictional@example.test",
      "RecruitmentOS",
      "Time-based, 6 digits",
      "Copy setup key",
      "6-digit code from your authenticator app",
    ])
      expect(markup).toContain(text);
    const input = /<label[^>]*>6-digit code[^<]*<input[^>]*>/.exec(markup)?.[0];
    expect(input).toContain('inputMode="numeric"');
    expect(input).toContain('autoComplete="one-time-code"');
    expect(setupKey(URI).replaceAll(" ", "")).toBe(
      new URL(URI).searchParams.get("secret"),
    );
  });

  it("starts with the password, says why when required, and always offers Sign out", () => {
    const required = renderToStaticMarkup(
      <TwoStepSetup email="owner@example.test" required next="/app" />,
    );
    expect(required.match(/<h1/g)).toHaveLength(1);
    expect(required).toContain("Set up two-step sign-in");
    expect(required).toContain("required for your role");
    expect(required).toContain('autoComplete="current-password"');
    expect(required).toContain(">Sign out</button>");
    expect(required).not.toContain(">Cancel</a>");
    const optional = renderToStaticMarkup(
      <TwoStepSetup email="viewer@example.test" required={false} next="/app" />,
    );
    expect(optional).toContain('href="/app/settings/profile"');
    expect(optional).toContain(">Cancel</a>");
    expect(optional).toContain(">Sign out</button>");
  });

  it("draws the QR code without injected markup or a remote service and never stores or logs secrets", () => {
    const code = source("qr-code.tsx") + source("two-step.tsx");
    for (const forbidden of [
      "dangerouslySetInnerHTML",
      "localStorage",
      "sessionStorage",
      "console.",
      "http://",
      "https://",
    ])
      expect(code).not.toContain(forbidden);
  });
});

describe("two-step code screen", () => {
  it("asks for a code with an unchecked 30-day trust box and a backup-code switch", () => {
    const markup = renderToStaticMarkup(<TwoStepCode next="/app/settings" />);
    expect(markup.match(/<h1/g)).toHaveLength(1);
    expect(markup).toContain("Enter your sign-in code");
    const input = /<label[^>]*>6-digit code[^<]*<input[^>]*>/.exec(markup)?.[0];
    expect(input).toContain('inputMode="numeric"');
    expect(input).toContain('autoComplete="one-time-code"');
    const trust =
      /<input type="checkbox"[^>]*>Trust this device for 30 days/.exec(
        markup,
      )?.[0];
    expect(trust).toBeTruthy();
    expect(trust).not.toContain("checked");
    expect(markup).toContain(">Use a backup code instead</button>");
    expect(markup).toContain('href="/sign-in?next=%2Fapp%2Fsettings"');
  });
});
