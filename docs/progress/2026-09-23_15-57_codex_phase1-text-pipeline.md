# Phase 1 — текстовый маршрут

- Время записи: 2026-09-23 15:57 +05:00.
- Цель: реализовать настоящий текстовый путь Phase 1 без подмены live-провайдера моками.
- База рабочего дерева во время работы была обновлена до `2702100`; финальные изменения на момент записи ещё не зафиксированы отдельным commit.

## Что реализовано

- Runtime-проверяемый каталог 40 сценариев, 3 системных намерений, слотов, действий и ссылок на фрагменты базы знаний.
- Серверный WebSocket-адаптер `gpt-realtime`: ожидание `session.created`, out-of-band `response.create`, function calling, проверка `response.done`, timeout/cancel и безопасные ошибки.
- `route_turn` с каноническим `RouteDecision`, проверкой ID/слотов и не более чем одной попыткой исправить невалидный вывод. Транспортные ошибки не превращаются в низкую уверенность и не ретраятся как output repair.
- Детерминированный `TurnPlan`: urgent-порядок берётся из каталога; границы `>= 0.75`, `>= 0.45 && < 0.75`, `< 0.45`; второй подряд низкоуверенный результат ведёт к handoff.
- Один `handleTurn` для текстового и будущего STT-входа, bounded in-memory сессии, сериализация turns, идемпотентный `turnId`, reset и сохранение валидированного решения при ошибке генерации ответа.
- `POST /api/voice-router/turn` и `POST /api/voice-router/reset`.
- Vue-экран с реальным текстовым полем, ответом, сценариями, альтернативами, планом и длительностями trace.
- Live eval-runner `pnpm run eval:router`; evaluation-разметка читается только runner-ом и не передаётся в prompt.
- Production smoke проверяет endpoint в честном состоянии `unavailable` без ключа и не расходует provider quota.
- Runtime-образ включает весь каталог `data/`, в том числе app-owned knowledge bindings.

## Затронутые области

- `data/voice-router-app/knowledge-bindings.json`
- `src/shared/voice-router.ts`
- `src/server/features/voice-router/`
- `src/server/app.ts`, `src/server/server.ts`
- `src/web/features/voice-router/`, `src/web/pages/VoiceRouterPage.vue`, `src/web/App.vue`
- `scripts/eval-router.mjs`, `scripts/smoke-lib.mjs`, `scripts/smoke-built.mjs`
- `tests/api.test.ts`, `tests/voice-router-phase1.test.ts`, `tests/web-app-ssr.test.ts`
- `Dockerfile`, `package.json`, `pnpm-lock.yaml`, `README.md`

## Фактические проверки до полного verify

- `pnpm typecheck` — успешно.
- `pnpm test` — успешно, 49 тестов.
- `pnpm run build` — успешно, server и Vue production bundle собраны.
- `pnpm run smoke:built` — успешно: health, echo, JSON 404, voice-router unavailable path, reset, SPA и assets.
- Поиск запрещённого имени по tracked/untracked файлам — совпадений нет.

## Проверки после появления параллельных voice-файлов

- `pnpm run verify` запускался повторно: `doctor` прошёл, затем общий `format:check` остановился на параллельно появившихся voice/UI-файлах вне Phase 1 diff. Эти файлы не переформатировались без согласования.
- Отдельный `pnpm run check` на текущем совместном дереве прошёл: typecheck и 56 тестов.
- Повторные `pnpm run build` и `pnpm run smoke:built` прошли.
- `docker build -t hack-b269965b-talkit-team:phase1-local .` прошёл; внутри image снова прошли typecheck, 56 тестов и build.
- Временный runtime-контейнер без ключа прошёл health/echo/404 smoke, `POST /api/voice-router/turn` со статусом `unavailable` и `POST /api/voice-router/reset`; после проверки контейнер остановлен и удалён через `--rm`.
- `node --check` для eval/smoke runners, `git diff --check` и повторный поиск запрещённого имени прошли без замечаний.

## Не проверено

- На момент первоначальной записи ключ и `.env` отсутствовали. После команды «Продолжай» `.env` и непустой `OPENAI_API_KEY` обнаружены без чтения/вывода значения, но live WebSocket-соединение и eval не запускались без явного разрешения расходовать API quota; метрики не получены.
- Интерактивный браузерный прогон не выполнялся; UI проверен SSR-тестом и production build.
- После фиксации Phase 1 началась внешняя незавершённая voice/UI-реорганизация. На последнем снимке общий `pnpm run check` останавливается в `src/server/features/voice/yandex-grpc.ts` из-за ещё не добавленных `@grpc/grpc-js`/`@grpc/proto-loader` и связанных типов; это не исправлялось в рамках Phase 1.
- STT, TTS, VAD, browser calling и действия относятся к следующим фазам и не реализованы.
- Разрешение организатора на pre-existing starter остаётся в состоянии, указанном в compliance-документах.

## Следующий шаг

После предоставления ключа и явного разрешения на расход quota запустить `pnpm run eval:router`, затем исходный `evaluate.py`, сохранить модель, prompt hash, ошибки и метрики. До этого Phase 1 реализована локально, но live-приёмка не завершена.

## Полный verify

Не завершён: общий format-check блокируют параллельно созданные voice/UI-файлы, а их последующая незавершённая gRPC-правка ломает текущий общий typecheck. Для зафиксированного Phase 1 состояния тесты, build, built smoke и Docker runtime smoke прошли отдельно; это не выдаётся за успешный полный `verify` текущего рабочего дерева.
