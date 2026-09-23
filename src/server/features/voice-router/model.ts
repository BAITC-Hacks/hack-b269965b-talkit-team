export interface FunctionTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface FunctionCallResult {
  name: string;
  arguments: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
  };
}

export interface VoiceRouterModelSession {
  isOpen?(): boolean;
  callFunction(input: {
    instructions: string;
    text: string;
    tool: FunctionTool;
    signal?: AbortSignal;
  }): Promise<FunctionCallResult>;
  generateText(input: {
    instructions: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<string>;
  close(): void;
}

export interface VoiceRouterModelProvider {
  readonly model: string;
  openSession(signal?: AbortSignal): Promise<VoiceRouterModelSession>;
}

export type ModelProviderErrorKind = "unavailable" | "transport" | "protocol" | "output";

export class ModelProviderError extends Error {
  readonly kind: ModelProviderErrorKind;

  constructor(kind: ModelProviderErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProviderError";
    this.kind = kind;
  }
}
