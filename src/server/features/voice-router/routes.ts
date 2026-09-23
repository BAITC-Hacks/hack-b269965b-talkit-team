import { createError, defineEventHandler, setHeader, type Router } from "h3";
import {
  resetSessionInputSchema,
  resetSessionResultSchema,
  turnInputSchema,
} from "../../../shared/voice-router.ts";
import { InputError, readJson } from "../../http/json.ts";
import type { VoiceRouterController } from "./controller.ts";
import { SessionCapacityError, SessionConflictError } from "./state.ts";

async function bodyFrom(event: Parameters<Parameters<typeof defineEventHandler>[0]>[0]) {
  try {
    return await readJson(event.node.req);
  } catch (error) {
    if (error instanceof InputError) {
      throw createError({ statusCode: error.statusCode, statusMessage: error.message });
    }
    throw error;
  }
}

export function registerVoiceRouterRoutes(router: Router, controller: VoiceRouterController): void {
  router.post(
    "/api/voice-router/turn",
    defineEventHandler(async (event) => {
      const parsed = turnInputSchema.safeParse(await bodyFrom(event));
      if (!parsed.success) {
        throw createError({ statusCode: 400, statusMessage: "Invalid voice router turn" });
      }
      try {
        return await controller.handleTurn(parsed.data);
      } catch (error) {
        if (error instanceof SessionConflictError) {
          throw createError({ statusCode: 409, statusMessage: error.message });
        }
        if (error instanceof SessionCapacityError) {
          throw createError({ statusCode: 503, statusMessage: "Voice router is busy" });
        }
        throw error;
      }
    }),
  );
  router.use(
    "/api/voice-router/turn",
    defineEventHandler((event) => {
      setHeader(event, "allow", "POST");
      throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
    }),
  );

  router.post(
    "/api/voice-router/reset",
    defineEventHandler(async (event) => {
      const parsed = resetSessionInputSchema.safeParse(await bodyFrom(event));
      if (!parsed.success) {
        throw createError({ statusCode: 400, statusMessage: "Invalid session ID" });
      }
      return resetSessionResultSchema.parse({
        sessionId: parsed.data.sessionId,
        reset: controller.resetSession(parsed.data.sessionId),
      });
    }),
  );
  router.use(
    "/api/voice-router/reset",
    defineEventHandler((event) => {
      setHeader(event, "allow", "POST");
      throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
    }),
  );
}
