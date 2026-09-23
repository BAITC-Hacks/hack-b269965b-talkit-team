# Пересмотр исполняемого TODO после Phase 0

Время записи: 2026-09-23 15:05, Asia/Qyzylorda (10:05 UTC). Работа выполнена в текущем checkout на основе `6d8d088`; нового commit или push эта запись не подтверждает.

## Цель и изменения

- После выполненного пользователем `git pull` файл `roman_sol_medium_todo.md` пересверен с актуальными `AGENTS.md`, корневым `TASK.md`, `docs/STATUS.md`, Phase 1/2 и фактическим кодом Phase 0.
- Удалён устаревший план начинать с отдельного WebSocket contract, одного OpenAI adapter и browser TTS. Текущий чек-лист следует канонической последовательности: HTTP text path через `gpt-realtime`, затем DSR OpenAI/Yandex и ElevenLabs V3.
- Добавлены применимые сведения из внешних starter-шаблонов `BRIEF.md`, `PREEXISTING.md` и `PROGRESS.md`: раскрытие baseline, разрешения и права, границы исторических проверок и формат фактического прогресса.
- Учтено, что DTO, catalog loader, provider config, dataset, тесты и документационная структура уже добавлены в `6d8d088`; повторное создание Phase 0 исключено.
- Продуктовый код и данные не менялись.

## Локальная подготовка и проверки

- `pnpm.cmd install --frozen-lockfile` — успешно; lockfile не изменён, установлено 126 пакетов в игнорируемый `node_modules`.
- Локальный Prettier для `roman_sol_medium_todo.md` — успешно.
- `pnpm.cmd run check` — успешно: typecheck и 36/36 тестов.
- Первый `pnpm.cmd run verify` — неуспешно: `doctor` остановился из-за отсутствующего локального `.env`; следующие стадии не запускались.
- `node scripts/setup.mjs` — создал игнорируемый `.env` как неизменённую копию `.env.example`; секреты не добавлялись.
- Повторный `pnpm.cmd run verify` — успешно: doctor, format check, typecheck, 36/36 тестов, production build и built smoke.
- `git diff --check` — успешно.

## Ограничения и следующий шаг

- Live OpenAI/Yandex/ElevenLabs, микрофон, browser audio, Docker и deployment в этой задаче не проверялись.
- Разрешение организатора на pre-existing starter/TalkIt и право включения комплекта данных остаются неподтверждёнными.
- Следующий продуктовый шаг не изменился: Phase 1, реальный текстовый путь `Vue → POST /api/voice-router/turn → handleTurn → gpt-realtime → validation/grounding → Vue`.
