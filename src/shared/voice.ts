import { z } from "zod";

const sessionCommand = z.object({
  epoch: z.uuid(),
});

export const voiceClientCommandSchema = z.discriminatedUnion("type", [
  sessionCommand.extend({ type: z.literal("voice.start"), sessionId: z.uuid() }),
  sessionCommand.extend({ type: z.literal("voice.speak") }),
  sessionCommand.extend({ type: z.literal("voice.commit") }),
  sessionCommand.extend({ type: z.literal("voice.interrupt"), playbackId: z.uuid().optional() }),
  sessionCommand.extend({ type: z.literal("voice.stop") }),
  sessionCommand.extend({ type: z.literal("voice.playback.started"), playbackId: z.uuid() }),
  sessionCommand.extend({ type: z.literal("voice.playback.completed"), playbackId: z.uuid() }),
  sessionCommand.extend({ type: z.literal("voice.playback.interrupted"), playbackId: z.uuid() }),
]);

export type VoiceClientCommand = z.infer<typeof voiceClientCommandSchema>;

export type VoiceServerEvent =
  | { type: "voice.ready"; epoch: string; sessionId: string }
  | { type: "voice.state"; epoch: string; state: string }
  | {
      type: "voice.transcript";
      epoch: string;
      utteranceId: string;
      provider: "openai" | "yandex";
      status: "partial" | "final" | "refinement" | "failed";
      text?: string;
      providerItemId?: string;
      readyAt?: string;
    }
  | { type: "voice.turn"; epoch: string; result: unknown; dsr: unknown }
  | { type: "voice.playback.start"; epoch: string; playbackId: string; sampleRate: 16000 }
  | { type: "voice.playback.end"; epoch: string; playbackId: string }
  | { type: "voice.playback.interrupted"; epoch: string; playbackId: string }
  | { type: "voice.error"; epoch: string; code: string; message: string };
