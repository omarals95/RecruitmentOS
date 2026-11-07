import { ApiError, json, readBody, runApi } from "@/lib/api";
import { SPEED_MAX_BODY_BYTES } from "@/domain/speed";
import { recordSpeedSamples, speedSamplesSchema } from "@/lib/speed-log";

export const runtime = "nodejs";
/** Signed-in members only, viewers included; Bearer tokens get 403 session_required. */
export async function POST(request: Request) {
  return runApi(
    request,
    undefined,
    async (p) => {
      let input;
      try {
        input = await readBody(
          request,
          speedSamplesSchema,
          SPEED_MAX_BODY_BYTES,
        );
      } catch (error) {
        // An oversized batch is invalid input like any other malformed batch.
        if (error instanceof ApiError && error.status === 413)
          throw new ApiError(
            400,
            "invalid_input",
            "Send at most 16 KiB of speed samples at a time.",
          );
        throw error;
      }
      return json({ accepted: await recordSpeedSamples(p, input) }, 202);
    },
    { humanOnly: true },
  );
}
