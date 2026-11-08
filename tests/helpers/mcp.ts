import { randomBytes, randomUUID } from "node:crypto";
import { expect } from "vitest";
import * as mcpRoute from "../../src/app/api/mcp/route";
import { createTokenMaterial, hashToken } from "../../src/lib/api-token-policy";
import type { createTestDb } from "./db";
import { CLIENT_IP } from "./readiness";

export const ORIGIN = "http://localhost:3000";
export type Result = {
  isError?: boolean;
  structuredContent: {
    untrustedData?: boolean;
    notice?: string;
    data?: unknown;
    pagination?: { page: number; pageSize: number; total: number };
    error?: { code: string; message: string };
  };
  content: { type: string; text: string }[];
};

/**
 * Calls /api/mcp with fictional tokens written straight into a test database, which the test file
 * must route the data and identity pools to. `fixture` is read when a helper runs, after setup.
 */
export function mcpHarness(
  fixture: () => Awaited<ReturnType<typeof createTestDb>>,
  team: string,
) {
  let rpc = 0;
  /** Runs fixture inspection or setup as the database owner, outside RLS. */
  async function asOwner<T>(work: () => Promise<T>): Promise<T> {
    await fixture().client.exec("RESET ROLE");
    try {
      return await work();
    } finally {
      await fixture().client.exec("SET ROLE recruitment_test_runtime");
    }
  }
  const query = <T>(text: string, params: unknown[] = []) =>
    asOwner(async () => (await fixture().client.query<T>(text, params)).rows);
  const count = async (text: string, params: unknown[] = []) =>
    (await query<{ count: number }>(text, params))[0].count;

  async function apiToken(
    userId: string,
    scopes: readonly string[],
    teamId = team,
  ) {
    const material = createTokenMaterial();
    const id = randomUUID();
    await fixture().client.query(
      `INSERT INTO auth.api_tokens(id,team_id,user_id,name,token_hash,prefix,scopes,expires_at)
        VALUES($1,$2,$3,'Fictional MCP token',$4,$5,$6::jsonb,now()+interval '1 day')`,
      [
        id,
        teamId,
        userId,
        material.tokenHash,
        material.prefix,
        JSON.stringify(scopes),
      ],
    );
    return { id, token: material.token };
  }
  /** A consented OAuth grant with one access token, written as the token endpoint would. */
  async function oauthAccess(userId: string, scopes: readonly string[]) {
    const clientId = `ros_client_${randomBytes(16).toString("base64url")}`;
    await fixture().client.query(
      `INSERT INTO auth.oauth_clients(id,name,redirect_uris) VALUES($1,'Fictional Connector','["https://claude.ai/api/mcp/auth_callback"]')`,
      [clientId],
    );
    const grant = await apiToken(userId, scopes);
    await fixture().client.query(
      "UPDATE auth.api_tokens SET oauth_client_id=$1 WHERE id=$2",
      [clientId, grant.id],
    );
    const token = `ros_oat_${randomBytes(32).toString("base64url")}`;
    await fixture().client.query(
      `INSERT INTO auth.oauth_tokens(grant_id,kind,token_hash,audience,expires_at)
        VALUES($1,'access',$2,'${ORIGIN}/api/mcp',now()+interval '1 hour')`,
      [grant.id, hashToken(token)],
    );
    return { clientId, id: grant.id, token };
  }
  function post(
    token: string | null,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return mcpRoute.POST(
      new Request(`${ORIGIN}/api/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-forwarded-for": CLIENT_IP,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  }
  const message = (method: string, params?: unknown) => ({
    jsonrpc: "2.0",
    id: ++rpc,
    method,
    ...(params === undefined ? {} : { params }),
  });
  async function rpcResult(token: string, method: string, params?: unknown) {
    const response = await post(token, message(method, params));
    expect(response.status, method).toBe(200);
    const body = await response.json();
    expect(body.error, JSON.stringify(body.error)).toBeUndefined();
    return body.result;
  }
  const listNames = async (token: string) =>
    ((await rpcResult(token, "tools/list")).tools as { name: string }[]).map(
      (item) => item.name,
    );
  const call = async (token: string, name: string, args: unknown = {}) =>
    (await rpcResult(token, "tools/call", {
      name,
      arguments: args,
    })) as Result;
  const data = <T = Record<string, unknown>>(result: Result) => {
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
      true,
    );
    return result.structuredContent.data as T;
  };
  const toolError = (result: Result) => {
    expect(result.isError).toBe(true);
    return result.structuredContent.error!.code;
  };
  return {
    asOwner,
    query,
    count,
    apiToken,
    oauthAccess,
    post,
    message,
    rpcResult,
    listNames,
    call,
    data,
    toolError,
  };
}
