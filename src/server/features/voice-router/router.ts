import { z } from "zod";
import {
  responseLanguageSchema,
  routeDecisionSchema,
  type RouteDecision,
} from "../../../shared/voice-router.ts";
import { parseCatalogRouteDecision, type VoiceRouterCatalog } from "./catalog.ts";
import { ModelProviderError, type FunctionTool, type VoiceRouterModelSession } from "./model.ts";

const routeOutputSchema = routeDecisionSchema.extend({ response_language: responseLanguageSchema });

export interface RoutingContext {
  activeScenarioIds: string[];
  slots: Record<string, unknown>;
  responseLanguage?: "ru" | "kk";
}

export interface RoutingResult {
  decision: RouteDecision;
  responseLanguage: "ru" | "kk";
}

function createRouteTool(catalog: VoiceRouterCatalog): FunctionTool {
  const scenarioId = { type: "string", enum: [...catalog.ids] };
  return {
    name: "route_turn",
    description: "Classify one customer turn using only the supplied scenario catalog.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [
        "scenarios",
        "alternatives",
        "language",
        "response_language",
        "slots",
        "is_continuation",
      ],
      properties: {
        scenarios: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["scenario_id", "confidence", "reason"],
            properties: {
              scenario_id: scenarioId,
              confidence: { type: "number", minimum: 0, maximum: 1 },
              reason: { type: "string", minLength: 1, maxLength: 500 },
            },
          },
        },
        alternatives: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["scenario_id", "confidence"],
            properties: {
              scenario_id: scenarioId,
              confidence: { type: "number", minimum: 0, maximum: 1 },
            },
          },
        },
        language: { type: "string", enum: ["ru", "kk", "mixed"] },
        response_language: { type: "string", enum: ["ru", "kk"] },
        slots: { type: "object", additionalProperties: true },
        is_continuation: { type: "boolean" },
      },
    },
  };
}

function validationSummary(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof SyntaxError
    ? "arguments are not valid JSON"
    : "catalog validation failed";
}

function parseFunctionCall(
  call: { name: string; arguments: string },
  catalog: VoiceRouterCatalog,
): RoutingResult {
  if (call.name !== "route_turn") throw new Error("unexpected function name");
  const value = routeOutputSchema.parse(JSON.parse(call.arguments) as unknown);
  const { response_language: responseLanguage, ...decisionValue } = value;
  return {
    decision: parseCatalogRouteDecision(decisionValue, catalog),
    responseLanguage,
  };
}

export async function routeTurn(input: {
  text: string;
  context: RoutingContext;
  catalog: VoiceRouterCatalog;
  session: VoiceRouterModelSession;
  signal?: AbortSignal;
}): Promise<RoutingResult> {
  const tool = createRouteTool(input.catalog);
  const payload = JSON.stringify({
    user_text: input.text,
    session_context: input.context,
  });
  const attempt = async (instructions: string) => {
    const call = await input.session.callFunction({
      instructions,
      text: payload,
      tool,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return parseFunctionCall(call, input.catalog);
  };

  try {
    return await attempt(input.catalog.routingPrompt);
  } catch (firstError) {
    if (firstError instanceof ModelProviderError && firstError.kind !== "output") throw firstError;
    try {
      return await attempt(
        `${input.catalog.routingPrompt}\nThe previous function call was invalid (${validationSummary(firstError)}). Return a completely new route_turn call that satisfies the schema and catalog.`,
      );
    } catch (cause) {
      if (cause instanceof ModelProviderError && cause.kind !== "output") throw cause;
      throw new ModelProviderError("output", "Router output remained invalid after one repair", {
        cause,
      });
    }
  }
}
