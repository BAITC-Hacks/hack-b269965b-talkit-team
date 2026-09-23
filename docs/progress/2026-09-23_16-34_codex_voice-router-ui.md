# Упрощение экрана Voice Router

Фактическое время: 2026-09-23 16:34, Asia/Qyzylorda (UTC+05:00). Область: web UI.

## Изменения

- Удалены рамка демо-блока, описание уровня, процент и слайдер. Визуализатор расположен по центру карточки диалога; его демонстрационное значение временно зафиксировано как `1`. Доступное имя сообщает, что микрофон не подключён.
- Содержимое шапки страницы Voice Router выровнено с основным контентом через те же `max-w-7xl`, `px-4` и `md:px-8`. Общий `AppHeader` не изменён, так как он также используется на странице Echo.
- Обновлена существующая SSR-проверка под новое доступное имя визуализатора.

## Проверки

- `pnpm exec prettier --check` для трёх затронутых Vue/тестовых файлов — прошёл.
- `git diff --check` — прошёл.
- `pnpm run check` — типы прошли; 76 из 77 тестов прошли, включая SSR-проверку экрана. Упал `closing an established socket resets its router session` в `tests/voice/transport.test.ts` (`4 !== 5`). Отдельный повтор этого тестового файла воспроизвёл ту же ошибку.
- `pnpm run verify` — `doctor` прошёл; общий `format:check` остановился на `src/web/components/ui/VoiceVisualizer.vue` и `tests/voice/transport.test.ts`. Сборка и smoke в этом запуске не выполнялись.
- Отдельно после этого `pnpm run build` и `pnpm run smoke:built` прошли: собраны server и web; smoke проверил health, echo, API 404, Voice Router unavailable path, reset, собранную SPA и assets.

Интерактивная визуальная проверка не выполнялась.
