# SpeechKit v3 proto definitions

These are the minimal official protobuf definitions needed by the SpeechKit v3 streaming STT adapter. They are source assets for the server build, not generated application code.

- Yandex Cloud API definitions: `yandex/cloud/**`, from [yandex-cloud/cloudapi](https://github.com/yandex-cloud/cloudapi) at commit `9286306b18c5166bb6f3ff59e57314d0cfa0e8c5`; MIT license in `LICENSE.yandex`.
- Google API dependencies: `google/**`, from [googleapis/googleapis](https://github.com/googleapis/googleapis) at commit `9b719a5c153f3ec7a14d5d45d4da720410c7b943`; Apache-2.0 license in `LICENSE.google`.

The server loads these definitions with `@grpc/proto-loader`. Keep their import paths intact when updating them.
