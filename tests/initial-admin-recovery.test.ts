import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { AppDb } from "../src/db";
import { authTables } from "../src/db/auth-schema";
import { createAuth } from "../src/lib/auth";

describe("initial administrator recovery", () => {
  it("recovers from delivery failure without reopening setup", async () => {
    const pg = new PGlite();
    try {
      for (const file of [
        "0000_auth.sql",
        "0003_initial_admin.sql",
        "0022_two_step_sign_in.sql",
      ])
        await pg.exec(
          await readFile(
            new URL(`../drizzle/${file}`, import.meta.url),
            "utf8",
          ),
        );
      let deliveryFails = true;
      const delivered: { text: string }[] = [];
      const auth = createAuth(
        drizzle(pg, { schema: authTables }) as unknown as AppDb,
        {
          baseURL: "http://localhost:3000",
          secret: "fictional-test-secret-with-at-least-32-characters",
          bootstrapOwnerEmail: "owner@example.test",
          bootstrapSetupToken: "fictional-bootstrap-secret-0123456789abcdefghi",
          publicSignup: true,
          deliver: async (message) => {
            if (deliveryFails) throw new Error("Fictional mail failure");
            delivered.push(message);
          },
        },
      );
      const post = (path: string, body: unknown, withToken = false) =>
        auth.handler(
          new Request(`http://localhost:3000/api/auth/${path}`, {
            method: "POST",
            headers: {
              origin: "http://localhost:3000",
              "content-type": "application/json",
              ...(withToken
                ? {
                    "x-bootstrap-token":
                      "fictional-bootstrap-secret-0123456789abcdefghi",
                  }
                : {}),
            },
            body: JSON.stringify(body),
          }),
        );
      const owner = {
        name: "Owner",
        email: "owner@example.test",
        password: "long-fictional-password",
      };
      await post("sign-up/email", owner, true);
      let users = (await pg.query(`SELECT id FROM auth."user"`)).rows.length;
      let claims = (await pg.query(`SELECT id FROM auth.initial_admin_claim`))
        .rows.length;
      expect(claims).toBe(users);
      deliveryFails = false;
      if (users === 0) await post("sign-up/email", owner, true);
      else
        await post("send-verification-email", {
          email: owner.email,
          callbackURL: "/sign-in",
        });
      users = (await pg.query(`SELECT id FROM auth."user"`)).rows.length;
      claims = (await pg.query(`SELECT id FROM auth.initial_admin_claim`)).rows
        .length;
      expect(users).toBe(1);
      expect(claims).toBe(1);
      expect(
        delivered.some((message) =>
          message.text.includes("/api/auth/verify-email"),
        ),
      ).toBe(true);
      await post("sign-up/email", {
        name: "Other",
        email: "other@example.test",
        password: "long-fictional-password",
      });
      expect(
        (
          await pg.query(
            `SELECT id FROM auth."user" WHERE email='other@example.test'`,
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await pg.close();
    }
  });
});
