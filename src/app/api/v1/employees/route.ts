import { json, readBody, runApi } from "@/lib/api";
import { employeeInput } from "@/domain/directory";
import { createEmployee, listEmployees } from "@/lib/directory";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        await listEmployees(
          p,
          Object.fromEntries(new URL(request.url).searchParams),
        ),
      ),
    { humanOnly: true },
  );
}
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json(
        {
          data: await createEmployee(p, await readBody(request, employeeInput)),
        },
        201,
      ),
    { humanOnly: true },
  );
}
