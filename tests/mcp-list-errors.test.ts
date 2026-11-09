import { afterEach, describe, expect, it, vi } from "vitest";

// The install is forced to fail, so no database is needed; fictional values only.
vi.mock("@/lib/db-team", () => ({ withTeam: vi.fn() }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { withTeam } from "@/lib/db-team";
import { ApiError } from "@/lib/errors";
import { createMcpServer } from "@/lib/mcp/server";
import { roleScopes } from "@/lib/permissions";
import type { Principal } from "@/lib/principal";

const SECRET =
  "fictional-secret-host.example.test db_boundary.connection_marker";
const token: Principal = {
  userId: "list-errors-owner",
  teamId: "list-errors-team",
  role: "owner",
  scopes: roleScopes("owner"),
  authType: "token",
  tokenId: "50000000-0000-4000-8000-000000000005",
};

type WireError = { code: number; message: string; data?: unknown };
/** tools/list through the server's own handler; returns the JSON-RPC error body it sent. */
async function listError(failure: unknown): Promise<WireError> {
  vi.mocked(withTeam).mockRejectedValue(failure);
  const server = createMcpServer(token);
  const client = new Client({ name: "fictional-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const sent: Record<string, unknown>[] = [];
  const send = serverSide.send.bind(serverSide);
  serverSide.send = (message, options) => {
    sent.push(message as Record<string, unknown>);
    return send(message, options);
  };
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    await expect(client.listTools()).rejects.toBeInstanceOf(McpError);
    const errors = sent.filter((message) => "error" in message);
    expect(errors).toHaveLength(1);
    return errors[0].error as WireError;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("tools/list errors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("answers a failed install with the generic internal error and logs only a safe category", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await listError(
      Object.assign(new Error(`Failed query: select set_config ${SECRET}`), {
        cause: Object.assign(new Error(`connection to ${SECRET} failed`), {
          code: "08006",
        }),
      }),
    );
    expect(error).toEqual({
      code: ErrorCode.InternalError,
      message: `MCP error ${ErrorCode.InternalError}: The request could not be completed. Refresh the record before retrying a save.`,
      data: { code: "internal_error" },
    });
    expect(JSON.stringify(error)).not.toContain("fictional-secret");
    expect(JSON.stringify(error)).not.toContain("set_config");
    const lines = logged.mock.calls.map((call) => call.join(" "));
    expect(lines).toEqual([
      expect.stringMatching(
        /^internal_error correlationId=\S+ category=Error sqlstate=08006$/,
      ),
    ]);
  });

  it("keeps a refusal's own code and message", async () => {
    const error = await listError(
      new ApiError(
        403,
        "tenant_context_denied",
        "Fictional refusal of this team context.",
      ),
    );
    expect(error).toEqual({
      code: ErrorCode.InvalidRequest,
      message: `MCP error ${ErrorCode.InvalidRequest}: Fictional refusal of this team context.`,
      data: { code: "tenant_context_denied" },
    });
  });
});
