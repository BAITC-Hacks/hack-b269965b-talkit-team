# Основания и проверенные ограничения

План составлен 23 сентября 2026 года. Это спецификация предлагаемых работ, не отчёт об их исполнении.

## Материалы пользователя

- ТЗ Voice Router: голос в вебе и текстовый резерв, LLM-выбор 40 сценариев, русский/казахский/смешанная речь, трассировка, подтверждение необратимых действий, запуск одной командой. Ориентиры 500 мс для выбора маршрута и 1,5 секунды до голоса — цели измерения, не обещанные показатели.
- a.zip / voice_router_dataset.zip: README, каталог, слоты, action contracts, synthetic backend/knowledge base, dev-реплики, примерные диалоги, evaluator. Runtime-функций бэкенда комплект не содержит.
- hackalem-starter.zip: single-package Node.js/H3 1.x/Vue/Vite, AGENTS.md, docs/VALIDATION.md и команды check/verify. Сохранять реально установленный совместимый стек текущего репозитория, а не blindly перепинивать его.
- hackalem-docs.zip: ранее предложенные роли, правила работы, стартовый prompt и runbook. Эти документы не доказывают разрешение организатора на импорт pre-existing кода.
- Указание пользователя: сильная сторона TalkIt — DSR OpenAI STT/VAD + Yandex SpeechKit; TTS — ElevenLabs V3; использовался gpt-realtime. Исходный код этих адаптеров в пакет заданий не включён.

## Официальная документация API

1. OpenAI gpt-realtime: text/audio input/output, function calling; Structured Outputs не поддерживаются. Поэтому route_turn + серверная Zod-валидация, не обещание strict schema от модели.
   https://developers.openai.com/api/docs/models/gpt-realtime
2. Realtime conversations: текстовые conversation items, response.create, текстовые ответы, function calling и ручное управление ответом при включённом VAD. Точные event shapes проверить для используемой версии API.
   https://developers.openai.com/api/docs/guides/realtime-conversations
3. Transcription-only sessions отделяют распознавание от разговора с моделью.
   https://developers.openai.com/api/docs/guides/realtime-transcription
4. Yandex SpeechKit streaming: разные типы partial/final/final_refinement и собственные границы фразы; это требует согласования событий DSR, а не двух независимых запусков бизнес-хода.
   https://yandex.cloud/ru-kz/docs/speechkit/stt/streaming
5. ElevenLabs: обычный TTS WebSocket не поддерживает eleven_v3; для v3 существует Text-to-Dialogue WebSocket с отдельным протоколом. Работающий прежний адаптер не следует менять только ради использования нового endpoint.
   https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/tts-vs-ttd-websockets
   https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts
   https://elevenlabs.io/docs/api-reference/text-to-dialogue/ttd-websocket

Не делается предположений о том, какой провайдер точнее на конкретном языке, каков реальный DSR-алгоритм TalkIt, сколько займут API-вызовы и доступны ли ключи/модели в аккаунтах команды. Это проверяется smoke/eval на месте.
