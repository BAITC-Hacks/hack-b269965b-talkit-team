# SpeechKit v3 proto definitions

These are the minimal official protobuf definitions needed by the SpeechKit v3 streaming STT adapter. They are source assets for the server build, not generated application code.

- Yandex Cloud API definitions: `yandex/cloud/**`, from [yandex-cloud/cloudapi](https://github.com/yandex-cloud/cloudapi) at commit `9286306b18c5166bb6f3ff59e57314d0cfa0e8c5`; MIT license in `LICENSE.yandex`.
- Google API dependencies: `google/**`, from [googleapis/googleapis](https://github.com/googleapis/googleapis) at commit `9b719a5c153f3ec7a14d5d45d4da720410c7b943`; Apache-2.0 license in `LICENSE.google`.

The server loads these definitions with `@grpc/proto-loader`. Keep their import paths intact when updating them.

## Role in Voice Router

These files describe the wire format for the second speech recognizer in the HackAlem AI case owned by Halyk Bank. They do not select scenarios, synthesize speech, contain credentials or run a separate service. The LLM router and provider configuration belong to the server.

[The gRPC adapter](../../../src/server/features/voice/yandex-grpc.ts) loads `source/yandex/cloud/ai/stt/v3/stt_service.proto` at runtime. Keep `source/`, its import structure and both license files in deployments; the Dockerfile copies `data/` alongside `dist/`.

The adapter signs a JWT using `YANDEX_SERVICE_ACCOUNT_ID`, `YANDEX_SERVICE_ACCOUNT_KEY_ID` and the matching PEM `YANDEX_SERVICE_ACCOUNT_PRIVATE_KEY`, obtains an IAM token from `iam.api.yandexcloud.kz`, then calls `stt.api.ml.yandexcloud.kz:443` with that token and `YANDEX_FOLDER_ID`. All four fields belong only in server configuration. Never store authorized-key exports in this directory.

Expected behavior: incoming PCM16 mono 16 kHz produces STT hypotheses that DSR compares with OpenAI's transcript. Missing Yandex settings leave the second recognizer unavailable; the OpenAI-only path is explicitly degraded. A schema file being present does not prove account permissions, quota or network access.

## Run, deploy and test

There is no package or independent build here. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm run check
```

No `.env` is needed to open the application without providers. Full configuration, local `doctor` requirements and Node/HTTPS deployment are documented in the [project README](../../../README.md). Compose does not pass provider credentials by default. An image built with an `env -u` ENTRYPOINT additionally strips them at startup; that image cannot run live SpeechKit as configured.

`tests/voice/yandex-stt.test.ts` covers the adapter using a fake stream; DSR and WebSocket regressions are also local. `pnpm run verify` checks types/tests/build/smoke, not live gRPC authentication. A real RU/KK call with approved credentials must be tested separately and recorded in [STATUS](../../../docs/STATUS.md).

Keep the upstream source commits and licenses above when updating definitions. Do not change protobuf fields to hide integration errors or attribute upstream code to the hackathon team.
