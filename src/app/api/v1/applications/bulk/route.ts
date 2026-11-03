import { runApi, readBody, json } from "@/lib/api";
import { bulkApplications } from "@/lib/records";
import { bulkApplicationsSchema } from "@/domain/records";
export const runtime = "nodejs";
export async function POST(req: Request) {
  return runApi(req, "recruitment:write", async (p) =>
    json(
      await bulkApplications(p, await readBody(req, bulkApplicationsSchema)),
    ),
  );
}
