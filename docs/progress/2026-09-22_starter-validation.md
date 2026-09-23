# Статус проверки

## Текущий lockfile

Зависимости были установлены из npm registry, поэтому `pnpm-lock.yaml` является фактически сгенерированным lockfile, а не ручной заглушкой. Обычная установка должна быть воспроизводимой:

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run verify
```

`verify` запускает doctor, read-only проверку Prettier, полный typecheck, тесты, сборку и smoke собранного production-сервера. Smoke проверяет API, HTML и загрузку указанных в HTML локальных JavaScript/CSS assets с ожидаемыми content types.

Если зависимости намеренно изменены, сначала обновите lockfile обычным `pnpm install`, проверьте diff `package.json` и `pnpm-lock.yaml`, затем повторите frozen-установку. Не обновляйте всё до latest автоматически.

## Результаты первичного аудита до исправлений

Эти результаты описывают состояние до текущего набора исправлений и не заменяют итоговый повторный запуск:

- `pnpm run check`: успешно, 12/12 тестов.
- `CI=true pnpm run verify`: успешно.
- Docker build и runtime smoke production-контейнера: успешно.
- `pnpm audit --prod`: известных уязвимостей не найдено.
- Полный `pnpm audit`: одна critical и одна high advisory в dev-цепочке `concurrently@9.2.1 > shell-quote@1.8.3`.
- `pnpm run format:check`: неуспешно, Prettier указал 26 файлов.

После аудита `concurrently` был обновлён в пределах той же major-версии до 9.2.4; lockfile разрешает исправленный `shell-quote@1.9.0`. Проверка `pnpm audit` после обновления lockfile не обнаружила advisories. Форматирование теперь входит в `verify` и тем самым в GitHub CI.

## Итоговая проверка после исправлений — 2026-09-22

- Node.js 24.21.0 и pnpm 10.28.0 соответствуют зафиксированным версиям.
- `pnpm install --frozen-lockfile`: успешно, lockfile не потребовал изменений.
- `pnpm run check`: успешно, 32/32 теста; сюда входят HTTP-интеграция, JSON-граница, контракты, API-клиент и Vite SSR-render реального `App.vue`.
- `CI=true pnpm run verify`: успешно; doctor, Prettier, все typecheck, тесты, production build и smoke HTML/JS/CSS assets прошли.
- Полный `pnpm audit` и `pnpm audit --prod`: известных advisories не найдено.
- Чистая Docker-сборка: успешно; тесты и build прошли внутри Linux-образа, pruned runtime-контейнер запустился, а документированная команда `pnpm run smoke -- URL` прошла.
- Временные Docker container/image после проверки удалены.
- Интерактивный браузерный click-through не выполнен: в среде проверки не был доступен browser surface. Компиляция/render Vue, production assets и API проверены автоматически; визуальный сценарий остаётся ручной проверкой в целевой среде.

## Ручные проверки перед использованием

- Получено ли разрешение организатора на импорт этого заранее созданного starter.
- Есть ли доступ к выданному репозиторию, deployment и необходимым API-кредитам.
- Проходит ли чистая установка с `pnpm install --frozen-lockfile`.
- Работают ли Docker-образ и браузерный сценарий в целевой среде.
- Соответствует ли актуальный `docs/PRESTART_MANIFEST.json` разрешённому pre-existing baseline; snapshot не является доверенной меткой времени.

Этот файл не является подтверждением соответствия регламенту организатора.
