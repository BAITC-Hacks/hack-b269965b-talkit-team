import { z } from "zod";

// Shared runtime schemas, not a second manually maintained set of DTO types.
export const echoInputSchema = z.object({ text: z.string().trim().min(1).max(1000) }).strict();
export const echoOutputSchema = z
  .object({
    text: z.string(),
    receivedAt: z.iso.datetime(),
    requestId: z.uuid(),
    mode: z.literal("infrastructure-check"),
  })
  .strict();
export const healthSchema = z
  .object({
    status: z.literal("ok"),
    app: z.string().trim().min(1).max(80),
    requestId: z.uuid(),
  })
  .strict();
export type EchoInput = z.infer<typeof echoInputSchema>;
export type EchoOutput = z.infer<typeof echoOutputSchema>;
export type Health = z.infer<typeof healthSchema>;
