# Voice Router — TODO для GPT-6 Sol (`medium`)

## Цель

За 120 минут продвинуть текущий репозиторий от завершённой Phase 0 к честному сквозному текстовому пути Voice Router и, только после его проверки, к минимальному голосовому пути. Это техническое окно внутри пятичасового конкурса, а не заявление, что весь конкурсный вклад занял два часа.

Каноническое задание — корневой `TASK.md`; текущий статус — `docs/STATUS.md`; детальные шаги — `docs/implementation/phases/01_TEXT_PIPELINE.md` и `02_DSR_VOICE.md`. Этот файл — исполняемый короткий чек-лист, а не второй источник требований и не отчёт о готовности.

## Порядок источников

1. Актуальные `AGENTS.md`, `TASK.md`, `docs/STATUS.md` и относящиеся к работе phase-файлы в target.
2. Фактический код, Git-история, lockfile, результаты текущих команд и ответы организатора/провайдеров.
3. `C:\Users\user\Desktop\hackalem-starter\docs\BRIEF.md`, `PREEXISTING.md` и `PROGRESS.md` — только шаблоны и сведения о происхождении baseline. Они не доказывают состояние target.

При конфликте не выбирать удобную трактовку молча: записать источники и вопрос в `docs/DECISIONS.md`. Корневой `TASK.md` имеет приоритет над старым двухчасовым планом в этом файле.

## Фактическая стартовая точка после pull

- Текущий проверенный при пересмотре commit — `6d8d088` (`Add voice-router dataset, schemas, docs, tests`). Перед исполнением снова проверить `HEAD` и `git status --short`.
- Phase 0 уже добавила `src/shared/voice-router.ts`, server-only catalog loader, provider config, исходный `data/voice-router/` и `tests/voice-router-baseline.test.ts`.
- Датасет уже отслеживается Git в commit `6d8d088`; не копировать его повторно из соседнего каталога и не менять выданные JSON/формулы.
- В target уже есть `docs/compliance/PREEXISTING.md`, датированные записи в `docs/progress/`, `docs/STATUS.md` и `docs/reference/BRIEF.template.md`. Не создавать параллельные `docs/PREEXISTING.md` или `docs/PROGRESS.md`.
- Отчёт Phase 0 сообщает об успешных 36 тестах и `CI=true pnpm run verify`, но это историческая запись конкретного запуска. Перед новой контрольной точкой проверки запускаются заново.
- Продуктового `handleTurn`, реального LLM-вызова, `/api/voice-router/turn`, Voice Router UI, DSR, TTS и deployment пока нет.
- Разрешение организатора на pre-existing starter/TalkIt и право включения комплекта данных всё ещё не подтверждены. Внутренний proprietary TalkIt-код не импортировать без письменного разрешения.

## Зафиксированные решения

- Первый новый продуктовый результат после Phase 0 — текстовый путь `Vue → POST /api/voice-router/turn → handleTurn → gpt-realtime → validation/grounding → Vue`.
- Общие DTO из `src/shared/voice-router.ts` расширять совместимо и только по реальной потребности. Не создавать второй набор схем или новый WebSocket contract до текстового E2E.
- Для текста использовать HTTP endpoint из канонической Phase 1. Один WebSocket допустим в Phase 2 только для реального audio transport, если совместимого транспорта ещё нет.
- Runtime LLM — фактически доступный `gpt-realtime` согласно `TASK.md`. Маршрутизацию получать через завершённый function call `route_turn`; не предполагать поддержку Structured Outputs.
- Голосовой целевой путь — OpenAI STT/VAD + Yandex SpeechKit с одной DSR-финализацией, затем тот же `handleTurn`, затем server-side ElevenLabs V3. Browser `speechSynthesis` и `SpeechRecognition` не выдавать за этот путь.
- `gpt-6-sol` — coding-агент, не runtime-модель приложения.
- Никаких реальных SMS/email/платежей и других внешних действий. Необратимые mock-действия сначала только `preview`, затем `execute` после явного подтверждения.
- Не запускать 104 платных eval-запроса, bulk-сетевые проверки или расходы без отдельного подтверждения пользователя.

## Что использовать из starter docs

### `BRIEF.md`

- Использовать поля шаблона как проверку полноты: точная формулировка трека, пользователь, одна проблема, «ввод → обработка → результат», роль AI, измеримый критерий и честный тест, данные и права, результат первого часа, сознательные исключения и неизвестные.
- Не создавать обязательный новый brief только ради чек-листа: в target `docs/reference/BRIEF.template.md` помечен справочным, а требования уже раскрыты в `TASK.md`. Заполнять копию лишь если она нужна команде или форме сдачи.
- Красивый UI и заранее успешные ответы не заменяют реальную проверку маршрутизации.

### `PREEXISTING.md`

- Вести актуальное раскрытие только в `docs/compliance/PREEXISTING.md`.
- Записать реальный ответ организатора о starter и, отдельно, TalkIt: дата, канал и точный текст. Пока ответа нет, статус остаётся `НЕ ПОДТВЕРЖДЕНО`.
- Сохранить разделение: starter, его аудит Codex от 2026-09-22 и существующие TalkIt-возможности не входят в заявленный пятичасовой вклад.
- Зафиксировать фактический import commit `f79943f732955d4b735ffc40cedbe4f74eced0de`; не выдавать его за доказательство времени создания исходников. Hash архива указывать только если архив реально найден и посчитан.
- Через `package.json`/`pnpm-lock.yaml` проверить версии и лицензии; для датасета и runtime-моделей отдельно записать источник и основание использования. Обезличенность данных не заменяет право использования.
- Если TalkIt подключается, перечислить только реально используемые API/SDK, перенесённые файлы и функции, существовавшие до старта. Не приписывать конкурсному времени инфраструктуру TalkIt.

### `PROGRESS.md`

- Не копировать единый внешний файл в target. Использовать принятую структуру: датированная запись `docs/progress/YYYY-MM-DD_HH-mm_<owner>_<topic>.md` плюс краткое обновление `docs/STATUS.md`.
- В каждой записи указывать фактическое время/час, участника, что заработало, изменённые файлы, команды и реальные результаты, commit/push или отсутствие подтверждения, ограничения и следующий шаг.
- Не переносить исторические `32/32`, `36/36`, audit, Docker или `verify` как результат нового запуска. Не заполнять будущие часы и не подделывать SHA/timestamps.
- Target содержит `.git`; фраза внешнего шаблона об отсутствии Git здесь неприменима. Локальный progress-файл и commit сами по себе не заменяют официальный механизм почасового подтверждения и подачи.

## Бюджет 120 минут

| Окно        | Результат                                                                             |
| ----------- | ------------------------------------------------------------------------------------- |
| 0–10 мин    | Повторный preflight, права/credentials и актуальное состояние проверены               |
| 10–55 мин   | Работает text → real gpt-realtime → validated route → grounded answer → HTTP response |
| 55–75 мин   | Минимальный Vue text UI показывает настоящий ответ, решение, альтернативы и trace     |
| 75–100 мин  | Только при зелёном text E2E начат или подключён реальный DSR/audio/TTS path           |
| 100–120 мин | Targeted tests, `check`, `verify`, progress и status с фактическими результатами      |

Если live credentials/разрешения недоступны, не заменять real E2E фейковым успехом. Использовать явно помеченные fake adapters только в тестах, вернуть контролируемый `PROVIDER_UNAVAILABLE` и потратить остаток на проверяемые offline-части.

# P0 — исполняемый чек-лист

## P0.0 — повторный preflight

- [ ] Выполнить `git status --short`, `git log -1 --oneline` и проверить remote. При пересечении с чужими незавершёнными изменениями остановиться и согласовать файлы.
- [ ] Прочитать актуальные `AGENTS.md`, `docs/STATUS.md`, Phase 1, нужные части `TASK.md`, `docs/compliance/PREEXISTING.md`, provider notes и реальные схемы датасета.
- [ ] Запустить baseline `pnpm.cmd run check` на Windows. Не считать запись из progress заменой текущему запуску.
- [ ] Зафиксировать доступность `OPENAI_API_KEY` и реальную совместимость выбранного Realtime API/model без печати секрета. Отсутствие ключа блокирует live LLM, но не unit/integration tests.
- [ ] Зафиксировать доступность Yandex/ElevenLabs credentials и разрешённого TalkIt/DSR adapter. Их отсутствие не должно задерживать текстовый Phase 1.
- [ ] Проверить, что `docs/compliance/PREEXISTING.md` по-прежнему честно отражает разрешения, источник данных и текущий tracked/untracked status.

## P0.1 — контракт решения и catalog policy

- [ ] Переиспользовать `TurnInput`, `RouteDecision`, `TurnResult`, `TraceEvent` из `src/shared/voice-router.ts`; не переписывать готовую Phase 0.
- [ ] При необходимости добавить строгую схему запроса/ответа HTTP, безопасную для frontend. Никаких env, provider payloads, knowledge base или полного mock backend в `src/shared`.
- [ ] Дополнить post-validation: неизвестные scenario/action/slot IDs, дубликаты и пересечение selected/alternatives отклоняются.
- [ ] Сохранять несколько намерений: `urgent` первым, остальные по порядку упоминания. Не стирать одну часть составного запроса другой.
- [ ] Политика неуверенности следует каноническому `TASK.md`/kit. Не вводить новые пороги из старого todo без проверки источника и решения в `docs/DECISIONS.md`.
- [ ] Ответ и trace содержат продуктовый reason, а не chain-of-thought; неизмеренные latency остаются отсутствующими/`null`, а не `0`.

## P0.2 — gpt-realtime adapter и `handleTurn`

- [ ] Перед кодом проверить фактический endpoint, transport, model ID, auth, отмену и function-calling у доступного Realtime API. Не угадывать совместимость.
- [ ] Реализовать один узкий server-only adapter. Provider bodies, ключи, transcript и PII не логировать; допустимы request ID, stage, безопасный error type и duration.
- [ ] Сформировать компактный router context из 40 сценариев: ID, description, `not_this_if`, priority и небольшой набор RU/KK examples. Не передавать expected-разметку или весь `mock_backend`.
- [ ] Зарегистрировать `route_turn`, дождаться завершённых function arguments, разобрать JSON и проверить Zod + catalog policy. Разрешить не более одной попытки исправления невалидного результата.
- [ ] Реализовать один `handleTurn` для текста и будущего DSR-транскрипта. Transport не содержит бизнес-логику.
- [ ] Ограничить in-memory session максимум десятью turns, TTL и общим числом sessions; interrupt/disconnect/reset отменяет работу и не допускает позднего изменения state.
- [ ] Grounding использует выбранную карточку и подходящий knowledge-base fragment. Mock client record передаётся только после детерминированного поиска по явно названному идентификатору.
- [ ] Короткий ответ формируется на языке клиента только по разрешённому контексту. Ошибка provider transport не превращается в низкую confidence или fake success.
- [ ] При отсутствии/ошибке конфигурации вернуть контролируемый `PROVIDER_UNAVAILABLE`/503 и безопасный request ID.
- [ ] Fake adapter допускается через простой параметр handler/factory только для тестов; не вводить DI-container или registry.

## P0.3 — HTTP endpoint и text E2E

- [ ] Добавить `POST /api/voice-router/turn` в существующий H3 1.x app; валидировать body до dispatch и возвращать единый безопасный envelope ошибок.
- [ ] Создание/сброс session не принимает клиентский ID как доказательство существующей серверной сессии. `sessionId` не является идентификацией клиента.
- [ ] Добавить minimal Vue UI: connection/provider state, textarea, Send, Interrupt/Reset, ответ, scenarios, alternatives, reason и измеренную latency.
- [ ] Новая RU-фраза и одна KK/mixed-фраза, не зашитые в код, проходят `Vue → HTTP → handleTurn → real gpt-realtime → validation/grounding → Vue`.
- [ ] Abort/interrupt/reset не позволяют позднему результату изменить UI или session state.
- [ ] При отсутствии credentials UI показывает честную ошибку и не переключается автоматически на fake success.

Gate: до рабочего text E2E и зелёных targeted tests не начинать microphone/DSR/TTS.

## P0.4 — голос через тот же `handleTurn`, только после gate

- [ ] Следовать `docs/implementation/phases/02_DSR_VOICE.md`; не заменять её старым MediaRecorder-only планом.
- [ ] Запрашивать микрофон только после явного клика; один MediaStream/recorder/transport, корректный cleanup tracks/listeners/timers.
- [ ] Переиспользовать разрешённый текущий audio transport. Если его нет, добавить один WebSocket на существующий `node:http`, проверить Vite proxy, production upgrade, origin/payload limits и shutdown.
- [ ] Не путать WebM/WAV/PCM и sample rate. Реальный формат и ресемплинг должны соответствовать OpenAI и Yandex adapters.
- [ ] Одно аудио подаётся в OpenAI STT/VAD и Yandex; DSR выдаёт один финальный transcript с обеими гипотезами, причиной выбора, degraded status и неоднозначными полями.
- [ ] Опоздавший STT result не запускает второй `handleTurn` и не переписывает уже подтверждённое действие.
- [ ] Финальный transcript проходит тот же `handleTurn` и ту же session history, что текст.
- [ ] `assistantText` передаётся server-side ElevenLabs V3; реальные audio bytes воспроизводятся в browser. Фактический playback start попадает в trace.
- [ ] Interrupt/new session отменяет generation/TTS, прекращает playback и игнорирует старые chunks. Не считать неслышимую часть ответа произнесённой.
- [ ] Проверить RU, KK/mixed и деградацию одного STT provider. Не заявлять live voice success без микрофона и слышимого TTS.

## P0.5 — тесты, проверка и доказательства

- [ ] Schemas/policy: пустой input, неизвестные IDs/slots/actions, duplicate/overlap, несколько scenarios, RU, KK/mixed, clarification и continuation.
- [ ] Adapter: transport error, timeout/abort, invalid JSON/function arguments и одна repair-attempt через fake provider.
- [ ] HTTP/session: invalid body, provider unavailable, parallel turn, interrupt/reset, TTL cleanup и безопасные errors.
- [ ] Grounding: неизвестный identifier не создаёт запись; реальный mock lookup не выдаёт весь backend.
- [ ] При реализованном voice: format/order/limits, один final turn, provider degradation, late STT, interrupt, TTS cancel и destroy через browser/provider fakes.
- [ ] Убедиться, что health/404/static/SSR/smoke не сломаны и data доступны из собранного server module.
- [ ] Запустить `pnpm.cmd run format`, затем `pnpm.cmd run check`, затем `pnpm.cmd run verify`; записать фактические результаты, включая любой fail/retry.
- [ ] При credentials вручную проверить новые RU и KK/mixed text turns; voice, deployment и Docker отмечать проверенными только после реального запуска.
- [ ] Добавить датированную запись в `docs/progress/` и обновить `docs/STATUS.md`: файлы, команды, результаты, не проверенное, blocker и следующий шаг. Не редактировать старые отчёты задним числом.
- [ ] Сохранить commit/SHA и подтвердить push/официальную почасовую фиксацию отдельно; локальный commit не равен сдаче.

## Definition of Done этого окна

- [ ] Реальный text turn проходит через server-side gpt-realtime и возвращает validated routing, grounded reply и trace.
- [ ] Frontend и server используют общие схемы из `src/shared`, а dataset/keys остаются server-only.
- [ ] RU, KK/mixed, multi-intent и clarification покрыты offline tests; live-проверки перечислены отдельно.
- [ ] Interrupt/reset/cleanup не допускают позднего изменения state.
- [ ] `pnpm run check` и `pnpm run verify` имеют честно записанный текущий результат.
- [ ] Голос отмечен готовым только если реальный DSR → тот же `handleTurn` → слышимый ElevenLabs path фактически проверен.
- [ ] Pre-existing, права на данные, новый конкурсный вклад и внешние блокеры раскрыты без переноса исторических результатов как новых.

# После зелёного окна

- Eval по 104 репликам запускать только с отдельным разрешением на платные вызовы; каждый item получает чистую session, `expected` и `type` не попадают в prompt.
- Реализовать Phase 3 actions/confirmation, Phase 4 trace UI, Phase 5 evaluation и Phase 6 deployment/submission по каноническим файлам.
- Session resume добавлять только с явным replay/idempotency protocol; reconnect новой session не маскировать как resume.
- Не откладывать проверку HTTPS/microphone/deployment на последний конкурсный час.

## Финальный отчёт агента

Коротко сообщить:

1. Что реально работает E2E и какие HTTP/audio/STT/LLM/TTS paths выбраны.
2. Какие target-файлы изменены.
3. Какие source-файлы были `copied`, `adapted` или `reference only`.
4. Реальные результаты `check`, `verify`, live и ручных smoke-проверок.
5. Что не проверено и какие credentials, права или внешние условия блокируют следующий шаг.
6. Какое разрешение получено на starter/TalkIt, какой baseline зафиксирован и что является новым конкурсным вкладом.
