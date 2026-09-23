# Web-приложение Voice Router

Vue 3 frontend для единого браузерного симулятора: слева клиент разговаривает с голосовым оператором, справа супервизор видит маршрутизацию и задержки того же хода.

## Фактическое состояние

`App.vue` отображает `VoiceRouterPage.vue`: голосовой звонок, резервный текстовый ввод и панель трассировки. Echo остаётся starter-проверкой, но не является текущим экраном.

В `features/voice-router/realtime/` уже подготовлены низкоуровневые браузерные модули:

- захват микрофона через `AudioWorklet`;
- преобразование в mono PCM16 и разбиение на кадры;
- WebSocket protocol/client с handshake, sequence и heartbeat;
- ограничение очередей и backpressure;
- очередь PCM-воспроизведения и отмена устаревшего звука.

Клиент подключён к серверному `/api/voice-router/ws` и общему контракту `src/shared/voice.ts`. Локальные тесты проверяют протокол, STT/DSR-оркестрацию и воспроизведение; живой микрофон, внешние провайдеры и слышимый ответ в браузере ещё не проверены. До этой проверки голосовое демо нельзя считать принятым.

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

## Текущий экран и следующие шаги

Feature в `features/voice-router/` уже включает:

- `VoiceRouterPage.vue` — композицию звонка, текстового ввода и trace-панели;
- HTTP turn/reset для резервного текстового пути;
- управление realtime-клиентом, микрофоном и воспроизведением;
- явные состояния подключения, записи, обработки и ошибки, гипотезы STT/DSR.

Полная история диалога, действия/подтверждения и end-to-end timings остаются дальнейшей работой.

Страница соединяет feature через props, events и composables. Локальное состояние не выносится в глобальный store без нескольких реальных потребителей.

## Контракты и границы

- Browser-safe HTTP DTO и Zod-схемы находятся в `src/shared/`.
- Frontend никогда не импортирует `src/server/` и не читает `process.env`.
- Ключи запрещены в `VITE_*`, bundle, trace и экспортируемом состоянии.
- Checked-in импорты используют явные относительные пути с расширением `.ts`.
- Общий `src/shared/voice.ts` валидирует server events до изменения UI-state.
- Один `turnId` должен финализироваться один раз; partial/refinement STT не создают повторные бизнес-ходы.
- При новом ходе, reset или stop старый capture/playback и устаревшие server events отменяются.
- Текстовый fallback вызывает тот же серверный turn pipeline, что и согласованный DSR-транскрипт.

## Аудиоконтракт

Текущий браузерный transport по умолчанию использует:

- `pcm_s16le`;
- mono;
- `16 000 Hz`;
- кадр `320` samples.

Фактический формат и лимиты подтверждаются server handshake. Бинарные кадры нельзя отправлять до `audio.ready`; JSON и server results валидируются перед использованием. Входящие TTS-чанки начинаются с 36 ASCII-байтов `playbackId`; лимит `maxFrameBytes` из handshake относится к исходящим микрофонным кадрам.

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

Автоматические тесты покрывают текстовый API, browser realtime-клиент, серверный WebSocket и часть DSR/TTS. Они не заменяют ручной live voice test RU/KK/mixed с разрешением микрофона и реальными провайдерами.

Общие требования: [`../../TASK.md`](../../TASK.md) · текущий статус: [`../../docs/STATUS.md`](../../docs/STATUS.md) · UI-фаза: [`../../docs/implementation/phases/04_TRACE_UI.md`](../../docs/implementation/phases/04_TRACE_UI.md)
