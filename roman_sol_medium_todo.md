# Voice Router Web Realtime — TODO для GPT-6 Sol (`medium`)

## Цель

Подготовить внутри `src/web` независимый frontend realtime-слой для двустороннего соединения с будущим backend:

`микрофон → PCM16 frames → WebSocket → backend → audio frames → browser playback`.

UI будет реализован отдельно и позже получен через `git pull`. Текущая работа не создаёт страницу, визуальные компоненты или временный demo-экран. Результат — browser-side transport/controller API, который будущий UI сможет подключить без знания деталей WebSocket, записи и воспроизведения.

Этот файл — план исполнения, а не отчёт о готовности. Пункты отмечаются только после фактической проверки.

## Жёсткие границы

- Реализацию изменять только внутри `src/web`.
- Не изменять `src/server`: backend будет разработан отдельно и позже получен через pull.
- Не изменять `src/shared`: до появления согласованного backend-контракта frontend использует локальный protocol adapter внутри feature.
- Не изменять `App.vue`, `pages/`, существующий UI и стили: новый UI придёт отдельно.
- Не изменять root-конфиги, `vite.config.ts`, `package.json`, lockfile, `.env*`, Docker и scripts.
- Не изменять существующие файлы в `tests/`: допустимы только текущие `typecheck`, `check`, `build` и `verify` без расширения test harness за пределами `src/web`.
- Не копировать TalkIt/server adapters, ключи, dataset, provider payloads или бизнес-логику в browser.
- Не подключаться из browser напрямую к OpenAI, Yandex или ElevenLabs с постоянным API key. Frontend соединяется только с backend приложения.

Разрешённые target-файлы:

- `src/web/features/voice-router/realtime/*` — protocol, WebSocket transport, PCM capture/playback и controller;
- при необходимости `src/web/features/voice-router/index.ts` — публичные browser-safe exports;
- этот TODO — зафиксировать границы и фактический план.

## Текущая точка после pull и аудита P0

- Проверенный `HEAD` — `7c433e1` (`init main audio protocols and sockets`); перед правкой TODO рабочее дерево было чистым.
- В `src/web/features/voice-router/realtime/` появился независимый realtime-слой, но `App.vue`/`main.ts` его не импортируют. Поэтому обычный Vite build проверяет типы файлов через `vue-tsc`, но не доказывает, что realtime-код и AudioWorklet входят в фактический browser bundle.
- Полученный backend реализует HTTP `POST /api/voice-router/turn` и собственное server-to-OpenAI Realtime соединение. Browser endpoint `/api/voice-router/ws`, обработчик HTTP upgrade, STT/DSR и TTS audio stream в текущем коде отсутствуют. Локальный `protocol.ts` всё ещё является предложением, а не согласованным контрактом.
- Vite proxy для `/api` не содержит `ws: true`. Менять `vite.config.ts` в рамках этой frontend-задачи нельзя; требование передаётся владельцу root config.
- Стратегия browser auth/origin, формат аудио backend → browser, порядок `turn.completed` относительно audio events и схема публичного результата не согласованы.
- `pnpm.cmd install --frozen-lockfile` потребовался после pull, потому что локально отсутствовали новые `ws`/`@types/ws`. После синхронизации `pnpm.cmd run check` прошёл: typecheck и 36/36 тестов. Отдельные `build` и `smoke:built` также прошли. Realtime-specific тестов среди этих 36 нет.
- Изолированная Vite library build public entry прошла без записи на диск и содержит protocol/controller и inline AudioWorklet marker. Обычная application build их не содержит, потому что приложение feature не импортирует.
- В `docs/STATUS.md` в текущем `HEAD` закоммичены два неразрешённых conflict-блока (`<<<<<<< Updated upstream` / `>>>>>>> Stashed changes`). Это дефект полученных изменений вне разрешённой области `src/web`; в этой задаче файл не исправляется.

## Зафиксированные frontend-решения

- Один `RealtimeVoiceClient` владеет одной WebSocket session, одной записью микрофона и одной очередью playback.
- Нативный `WebSocket`; без Socket.IO, дополнительного SDK или второго transport abstraction.
- Исходящий звук: mono PCM16 little-endian, 16 kHz, frames по 320 samples / 640 bytes, если backend при handshake не согласует другое.
- Захват: `getUserMedia` + `AudioWorklet`; микрофон запрашивается только из явного вызова будущего UI.
- Входящий звук: бинарные PCM16 frames воспроизводятся через Web Audio queue; JSON никогда не трактуется как audio.
- Сначала `session.start → session.ready`, затем `audio.start → audio.ready`, и только после ack отправляются binary frames.
- Не больше одного активного audio turn. Новый turn до `audio.stop`/interrupt отклоняется локально.
- `interrupt()` останавливает capture, очищает bounded outbox, отправляет cancel и немедленно прекращает playback.
- Автоматического session resume/replay нет. Reconnect создаёт новую session; старые socket events игнорируются через generation token.
- Backpressure ограничен: аудио не накапливается бесконечно. При переполнении client завершает turn с явной ошибкой вместо скрытой потери произвольных фрагментов.
- Future UI получает immutable state snapshots и typed events; controller не импортирует Vue и не управляет DOM.

## Предлагаемый protocol boundary

Все названия ниже временные до backend pull и меняются только в `realtime/protocol.ts`.

Client JSON:

- `session.start` — версия протокола и поддерживаемый audio format;
- `audio.start` — новый `turnId` и фактический capture format;
- `audio.stop` — последний sequence отправлен;
- `response.cancel` — interrupt активного turn/playback;
- `ping` — heartbeat.

Server JSON:

- `session.ready` — server `sessionId`, согласованный format и лимиты;
- `audio.ready` — backend готов принимать binary frames текущего `turnId`;
- `response.audio.start` / `response.audio.end` — границы входящего бинарного audio;
- `turn.completed` — финальный публичный результат/trace для будущего UI;
- `turn.interrupted` — подтверждение cancel;
- `error` — безопасный code/message/recoverable;
- `pong` — heartbeat response.

Binary frames:

- client → server допустимы только после `audio.ready` и до `audio.stop`;
- server → client допустимы только между `response.audio.start` и `response.audio.end`;
- один binary message содержит целое число PCM16 samples; нечётный размер отклоняется.

## Бюджет первого шага

| Окно        | Результат                                                            |
| ----------- | -------------------------------------------------------------------- |
| 0–15 мин    | Локальный protocol adapter и публичные типы                          |
| 15–45 мин   | WebSocket lifecycle, handshake, heartbeat, bounded outbox, cleanup   |
| 45–75 мин   | AudioWorklet capture, resampling и PCM16 framing                     |
| 75–100 мин  | PCM16 playback queue и interrupt                                     |
| 100–120 мин | RealtimeVoiceClient, typecheck/check/build и список backend blockers |

# P0 — frontend realtime foundation

## P0.0 — preflight

- [x] Проверить `git status --short` и `git log -1 --oneline`; не редактировать чужие незавершённые файлы.
- [x] Прочитать текущий `src/web/README.md`, `tsconfig.web.json`, browser entry и существующие feature conventions.
- [x] Зафиксировать запрет на изменения server/shared/root/tests и проверить его финальным `git diff --name-only`.
- [x] Запустить baseline `pnpm.cmd run check`; исторический progress не заменяет текущую проверку.

## P0.1 — local protocol adapter

- [x] Создать `src/web/features/voice-router/realtime/protocol.ts` с `PROTOCOL_VERSION`, Zod schemas server events и builder-функциями client events.
- [x] Envelope содержит `protocolVersion`, `type`, `eventId`, `sequence`, `occurredAt`, optional `sessionId`/`turnId` и строгий `payload`.
- [ ] Довести применение handshake limits: формат и лимиты описаны, но client не проверяет, что backend выбрал предложенный формат, и не применяет согласованный `maxQueuedBytes` к transport.
- [x] Не включать provider bodies, chain-of-thought, credentials, dataset или PII.
- [x] Не принимать неизвестный `type`, лишние поля, неверный protocol version и небезопасные размеры/частоты.

## P0.2 — WebSocket lifecycle

- [x] Создать transport с dependency-injected WebSocket factory и configurable URL; production default строится из текущего origin.
- [ ] Реализовать и автоматическими тестами проверить допустимые переходы `idle | connecting | handshaking | ready | recording | waiting | playing | closing | closed | error`; состояния объявлены, но переходы тестами не покрыты.
- [x] `connect()` ждёт `session.ready` с timeout; повторный concurrent connect возвращает тот же promise или отклоняется предсказуемо.
- [x] Настроить `binaryType = "arraybuffer"`; JSON и binary обрабатываются раздельно.
- [x] Проверять монотонный server sequence, `sessionId`, `turnId` и generation token; stale events не меняют текущий state.
- [ ] Завершить heartbeat: timeout и controlled close реализованы, но `pong.payload.pingEventId` не связывается с отправленным `ping`, отдельная проверка idle activity отсутствует.
- [x] Добавить bounded binary outbox с проверкой `bufferedAmount`, лимитом queued bytes и последовательным drain.
- [x] `destroy()` снимает listeners/timers, закрывает socket, capture и playback; повторный вызов безопасен.

## P0.3 — microphone → PCM16

- [x] Создать AudioWorklet processor внутри feature; никаких глобальных handlers.
- [x] `startCapture()` запрашивает `getUserMedia` только при явном вызове и не создаёт второй stream/node параллельно.
- [x] Перевести Float32 input sample rate браузера в согласованный mono PCM16 sample rate с сохранением остатка между callbacks.
- [x] Нарезать ровно по согласованному frame size; последний неполный frame либо корректно flush/pad по контракту, либо отбрасывается с явной метрикой.
- [ ] Гарантировать PCM16 little-endian независимо от платформы и покрыть golden-byte тестом; сейчас используется native-endian `Int16Array`.
- [x] `stopCapture()` отключает worklet/source, закрывает AudioContext и останавливает все MediaStream tracks.
- [ ] Устранить гонку `start()` ↔ `stop()`/`interrupt()` во время `getUserMedia`: поздно выданный stream сейчас может продолжить запуск после cleanup и оставить микрофон/AudioContext активными.

## P0.4 — backend audio → playback

- [x] Создать последовательную Web Audio playback queue для PCM16 frames с согласованным sample rate.
- [x] Планировать chunks без overlap и больших gaps; учитывать currentTime и следующий scheduled time.
- [ ] Привязать `playback.started` к подтверждённому движению `AudioContext`: сейчас это расчётный `setTimeout`, который может сработать при suspended context без слышимого звука.
- [x] Ограничить queued audio duration; overflow — явная ошибка/cancel, не бесконечный рост памяти.
- [x] `interrupt()`/`reset()` останавливает все sources, закрывает context и не проигрывает stale frames предыдущего turn.
- [ ] Добавить явный playback unlock/prime из пользовательского жеста будущего UI, чтобы autoplay policy не оставляла context suspended после асинхронного ответа.

## P0.5 — `RealtimeVoiceClient`

- [x] Собрать transport, capture и playback в один controller без Vue/UI dependency.
- [x] Публичный API: `connect`, `startTurn`, `stopTurn`, `interrupt`, `disconnect`, `destroy`, `subscribe`, `getSnapshot`.
- [x] `startTurn` выполняет `audio.start`, ждёт `audio.ready`, затем открывает отправку frames. До ack audio bytes не уходят в socket.
- [x] `stopTurn` прекращает capture, дренирует уже принятые frames в пределах timeout и отправляет `audio.stop`.
- [x] Входящий audio принимается только в ожидаемом response window и передаётся playback queue.
- [ ] Зафиксировать и проверить порядок `turn.completed`, `response.audio.start` и `response.audio.end`: сейчас ранняя очистка `activeTurnId` может отбросить либо поздний result, либо поздно начавшийся audio stream.
- [ ] Ошибки permission/socket/protocol/backpressure/playback преобразуются в безопасный typed client error, но полный cleanup не доказан до устранения гонки запуска capture и browser-теста.
- [ ] Валидировать `turn.completed.payload.result` по согласованной публичной схеме; сейчас snapshot принимает произвольный `Record<string, unknown>`.
- [x] Snapshot содержит UI-полезное состояние: connection/state, sessionId, activeTurnId, bytes sent/received, queue duration, last safe error и последний публичный turn result.

## P0.6 — проверка без backend и после pull

- [x] После pull синхронизировать зависимости и запустить текущий `pnpm.cmd run check`: typecheck и 36/36 существующих тестов прошли.
- [x] Отдельно запустить `pnpm.cmd run build` и `pnpm.cmd run smoke:built`: production build и starter smoke прошли после остановки общего `verify`.
- [x] Изолированно собрать public realtime entry через Vite с `write: false`: protocol/controller и AudioWorklet присутствуют в полученном chunk.
- [ ] Добавить realtime-specific автоматические тесты с fake WebSocket/MediaDevices/AudioContext: handshake, invalid sequence/session/turn, backpressure, capture framing, event ordering, interrupt, permission race, disconnect/reconnect и cleanup.
- [ ] Подключить public API хотя бы к отдельной browser entry/harness, чтобы Vite действительно собрал `client.ts` и `pcm-capture.worklet.js`; UI в эту задачу не входит.
- [x] Финальный diff содержит изменения только в `src/web/**` и этом TODO.
- [ ] Backend pull проверен: endpoint/events/audio format/auth для browser WebSocket в нём отсутствуют, поэтому согласовать и затем сверить `protocol.ts`; не сохранять несовместимость ради старого frontend-кода.
- [ ] Если dev proxy должен поддерживать WebSocket, передать владельцу root config точное требование `ws: true`; самостоятельно `vite.config.ts` не менять.
- [ ] Проверить реальный handshake, исходящие PCM frames, входящие audio frames, interrupt, backend error, disconnect и reconnect новой session.
- [ ] Проверить microphone/playback в поддерживаемом browser через localhost/HTTPS; build сам по себе не доказывает media path.
- [ ] После интеграции передать будущему UI только public controller API и snapshots; UI не должен обращаться к raw socket/audio nodes.

## P0.7 — обязательный backend/root contract для завершения P0

- [ ] Backend предоставляет один browser WebSocket endpoint (предложенный путь `/api/voice-router/ws`) и регистрирует production HTTP upgrade на том же `node:http` server.
- [ ] Владелец root config добавляет `ws: true` для dev proxy либо документирует отдельный явный WS URL; same-origin production и dev проверяются отдельно.
- [ ] Согласованы auth/session bootstrap, Origin validation, close codes, max payload, heartbeat semantics и безопасные ошибки без provider payload/секретов.
- [ ] Согласованы JSON event schema, sequence semantics, допустимый порядок result/audio events и способ связать каждый binary frame с session/turn/playback.
- [ ] Согласован фактический browser audio contract в обе стороны: codec/container, sample rate, channels, frame size и end-of-turn behavior. Нельзя считать ElevenLabs MP3/other container входящим raw PCM16.
- [ ] Backend связывает browser audio с реальными STT/VAD → DSR → `handleTurn` → ElevenLabs TTS, поддерживает cancel и не создаёт второй пользовательский turn из late STT.
- [ ] Есть интеграционный сценарий RU, KK и mixed speech, деградация одного STT без двойной маршрутизации, слышимый TTS, barge-in/cancel и reconnect новой session.

## Definition of Done текущей frontend-задачи

- [x] Вся реализация находится в `src/web/features/voice-router/realtime/`; server/shared/root/tests не изменены.
- [ ] WebSocket lifecycle не допускает binary audio до ack и stale events после reconnect/destroy — реализовано статически, но не покрыто realtime-тестами и не проверено с backend.
- [ ] Микрофон преобразуется в bounded PCM16 frames; входящие PCM16 frames последовательно воспроизводятся — реализация есть, browser/golden-byte проверок нет.
- [ ] Interrupt и cleanup освобождают socket timers, AudioContext, nodes и MediaStream tracks — основной путь есть, но capture start/stop race остаётся.
- [x] Controller не зависит от Vue/UI и готов к подключению будущим экраном.
- [ ] Offline `check`, отдельные build/smoke и isolated realtime build имеют фактически записанный результат; полный `verify`, включение realtime-кода в application bundle и live E2E должны быть подтверждены отдельно.

## Финальный отчёт агента

Сообщить:

1. Какие файлы внутри `src/web` изменены и какой public API готов для UI.
2. Как устроены handshake, binary framing, backpressure, capture, playback и cleanup.
3. Что проверено offline и какие команды реально прошли.
4. Что нельзя проверить без backend contract/pull, dev WS proxy, HTTPS и browser permissions.
5. Какие точные требования нужно передать владельцу backend/root config.
