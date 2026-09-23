# Основания и проверенные ограничения

> Справочный материал исходного пакета. При этой реорганизации API-сведения не перепроверялись; перед изменением интеграции сверяй нужный контракт и фактический адаптер.

План составлен 23 сентября 2026 года. Это спецификация предлагаемых работ, не отчёт об их исполнении.

## Материалы пользователя

- ТЗ Voice Router: голос в вебе и текстовый резерв, LLM-выбор 40 сценариев, русский/казахский/смешанная речь, трассировка, подтверждение необратимых действий, запуск одной командой. Ориентиры 500 мс для выбора маршрута и 1,5 секунды до голоса — цели измерения, не обещанные показатели.
- a.zip / voice_router_dataset.zip: README, каталог, слоты, action contracts, synthetic backend/knowledge base, dev-реплики, примерные диалоги, evaluator. Runtime-функций бэкенда комплект не содержит.
- hackalem-starter.zip: single-package Node.js/H3 1.x/Vue/Vite, AGENTS.md, docs/runbooks/VALIDATION.md и команды check/verify. Сохранять реально установленный совместимый стек текущего репозитория, а не blindly перепинивать его.
- hackalem-docs.zip: ранее предложенные роли, правила работы, стартовый prompt и runbook. Эти документы не доказывают разрешение организатора на импорт pre-existing кода.
- Указание пользователя: сильная сторона TalkIt — DSR OpenAI STT/VAD + Yandex SpeechKit; TTS — ElevenLabs V3; использовался gpt-realtime. Исходный код этих адаптеров в пакет заданий не включён.

## Официальная документация API

1. OpenAI gpt-realtime: text/audio input/output, function calling; Structured Outputs не поддерживаются. Поэтому route_turn + серверная Zod-валидация, не обещание strict schema от модели.
   https://developers.openai.com/api/docs/models/gpt-realtime
2. Realtime conversations: текстовые conversation items, response.create, текстовые ответы, function calling и ручное управление ответом при включённом VAD. Точные event shapes проверить для используемой версии API.
   https://developers.openai.com/api/docs/guides/realtime-conversations
3. Transcription-only sessions отделяют распознавание от разговора с моделью.
   https://developers.openai.com/api/docs/guides/realtime-transcription
4. Yandex SpeechKit streaming: разные типы partial/final/final_refinement и собственные границы фразы; это требует согласования событий DSR, а не двух независимых запусков бизнес-хода.
   https://yandex.cloud/ru-kz/docs/speechkit/stt/streaming
5. ElevenLabs: обычный TTS WebSocket не поддерживает eleven_v3; для v3 существует Text-to-Dialogue WebSocket с отдельным протоколом. Работающий прежний адаптер не следует менять только ради использования нового endpoint.
   https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets
   https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
   https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket

Не делается предположений о том, какой провайдер точнее на конкретном языке, каков реальный DSR-алгоритм TalkIt, сколько займут API-вызовы и доступны ли ключи/модели в аккаунтах команды. Это проверяется smoke/eval на месте.

## Осмотр доступных реализаций для Phase 0

Пути ниже относительны к внутренним пакетам TalkIt, доступным команде для чтения. Никакой код этих пакетов в Voice Router пока не копировался. Доступность ключей, услуг и разрешение на перенос не подтверждены.

| Область        | Исходный модуль                                                                                                         | Проверенный контракт                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| STT            | `talkit-ai/src/instances/voice/types/VoiceSTTModel.ts`                                                                  | `connect`, `disconnect`, `sendAudioChunk`, `commit(utteranceId)` и события распознавания/VAD                                                                                         |
| OpenAI STT/VAD | `talkit-ai/src/instances/voice/providers/openai/stt.ts`, `OpenAISttRuntimePolicy.ts`                                    | Realtime transcription через WebSocket/Bearer; `gpt-4o-transcribe` по умолчанию, альтернативно `gpt-live-transcribe`; server VAD даёт границу и item ID                              |
| Yandex STT     | `talkit-ai/src/instances/voice/providers/yandex/stt/index.ts`, `sdk.ts`                                                 | SpeechKit v3 gRPC, PCM16 16 kHz mono, ru-RU/en-US/kk-KZ; IAM service account и folder ID; внешний EOU связывает результат с OpenAI utterance ID                                      |
| DSR            | `talkit-ai/src/instances/voice/session/orchestration/input/VoiceSttTurnCoordinator.ts`, `VoiceInputTurnOrchestrator.ts` | Один PCM-поток обоим провайдерам; bounded wait и корреляция по utterance ID. Текущая логика authoritative/supportive не выполняет всех требований целевого DSR agreement.            |
| TTS            | `talkit-ai/src/instances/voice/providers/elevenlabs/ElevenLabsTextAudioRenderer.ts`                                     | ElevenLabs HTTP stream для готового текста, `eleven_v3`, PCM16 16 kHz, `AbortController`, серверный API key и voice ID                                                               |
| Browser call   | `talkit-monorepo/packages/talkit-js/src/talkit-call.ts`, `talkit-pcm-capture.worklet.js`                                | `getUserMedia` + AudioWorklet + WebSocket; бинарные PCM16 16 kHz mono кадры по 20 мс, JSON control, остановка playback при interrupt и cleanup при stop                              |
| LLM transport  | `talkit-realtime-sdk/src/openai-realtime.ts`                                                                            | Node WebSocket с Bearer; для выбранного `gpt-realtime` нужны text item, `response.create`, финальные function arguments и отдельный function output. Живое подключение не проверено. |

OpenAI STT получает 24 kHz после FFmpeg 16→24 kHz; Yandex получает исходные 16 kHz. У браузерного вызова нет WebRTC и автоматического восстановления звонка. Для выбранного Realtime router используется `gpt-realtime` с function calling; Structured Outputs модель не поддерживает. Ни один API key не зафиксирован в репозитории.

Исходная речевая реализация зависит от `ws`, ElevenLabs SDK, gRPC/proto-loader, `node-jose`, `axios`, FFmpeg и внутренних пакетов. Эти зависимости не добавлены в Phase 0. Конкретные точные версии и live-доступ будут проверены при интеграции Phase 1/2; наличие читаемого кода не является подтверждением доступности сервиса.
