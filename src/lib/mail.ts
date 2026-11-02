import { waitUntil } from "@vercel/functions";
import { ApiError } from "./errors";

export type AuthMail = { to: string; subject: string; text: string };
export type MailDelivery = (message: AuthMail) => Promise<void>;

export function mailConfigured(): boolean {
  return (
    Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) ||
    (process.env.NODE_ENV !== "production" &&
      process.env.DEV_MAIL_MODE === "console")
  );
}

export async function sendAuthMail(message: AuthMail): Promise<void> {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.DEV_MAIL_MODE === "console"
  ) {
    console.info("[Local development mail]", message);
    return;
  }
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM)
    throw new ApiError(
      503,
      "MAIL_NOT_CONFIGURED",
      "Authentication email is not configured. Contact your administrator.",
    );
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("Authentication email delivery failed.");
}

export async function dispatchAuthMail(
  message: AuthMail,
  deliver: MailDelivery = sendAuthMail,
): Promise<void> {
  const delivery = deliver(message);
  if (process.env.VERCEL) {
    waitUntil(
      delivery.catch(() => {
        console.error(
          "Authentication email delivery failed; check the configured provider.",
        );
      }),
    );
    return;
  }
  await delivery;
}
