# Web-приложение Voice Router

Vue 3 frontend для единого браузерного симулятора: слева клиент разговаривает с голосовым оператором, справа супервизор видит маршрутизацию и задержки того же хода.

## Фактическое состояние

Текущая точка входа `App.vue` отображает `EchoPage.vue`. Это starter-проверка цепочки Vue → H3, а не конкурсный Voice Router UI.

В `features/voice-router/realtime/` уже подготовлены низкоуровневые браузерные модули:

- захват микрофона через `AudioWorklet`;
- преобразование в mono PCM16 и разбиение на кадры;
- WebSocket protocol/client с handshake, sequence и heartbeat;
- ограничение очередей и backpressure;
- очередь PCM-воспроизведения и отмена устаревшего звука.

Они пока не образуют рабочую голосовую функцию:

- `App.vue` их не использует;
- backend не предоставляет `/api/voice-router/ws`;
- STT/DSR и ElevenLabs TTS не подключены;
- Voice Router page, текстовый fallback и trace panel отсутствуют;
- живой микрофон и воспроизведение в браузере не проверены.

Не описывайте этот transport как готовое голосовое демо до сквозной проверки.

## Структура

```text
src/web/
  main.ts                    запуск Vue и глобальные стили
  App.vue                    выбор текущей страницы
  pages/                     композиция экранов
  features/
    echo/                    инфраструктурный starter feature
    voice-router/
      realtime/              PCM capture/playback, protocol, socket и client
  components/
    layout/                  общий layout
    ui/                      небольшие UI-примитивы
  lib/
    http.ts                  HTTP transport, timeout, schema validation, API errors
    health.ts                клиент health endpoint
  styles/                    tokens, base styles и Tailwind mapping
```

`components/ui/button/` и `components/ui/textarea/` содержат установленные shadcn-vue primitives. `BaseButton.vue` сохраняет индикатор занятости starter-экрана. Корневой `components.json` настраивает shadcn-vue CLI для `src/web`.

## Следующий продуктовый экран

Целевой feature размещается в `features/voice-router/` и должен включать:

- `VoiceRouterPage.vue` — композицию клиентской и supervisor-панелей;
- composable уровня сессии — один источник состояния для text и voice;
- клиент HTTP turn/reset для резервного текстового пути;
- управление realtime-клиентом, микрофоном и воспроизведением;
- transcript/history с понятными состояниями `idle`, `listening`, `processing`, `speaking`, `error`;
- trace panel: язык, сценарии, confidence, причина, альтернативы, слоты, действия и реальные timings;
- явные состояния деградации STT/TTS/provider, а не изображение успешного ответа.

Страница соединяет feature через props, events и composables. Локальное состояние не выносится в глобальный store без нескольких реальных потребителей.

## Контракты и границы

- Browser-safe HTTP DTO и Zod-схемы находятся в `src/shared/`.
- Frontend никогда не импортирует `src/server/` и не читает `process.env`.
- Ключи запрещены в `VITE_*`, bundle, trace и экспортируемом состоянии.
- Checked-in импорты используют явные относительные пути с расширением `.ts`.
- Локальный realtime protocol валидирует каждое server event до изменения UI-state.
- Один `turnId` должен финализироваться один раз; partial/refinement STT не создают повторные бизнес-ходы.
- При новом ходе, reset или stop старый capture/playback и устаревшие server events отменяются.
- Текстовый fallback вызывает тот же серверный turn pipeline, что и согласованный DSR-транскрипт.

## Аудиоконтракт

Текущий браузерный transport по умолчанию использует:

- `pcm_s16le`;
- mono;
- `16 000 Hz`;
- кадр `320` samples.

Фактический формат и лимиты подтверждаются server handshake. Бинарные кадры нельзя отправлять до `audio.ready`; JSON и server results валидируются перед использованием. Эти правила описывают клиентский transport, но серверная сторона протокола ещё не реализована.

## UI-требования кейса

После каждого завершённого пользовательского хода интерфейс должен показывать:

- выбранный DSR-транскрипт и обе STT-гипотезы;
- определённый язык и язык ответа;
- основной сценарий или несколько сценариев;
- краткую проверяемую причину без скрытой chain-of-thought;
- альтернативы и confidence;
- безопасно отображённые слоты и mock-действия;
- неуверенность, ожидаемое подтверждение и handoff;
- измеренные STT/DSR, routing, action, response, TTS и playback timings.

Не показывайте константу `500 ms` как измерение. End-to-end latency считается от конца речи пользователя до фактического начала воспроизведения ответа.

## Разработка и проверка

Из корня репозитория:

```sh
pnpm dev
pnpm run check
pnpm run build
```

Vite открывается на `http://127.0.0.1:5173` и проксирует `/api` на H3 `http://127.0.0.1:3000`.

Текущие автоматические web-тесты покрывают starter API client и SSR-регрессии Echo. Они не подтверждают realtime-модули, разрешение микрофона, WebSocket backend, DSR или воспроизведение. Для завершения Voice Router нужны unit-тесты состояния/protocol, интеграционная проверка text flow и отдельный ручной live voice test RU/KK/mixed.

Общие требования: [`../../TASK.md`](../../TASK.md) · текущий статус: [`../../docs/STATUS.md`](../../docs/STATUS.md) · UI-фаза: [`../../docs/implementation/phases/04_TRACE_UI.md`](../../docs/implementation/phases/04_TRACE_UI.md)
