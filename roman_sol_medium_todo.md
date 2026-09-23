# Voice Router — TODO для GPT-6 Sol (`medium`)

## Цель

За 120 минут получить честное P0-демо Voice Router поверх текущего H3 1.x/Vue 3 starter. Связь приложения с frontend строится через один WebSocket; текст и голос сходятся в одном серверном `handleTurn`, используют одну сессию, одну историю и один LLM-router.

Этот файл — план исполнения, а не отчёт о готовности. Отмечать пункт выполненным можно только после фактической проверки.

## Зафиксированные решения

- Первый изменяемый артефакт P0 — контракт WebSocket для frontend.
- OpenAPI не является основным контрактом: OpenAPI 3.1 не описывает полноценно двусторонние сообщения и бинарные аудиофреймы WebSocket. Существующий `GET /api/health` остаётся HTTP; отдельная OpenAPI-спецификация для него в двухчасовой P0 не нужна.
- Исполняемый источник истины для протокола — общие Zod-схемы и типы в `src/shared`; рядом должен быть короткий человекочитаемый документ с последовательностями сообщений. AsyncAPI можно добавить в P1, если контракт нужен внешнему потребителю.
- P0 — turn-based voice: `MediaRecorder` передаёт ограниченную запись по WebSocket, сервер делает STT после `audio.stop`, затем запускает router. Не называть это streaming STT или full duplex.
- P0 следует приложенному двухчасовому промпту: один server-side OpenAI adapter для STT и structured routing, browser `speechSynthesis` для TTS. Старые идеи из `docs/TASK.md` про DSR, ElevenLabs и `gpt-realtime` не смешивать с P0; они возможны только после отдельного решения в P1.
- `gpt-6-sol` — модель coding-агента, не runtime-модель приложения. Runtime model IDs задаются только env.
- TalkIt production backend, SDK и AudioWorklet в P0 не переносить.
- Не выполнять сетевой bulk-eval, платные запросы, отправку сообщений или внешние действия без отдельного разрешения.

## Фактическая стартовая точка

- На момент составления плана worktree чистый; перед реализацией проверить статус заново.
- В target есть только health/echo и базовый Vue-экран; предметной логики Voice Router нет.
- `docs/BRIEF.md`, `docs/PREEXISTING.md` и `docs/PROGRESS.md` в target отсутствуют. Шаблоны первых двух находятся в starter; отсутствие уже известно и не должно запускать долгий поиск.
- Исходный датасет доступен только для чтения в `C:\Users\user\Desktop\talkit\case_2\voice_router_dataset`.
- Все восемь перечисленных в исходном промпте TalkIt reference-файлов существуют, но для P0 достаточно точечно прочитать lifecycle из `AgentVoicePreviewCard.vue`; остальные не копировать без нужды.
- Runtime-сборка Docker получает только `dist`, поэтому server-only JSON должен явно копироваться в `dist` во время build.

## Правила исполнения для Sol Medium

1. Не запускать субагентов и не менять соседние TalkIt-репозитории.
2. Выполнять пункты строго по порядку. Не начинать voice, пока текстовый WebSocket E2E не работает.
3. Перед каждой группой правок перечитывать только указанные файлы и использовать точечный `rg`.
4. Не создавать абстракции «на будущее»: один transport, один provider adapter, один session store, один router pipeline.
5. После каждого checkpoint оставлять приложение запускаемым и запускать указанные проверки.
6. Не выдавать fake adapter, browser fallback или отсутствие credentials за live provider success.
7. Не логировать transcript, аудио, phone, IIN, provider body, ключи и полные mock records.

## Бюджет 120 минут

| Окно | Результат |
| --- | --- |
| 0–15 мин | Зафиксирован и протестирован frontend WebSocket contract |
| 15–30 мин | Поднят безопасный WS transport и session lifecycle |
| 30–65 мин | Работает text → WS → real LLM → validated result → trace → UI |
| 65–100 мин | Работает turn-based microphone → WS audio → STT → тот же pipeline → browser TTS |
| 100–120 мин | Критические тесты, format/check/verify, фактический progress |

Время — ориентир. Если текстовый checkpoint не готов к 65-й минуте, не урезать его ради фиктивного voice.

# P0 — обязательное демо

## P0.0 — безопасный preflight, без изменений

- [ ] Выполнить `git status --short`; остановиться при пересечении с чужими изменениями.
- [ ] Прочитать актуальные `AGENTS.md`, `README.md`, `package.json`, `src/server/app.ts`, `src/server/server.ts`, `src/web/App.vue`, тестовые helpers и исходный `README.ru.md` датасета.
- [ ] Кратко посмотреть lifecycle в `talkit-web/app/components/agents/AgentVoicePreviewCard.vue`: single in-flight start, mute, interrupt и cleanup. Использовать как reference, не копировать компонент целиком.
- [ ] Зафиксировать, какие provider credentials реально доступны. Отсутствие ключа не блокирует unit/integration tests, но блокирует заявление о live E2E.

## P0.1 — сначала frontend WebSocket contract

Первой правкой создать `src/shared/voice-router.ts` и `docs/voice-router-ws.md`. До этого не писать server handler или Vue-кнопки.

- [ ] Описать версию протокола `1` и единый JSON envelope: `protocolVersion`, `type`, `eventId`, `sequence`, `occurredAt`, `payload`; `sessionId` отсутствует только в первом `session.start` и обязателен после `session.ready`, `turnId` обязателен для сообщений конкретного хода. `sequence` монотонен отдельно для каждого направления внутри session.
- [ ] Сделать строгие Zod discriminated unions отдельно для client и server messages. Экспортировать только browser-safe типы; никаких env, provider payloads и полного датасета.
- [ ] Зафиксировать client → server команды:
  - `session.start`;
  - `turn.text` с непустым ограниченным `text`;
  - `audio.start` с `mimeType` и client timestamp;
  - бинарные audio frames только между `audio.start` и `audio.stop`;
  - `audio.stop`;
  - `response.interrupt`;
  - `client.tts_started` для browser-измерения;
  - `session.end`;
  - опциональный `ping`.
- [ ] Зафиксировать server → client события:
  - `session.ready`;
  - `audio.ready` с назначенным `turnId` и лимитами, после которого frontend может отправлять binary frames;
  - `state.changed`;
  - `transcript.final`;
  - `turn.completed` с ответом, routing и итоговым trace;
  - `turn.interrupted`;
  - `trace.updated`, когда frontend прислал начало TTS;
  - `error` с безопасным `code`, `message`, `requestId`, `recoverable`;
  - `session.ended`;
  - опциональный `pong`.
- [ ] Описать состояния controller: `idle | connecting | recording | transcribing | thinking | speaking | ended | error` и допустимые переходы.
- [ ] Описать P0-политику binary audio: только один активный audio turn, обязательный ack `audio.ready`, allowlist фактически поддержанного MIME, общий лимит байтов/длительности, закрытие с policy error при нарушении порядка.
- [ ] Описать backpressure: не больше одного активного turn на session; новый turn отклоняется `TURN_IN_PROGRESS`, пока frontend явно не отправит `response.interrupt` или текущий ход не завершится.
- [ ] Описать reconnect: в P0 автоматического resume/replay нет; после потери socket создаётся новая session. Старые события фильтруются по `sessionId`, `turnId` и `sequence`.
- [ ] Определить публичный `TurnResult`:
  - `turn`, `transcript`, `language`, `topicRelation`;
  - `selected[]` с `scenarioId`, `confidence`, коротким `reason`;
  - `alternatives[]`, `slots`, `missingSlots`;
  - `needsClarification`, `clarificationQuestion`;
  - `actions[]`, `assistantText`, `dataSources[]`;
  - `latencyMs`: `stt`, `triage`, `router`, `response`, `ttsFirstAudio`, `total`; неизмеренное значение — `null`, не `0`.
- [ ] Добавить contract tests: валидные примеры всех сообщений проходят; неизвестный `type`, лишние поля, неверный порядок/диапазоны и небезопасные payloads отклоняются.

Критерий готовности: frontend и server могут разрабатываться по одним импортируемым схемам; в UI не требуется угадывать поля или строки событий.

## P0.2 — WebSocket transport и lifecycle

Целевые файлы: `src/server/features/voice-router/ws.ts`, минимальные изменения `src/server/server.ts`, `src/server/index.ts`, `vite.config.ts`, `src/web/features/voice-router/socket.ts`.

- [ ] Выбрать один совместимый с текущим `node:http` WebSocket server implementation. Если в установленном H3 1.x нет уже работающего пути, добавить только пакет `ws`; не мигрировать H3 и не строить transport abstraction.
- [ ] Обрабатывать upgrade только на `/api/voice-router/ws`; остальные upgrade-запросы отклонять.
- [ ] В dev включить `ws: true` в Vite proxy для `/api`; production использует тот же origin.
- [ ] Ограничить `maxPayload`, число connections/sessions, idle TTL и размер накопленного аудио. Проверить `Origin` для browser-запросов.
- [ ] На `session.start` создать случайный server-side `sessionId`; не принимать клиентский ID как доказательство существующей сессии.
- [ ] Валидировать каждое текстовое сообщение общей Zod-схемой до dispatch. Ошибка одного сообщения не должна раскрывать payload или ронять процесс.
- [ ] При disconnect/end/interrupt отменять AbortController, очищать timers/audio buffers и удалять session state.
- [ ] При shutdown закрывать WS server и активные sockets до завершения процесса.
- [ ] Frontend wrapper использует native `WebSocket`, валидирует входящие события и предоставляет `connect`, `sendText`, `startAudio`, `sendAudioChunk`, `stopAudio`, `interrupt`, `end`, `destroy`.
- [ ] Интеграционный тест через реальный локальный HTTP/WS server проверяет connect, invalid message, один текстовый fake turn, interrupt и cleanup.

Checkpoint: `pnpm run check` зелёный для baseline + transport tests.

## P0.3 — server-only dataset и loader

Целевой каталог: `src/server/features/voice-router/data/`.

- [ ] Без изменения содержимого скопировать только `scenarios.json`, `slots.json`, `actions.json`, `knowledge_base.json`, `mock_backend.json`, `dialogs_sample.json`, `dev_utterances.json`.
- [ ] Не копировать `.DS_Store`, README и `evaluate.py`, пока они не используются реальной командой.
- [ ] Добавить build-step, который копирует data в `dist/server/features/voice-router/data/`; production не должен читать абсолютный sibling path.
- [ ] Loader один раз при старте проверяет:
  - ровно 40 уникальных `SC01`…`SC40`;
  - наличие `SYS_OUT_OF_SCOPE`, `SYS_UNCLEAR`, `SYS_GOODBYE`;
  - существование всех slot/action refs;
  - `meta.as_of_date === "2026-10-01"`;
  - понятную startup error для отсутствующего/битого файла.
- [ ] Использовать реальные имена полей датасета, а не менять JSON под заранее придуманную schema.
- [ ] Не отдавать каталог, knowledge base или mock backend целиком во frontend.
- [ ] Добавить loader tests и тест наличия JSON после `pnpm run build`.

## P0.4 — один LLM/STT adapter и конфигурация

Целевые файлы: `src/server/env.ts`, `.env.example`, `src/server/features/voice-router/openai.ts` или один аналогичный integration-файл.

- [ ] Перед реализацией provider calls сверить текущие официальные OpenAI API docs для выбранных runtime-моделей; не угадывать endpoint/model compatibility.
- [ ] Добавить server-only настройки `OPENAI_API_KEY`, `OPENAI_ROUTER_MODEL`, `OPENAI_STT_MODEL`, таймауты и безопасные лимиты. Не использовать `VITE_`.
- [ ] Реализовать один adapter с двумя узкими методами: `transcribe(audio, signal)` и `routeTurn(input, signal)`.
- [ ] На turn делать ровно один structured-output LLM call, который возвращает routing и короткий grounded ответ.
- [ ] Валидировать provider output Zod-схемой, затем серверной policy; response модели не является доверенным DTO.
- [ ] При отсутствии/ошибке конфигурации отправлять контролируемый `PROVIDER_UNAVAILABLE`/`503`-эквивалент в WS error, а не эвристический success.
- [ ] Не логировать request/response body провайдера. Логировать только request ID, stage, безопасный error type и duration.
- [ ] Предусмотреть fake LLM/STT adapters через простой параметр фабрики/handler для тестов; не вводить DI-контейнер или registry providers.

## P0.5 — session state, routing policy и grounding

Целевые файлы: `catalog.ts`, `state.ts`, `router.ts`, `policy.ts`, `grounding.ts`, `handle-turn.ts` — объединять файлы, если код остаётся коротким.

- [ ] Ограниченный in-memory store: случайный `sessionId`, максимум 10 turns, TTL, общий лимит sessions, cleanup timer.
- [ ] В LLM input передавать текущий transcript, максимум 4 последних turns/summary, active scenarios, slots, pending confirmation, компактный каталог 40 сценариев и knowledge base.
- [ ] Из `mock_backend` передавать только записи, детерминированно найденные по явно упомянутому phone/IIN/policy/claim/plate.
- [ ] После модели отклонять неизвестные scenario/action IDs, дубликаты и пересечение `selected`/`alternatives`.
- [ ] Policy:
  - `confidence >= 0.75` — принять сценарий;
  - `0.45 <= confidence < 0.75` — `SYS_UNCLEAR` и один короткий вопрос с двумя вариантами;
  - `< 0.45` два turns подряд или явная просьба — handoff/operator;
  - multi-intent: `urgent` первым, остальные по порядку упоминания;
  - continuation заполняет slots, явный topic shift меняет состояние;
  - irreversible action только `preview`; `execute` — лишь после явного подтверждения и только для mock action.
- [ ] Ответ — 1–2 предложения на языке клиента, только по dataset/provider results. Не выполнять реальные SMS/email/платежи/внешние действия.
- [ ] Один `handleTurn` принимает нормализованный transcript как от `turn.text`, так и от STT; transport не содержит бизнес-логику.
- [ ] Trace содержит продуктовый reason, не chain-of-thought, и реальные server timestamps.

## P0.6 — обязательный text E2E checkpoint

Целевые frontend-файлы: `src/web/features/voice-router/api.ts`, `useVoiceRouter.ts`, `VoiceRouterPage.vue`, `TracePanel.vue`; заменить echo-экран минимально.

- [ ] Подключить страницу к socket wrapper и общей схеме сообщений.
- [ ] Показать connection/state, textarea, Send, Interrupt, End/New session, ответ, selected scenarios, alternatives, reason и latency.
- [ ] `turn.text` проходит по цепочке `Vue → WebSocket → handleTurn → real LLM → validation/policy → grounded result → WebSocket → Vue`.
- [ ] Abort/interrupt не позволяет позднему результату изменить UI или session state.
- [ ] Показать понятную ошибку при отсутствии credentials; не переключаться автоматически на fake success.
- [ ] Проверить новую RU-фразу и одну KK/mixed-фразу, которых нет в коде. Live результат записывать только если вызов реально выполнен.

Gate: до рабочего text E2E и зелёных targeted tests не начинать microphone/TTS.

## P0.7 — turn-based voice через тот же WebSocket

- [ ] Запрашивать микрофон только после явного клика.
- [ ] Использовать один `MediaStream`/`MediaRecorder`; повторный start не создаёт второй recorder.
- [ ] Выбрать поддержанный браузером MIME через `MediaRecorder.isTypeSupported`; отправить `audio.start`, дождаться `audio.ready`, затем отправлять binary chunks и завершить `audio.stop`. До ack первые chunks держать в небольшом локальном буфере.
- [ ] Сервер принимает chunks только в состоянии recording, ограничивает bytes/time, собирает одну реплику и вызывает server-side STT ровно один раз после stop.
- [ ] `transcript.final` подаётся в тот же `handleTurn`; text и voice используют один `sessionId` и историю.
- [ ] Если server STT недоступен, browser `SpeechRecognition` разрешён только как явно подписанный Chrome/Edge fallback; его результат всё равно отправляется по WebSocket как текст. Не называть fallback TalkIt или гарантированным mixed-language STT.
- [ ] Озвучивать `assistantText` через browser `speechSynthesis`, выбирать доступный RU/KK voice по языку и отправлять `client.tts_started` на `onstart`.
- [ ] `interrupt()` отменяет server turn, останавливает recorder при необходимости и вызывает `speechSynthesis.cancel()`.
- [ ] `destroy()` снимает listeners, останавливает tracks, timers и playback; поздние события после destroy игнорируются.
- [ ] Новый turn отменяет старый playback. Mute не завершает session.

## P0.8 — критические тесты и доказательство

- [ ] Contracts: все команды/события, строгие payloads, неизвестный type, nullable timings.
- [ ] WS: upgrade path, origin/payload limits, invalid order, parallel turn, interrupt, disconnect и shutdown cleanup.
- [ ] Loader: 40 сценариев, 3 system intents, уникальность и refs.
- [ ] Router/policy: неизвестный ID/action, selected/alternatives overlap, RU, KK/mixed, multi-intent, clarification, continuation.
- [ ] Grounding: неизвестный идентификатор не создаёт вымышленную запись.
- [ ] Controller: parallel start, binary send order, interrupt, TTS cancel и destroy через browser fakes.
- [ ] Убедиться, что существующие health/404/static/smoke проверки не сломаны; обновить SSR-тест под честный initial UI.
- [ ] Запустить `pnpm run format`, затем `pnpm run check`, затем `pnpm run verify`.
- [ ] При доступной browser-среде и credentials вручную проверить RU, KK/mixed, multi-intent, ambiguous и interrupt. Не заявлять live voice success без этой проверки.
- [ ] Создать/обновить `docs/PROGRESS.md` только фактическими изменениями, командами и результатами; отдельно перечислить непроверенное.

## Definition of Done P0

- [ ] Frontend и server используют один версионированный WS message contract из `src/shared`.
- [ ] Text turn реально проходит через server-side LLM и возвращает validated routing, grounded reply и trace.
- [ ] Browser voice реально проходит через выбранный STT path, тот же router/session и слышимый browser TTS.
- [ ] Работают interrupt, end, disconnect и cleanup без позднего изменения state.
- [ ] RU, KK/mixed, multi-intent и clarification доказаны offline tests; live-проверки перечислены отдельно.
- [ ] Dataset и keys остаются server-only; логи не содержат transcript/PII/provider bodies.
- [ ] `pnpm run check` и `pnpm run verify` имеют честно записанный результат.

# P1 — только после зелёного P0

Выполнять по порядку ценности. Не начинать P1 при красном `pnpm run check`.

## P1.1 — eval и улучшение качества

- [ ] После разрешения пользователя добавить отдельную `eval:router` команду, генерирующую predictions для `dev_utterances.json` в формате `evaluate.py`.
- [ ] Не передавать `expected`, `type` и соседние примеры в runtime prompt; каждый eval item получает чистую session.
- [ ] Не запускать 104 платных запроса без подтверждения.
- [ ] Улучшать router prompt только по зафиксированным ошибкам и повторять те же измерения.

## P1.2 — формальная AsyncAPI-спецификация

- [ ] Если контракт нужен вне этого репозитория, добавить минимальную AsyncAPI 3.x spec для `/api/voice-router/ws` и привязать message schemas к P0-контракту.
- [ ] Добавить validation/drift check, чтобы AsyncAPI и Zod не расходились.
- [ ] OpenAPI добавлять только если появятся реальные REST endpoints помимо существующего health; не дублировать WS messages в фиктивные HTTP routes.

## P1.3 — улучшенный speech transport

- [ ] Добавить streaming STT или server TTS только при уже доступных credentials/API и измеримой пользе.
- [ ] TalkIt/AudioWorklet transport добавлять только при доказанно совместимом backend, auth и session-token endpoint.
- [ ] Для PCM сохранить контракт 16 kHz mono PCM16, 320 samples/640 bytes и проверить реальный wire protocol.
- [ ] Не называть production TalkIt перенесённым, если фактически используется собственный WS + MediaRecorder/provider adapter.

## P1.4 — подробная диагностика и действия

- [ ] Добавить bounded raw voice events, сортировку по `sequence`, затем `occurredAt`, и более точную latency timeline.
- [ ] Разделить server clock и browser clock; end-to-first-audio считать только после фактического playback start.
- [ ] Расширить mock action executor по ценности, не создавая 40 классов/workflow.
- [ ] Добавить session resume только с явным протоколом replay/idempotency; не маскировать reconnect новой session.

## Финальный отчёт агента

Коротко сообщить:

1. Что реально работает E2E и какой WebSocket/audio/STT/TTS path выбран.
2. Какие target-файлы изменены.
3. Какие source-файлы были `copied`, `adapted` или `reference only`.
4. Реальные результаты `check`, `verify` и ручных smoke-проверок.
5. Что осталось P1, что не проверено и какие credentials/внешние условия блокируют live-демо.
