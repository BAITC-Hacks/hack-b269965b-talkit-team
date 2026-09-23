import { createError, defineEventHandler, setHeader, type Router } from "h3";
import { echoInputSchema, echoOutputSchema } from "../../../shared/contracts.ts";
import { InputError, readJson } from "../../http/json.ts";

export function registerEchoRoutes(router: Router): void {
  router.post(
    "/api/echo",
    defineEventHandler(async (event) => {
      let body: unknown;
      try {
        body = await readJson(event.node.req);
      } catch (error) {
        if (error instanceof InputError) {
          throw createError({ statusCode: error.statusCode, statusMessage: error.message });
        }
        throw error;
      }
      const input = echoInputSchema.safeParse(body);
      if (!input.success) {
        throw createError({
          statusCode: 400,
          statusMessage: "Text must contain 1 to 1000 characters",
        });
      }
      return echoOutputSchema.parse({
        text: input.data.text,
        receivedAt: new Date().toISOString(),
        requestId: event.context.requestId,
        mode: "infrastructure-check",
      });
    }),
  );
  router.use(
    "/api/echo",
    defineEventHandler((event) => {
      setHeader(event, "allow", "POST");
      throw createError({ statusCode: 405, statusMessage: "Method not allowed" });
    }),
  );
}
