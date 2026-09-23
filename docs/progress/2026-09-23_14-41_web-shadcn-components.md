# Компоненты shadcn-vue и проверка регрессий

Фактическое время: 2026-09-23 14:41:00, Asia/Qyzylorda (UTC+05:00). Область: `web`; личный автор в исходной записи не указан.

## Цель и результат

Добавить используемые echo-формой Button и Textarea на базе shadcn-vue, затем проверить и исправить связанные с ними UI-регрессии.

## Изменённые файлы

Коммит `5b6c3bd746f4187654f194a23e8f84cbc120922b` (`Add shadcn-vue Button and Textarea to the existing echo screen`) затронул:

- зависимости и конфигурацию: `package.json`, `pnpm-lock.yaml`, `components.json`, `vite.config.ts`, `tsconfig.json`, `tsconfig.web.json`;
- компоненты: `src/web/components/ui/BaseButton.vue`, `src/web/components/ui/button/Button.vue`, `src/web/components/ui/button/index.ts`, `src/web/components/ui/textarea/Textarea.vue`, `src/web/components/ui/textarea/index.ts`;
- интеграцию и стили: `src/web/features/echo/components/EchoPanel.vue`, `src/web/pages/EchoPage.vue`, `src/web/styles/index.css`, `src/web/lib/utils.ts`, `src/web/README.md`;
- тесты: `tests/web-app-ssr.test.ts`;
- документацию: `README.md`, `docs/PROGRESS.md`.

Использованы только Button и Textarea. CLI-добавление иконок удалено как неиспользуемая зависимость. Генерируемые импорты приведены к принятому в проекте формату `.ts`.

## Исправления регрессий

- Сохранена фиксированная высота пятистрочного Textarea.
- Добавлены проверки HTML-атрибутов Textarea и Button после SSR-рендера.
- Явно восстановлены жирность заголовков и курсор enabled-кнопки после подключения Tailwind preflight.

## Проверки

- `pnpm run check` — по исходной записи: typecheck и 32 теста прошли.
- `pnpm run verify` — по исходной записи прошёл после исправлений: doctor, форматирование, типы, тесты, сборка и built API/SPA smoke.
- Ручной просмотр браузера не выполнялся: в той среде browser surface был недоступен.

## Ограничения и следующий шаг на тот момент

Результаты фиксируют состояние соответствующих запусков и не заменяют проверку текущего checkout. Для визуальной проверки нужен доступный браузер.
