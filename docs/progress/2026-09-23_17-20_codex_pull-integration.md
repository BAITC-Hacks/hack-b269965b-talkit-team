# Pull и интеграция локальных изменений

Время записи: 2026-09-23 17:20, Asia/Qyzylorda (UTC+05:00). Исполнитель: Codex. Основание: запрос пользователя выполнить pull, разрешить конфликты, затем commit и push.

## Объединение

- Все девять подготовленных локальных файлов сохранены в stash `codex-before-pull-voice-router-integration`.
- `git pull --ff-only origin main` обновил `282b285` до `ebb7ebc`.
- При применении stash возникли четыре content-конфликта и один modify/delete-конфликт.
- В протоколе сохранён новый общий контракт `src/shared/voice.ts`: playback ID уже передаётся в JSON и бинарных кадрах. Старые локальные дубликаты схем не восстановлены.
- Новый клиент сохраняет persistent capture, STT/DSR diagnostics и playback acknowledgements. Перенесены локальные исправления immutable result/error и обработчик ошибки начала воспроизведения.
- В аудиоплеере сохранён upstream output-clock tracking; добавлены локальные ограничение ожидания и проверка разблокировки AudioContext.
- Сохранено исправление фазы PCM-ресемплинга на границах чанков.
- Проверка входящих кадров адаптирована к новому серверу: TTS chunks имеют UUID-prefix и отдельный receive limit; negotiated microphone frame limit не применяется к ним.
- Удалённый upstream файл `realtime.test.mjs` оставлен удалённым. Актуальные локальные регрессии перенесены в `tests/voice/realtime-client.test.ts`, который входит в стандартный test runner.
- `docs/STATUS.md` отражает новые voice/UI commits; прежний README-отчёт сохранён как исторический. Локальный TODO сохранён.
- Дополнительно в корневом README устранены уже закоммиченные upstream conflict-маркеры; сохранены и описание происхождения, и добавленная инструкция голосового звонка.

## Проверки

- `pnpm install --frozen-lockfile` — успешно, установлены зависимости нового upstream; lockfile не менялся.
- Первый `check` выявил отсутствие guard для `pendingStop` в полученном клиенте и неподдерживаемый текущим TS lib `Promise.withResolvers` в добавленном тесте. Оба исправлены.
- Следующий `check`: typecheck прошёл, 83 теста прошли; SSR завершился с нехваткой памяти Rolldown/Node.
- Отдельный SSR-повтор с `RAYON_NUM_THREADS=1` и `NODE_OPTIONS="--max-old-space-size=512 --max-semi-space-size=4"` прошёл. Это временные настройки процесса, файлы окружения и конфигурации проекта не менялись.
- Окончательный `pnpm run verify` с теми же временными настройками памяти — успешно: doctor, Prettier, TypeScript/Vue typecheck, 86/86 тестов, production build и built smoke (health, echo, API 404, Voice Router unavailable/reset, SPA и assets).
- Новые регрессии проверяют крупные TTS-кадры с playback ID, отказ для oversized ArrayBuffer/Blob, неизменяемость вложенного результата, фазу ресемплинга и timeout старта воспроизведения.
- Отправка выполняется после записи этого отчёта; её результат подтверждается Git remote и финальным сообщением, а не предположением в отчёте.

## Ограничения

Живые провайдеры, голос в браузере, внешний deployment и платный eval в этой Git-задаче не запускались. Сохранённый stash служит резервной копией исходных локальных изменений.
