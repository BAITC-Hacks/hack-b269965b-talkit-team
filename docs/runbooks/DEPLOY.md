# Деплой

> Перенесено из исходного starter. Это инструкция/шаблон, а не доказательство текущей готовности Voice Router. Актуальные результаты — в `docs/STATUS.md` и `docs/progress/`.

## Сначала локальная репетиция

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm run verify
```

В репозитории уже есть настоящий lockfile. Обновляйте и коммитьте его только вместе с намеренным изменением зависимостей.
`pnpm run verify` включает read-only проверку форматирования. `pnpm run smoke:built` сам запускает собранный production-сервер на свободном порту, проверяет API, HTML и локальные JS/CSS assets, затем останавливает сервер.

## Docker

```sh
docker compose up --build -d
pnpm run smoke -- http://localhost:3000
docker compose logs --tail=50 app
```

Разделитель `--` поддерживается явно; его можно опустить (`pnpm run smoke http://localhost:3000`). Скрипт принимает не более одного абсолютного URL с протоколом HTTP или HTTPS.

Compose привязывает опубликованный порт к localhost. Для публичного демо настройте HTTPS reverse proxy / managed hosting,
не открывайте Docker socket и не публикуйте .env. Домен, TLS и доступ проверьте заранее; конкурсный код выкладывайте по правилам.

На Node-хостинге: build `pnpm install --frozen-lockfile && pnpm run check && pnpm run build`,
start `node dist/server/index.js`. Env: NODE_ENV=production, HOST=0.0.0.0, PORT выданный хостингом.
Health path `/api/health`. Один сервис, не отдельный backend и frontend hosting.

## Когда появятся данные и платные API

Ключи только через server env; не VITE\_\*. Нужны ограничение доступа и лимиты вызовов/расходов.
БД добавьте по конкретному сценарию. SQLite на эфемерном диске теряется при redeploy; нужен persistent volume.
PostgreSQL удобнее для нескольких экземпляров, но не должен стать обязательной зависимостью пустого starter.
В этом архиве персистентности нет — ничего не сохраняется между запросами.
