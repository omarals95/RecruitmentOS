import { json, readBody, runApi } from "@/lib/api";
import {
  getStorageSettings,
  storageSettingsSchema,
  updateStorageSettings,
} from "@/lib/storage-settings";

export const runtime = "nodejs";
export async function GET(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => json({ data: await getStorageSettings(p) }),
    { humanOnly: true },
  );
}
export async function PUT(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) =>
      json({
        data: await updateStorageSettings(
          p,
          await readBody(request, storageSettingsSchema),
        ),
      }),
    { humanOnly: true },
  );
}
