"use client";

import { encode } from "uqr";

export const QR_LABEL =
  "QR code for adding RecruitmentOS to your authenticator app. If you cannot scan it, type the setup key shown below.";

/**
 * The otpauth:// URI as a QR code, encoded in the browser and drawn as SVG elements: no image
 * service and no injected markup. Black modules on white with a 4-module quiet zone in both themes.
 */
export function QrCode({ value }: { value: string }) {
  const { data, size } = encode(value, { ecc: "M", border: 4 });
  let path = "";
  data.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x} ${y}h1v1h-1z`;
    }),
  );
  return (
    <svg
      role="img"
      aria-label={QR_LABEL}
      className="two-step-qr"
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
