import {
  resetSessionInputSchema,
  resetSessionResultSchema,
  turnInputSchema,
  turnResultSchema,
  type ResetSessionInput,
  type TurnInput,
} from "../../../shared/voice-router.ts";
import { ApiError, request } from "../../lib/http.ts";

export function sendTurn(input: TurnInput) {
  const parsed = turnInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError("Введите сообщение для маршрутизации", { cause: parsed.error });
  return request("/api/voice-router/turn", turnResultSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
}

export function resetRouterSession(input: ResetSessionInput) {
  const parsed = resetSessionInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError("Некорректный идентификатор сессии", { cause: parsed.error });
  return request("/api/voice-router/reset", resetSessionResultSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(parsed.data),
  });
}
