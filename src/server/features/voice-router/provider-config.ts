// Server-only provider settings. Reading them never makes a missing provider appear ready.
export function readVoiceProviderConfig(env: Record<string, string | undefined>) {
  return {
    openai: {
      apiKey: env.OPENAI_API_KEY?.trim() || undefined,
      routerModel: "gpt-realtime",
      sttModel: "gpt-4o-transcribe",
    },
    yandex: {
      serviceAccountId: env.YANDEX_SERVICE_ACCOUNT_ID?.trim() || undefined,
      serviceAccountKeyId: env.YANDEX_SERVICE_ACCOUNT_KEY_ID?.trim() || undefined,
      serviceAccountPrivateKey: env.YANDEX_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() || undefined,
      folderId: env.YANDEX_FOLDER_ID?.trim() || undefined,
    },
    elevenlabs: {
      apiKey: env.ELEVENLABS_API_KEY?.trim() || undefined,
      voiceId: env.ELEVENLABS_VOICE_ID?.trim() || undefined,
      model: "eleven_v3",
    },
  };
}
