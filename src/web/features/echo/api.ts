import { echoInputSchema, echoOutputSchema, type EchoInput } from "../../../shared/contracts.ts";
import { ApiError, request } from "../../lib/http.ts";

export async function echo(input: EchoInput) {
  const parsed = echoInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError("Message must contain between 1 and 1000 characters", {
      cause: parsed.error,
    });
  }
  return request("/api/echo", echoOutputSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
}
