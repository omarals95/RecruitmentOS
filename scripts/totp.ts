import { createHmac } from "node:crypto";

// Local tooling only: the fictional seed owner's authenticator key and codes, with no dependency.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding, as authenticator apps expect. */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0,
    value = 0,
    output = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error("The key is not base32.");
  let bits = 0,
    value = 0;
  const output: number[] = [];
  for (const char of clean) {
    value = ((value << 5) | ALPHABET.indexOf(char)) & 0x1fff;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Uint8Array.from(output);
}

/** RFC 6238 TOTP with SHA-1, 6 digits and 30 seconds, the settings RecruitmentOS uses. */
export function totpCode(key: Uint8Array, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, "0");
}

/** The fictional seed owner's current code; refuses outside explicitly enabled local PGlite. */
export function seedTotpCode(env: Record<string, string | undefined>): string {
  if (
    env.NODE_ENV === "production" ||
    env.DATABASE_MODE !== "pglite" ||
    env.ALLOW_LOCAL_DB !== "true"
  )
    throw new Error(
      "The seed sign-in code is available only with DATABASE_MODE=pglite and ALLOW_LOCAL_DB=true.",
    );
  if (!env.DEV_SEED_TOTP_KEY)
    throw new Error(
      "Set DEV_SEED_TOTP_KEY in .env.local to the key npm run db:seed printed.",
    );
  return totpCode(base32Decode(env.DEV_SEED_TOTP_KEY));
}
