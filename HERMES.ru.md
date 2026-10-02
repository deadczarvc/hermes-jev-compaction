# hermes-jev-compaction — заметки об интеграции с Hermes

Начните с [README](README.md) (на английском). Языки: [English](HERMES.md) · **Русский** · [中文](HERMES.zh-CN.md).

Форк запускает Jev-компакцию внутри Hermes Agent двумя способами:

- **В сессии** — `hermes-plugin/` это плагин движка контекста Hermes (`jev-context-engine`, точка расширения
  `ContextEngine`). Hermes вызывает его каждый раз, когда контекст пересекает порог сжатия; ядро не патчится.
- **По требованию** — `bin/hermes-compact.mjs` отображает транскрипт OpenAI-chat в `Message[]` библиотеки, прогоняет
  решающую модель Jev (TypeSafe System One API, `jev-1.13.0`) и отображает результат обратно.

Оба пути соблюдают рельсы фактов из [docs/fact-rails.md](docs/fact-rails.md): удалённый вызов сохраняет свою строку,
воспроизводимое чтение сворачивается в пометку, у остальных результатов остаются начало, строки с фактами и хвост, а
полный вывод сохраняется в файл, названный в пометке.

## Установка

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd hermes-jev-compaction
npm install && npm run build
```

CLI и библиотеке нужен Node >= 18; плагину — только Python-окружение Hermes.

## Плагин в сессии

1. Скопируйте `hermes-plugin/` в `~/.hermes/plugins/jev-context-engine/`.
2. Укажите `context.engine: jev` в `config.yaml`.
3. Положите `TYPESAFE_API_KEY` в `.env` Hermes (он загружается в окружение процесса при старте).

Необязательные настройки в `context.jev`: `model` (по умолчанию `jev-1.13.0`), `keep_threshold` (0.5),
`max_state_tokens` (25000), `max_request_tokens` (30000), `egress_mode` (по умолчанию `metadata`: текст результатов не
покидает процесс; также `redacted_text`, `full_text`, `off` — при неизвестном значении ничего не отправляется).

Переключатели, все включены по умолчанию (`=0` выключает):

| Переменная | Выключение возвращает |
|---|---|
| `JEV_COMPACTION_SAVE_OUTPUTS` | полные выводы не сохраняются; пометка указывает на `state.db` |
| `JEV_COMPACTION_VALUE_SELECT` | строки фактов по регуляркам из v0.7.x вместо выученной ценности токенов |
| `JEV_COMPACTION_POOL` | отдельный бюджет фактов на каждую заглушку (v0.8) |
| `JEV_COMPACTION_CONTAIN` | покрытие v0.9, без токенов, читаемых внутри более длинных |

Если Jev недоступен, те же правила работают локально (`mode = "fallback"`): без HTTP и без пересказа.

## CLI: hermes-compact

```bash
export TYPESAFE_API_KEY=...   # ваш ключ TypeSafe (console.typesafe.ai)
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

Вход: JSON-массив сообщений OpenAI-chat, `{"messages": [...]}` или JSONL.
Выход: JSON `{"messages": [...], "stats": {...}}`.

Ключевые опции: `--model jev-1.13.0` (пин; по умолчанию `jev-latest`), `--goal`, `--keep-threshold`,
`--preserve-recent`, `--max-state-tokens`, `--max-request-tokens`, `--truncate-head`, `--dry-run` (отчёт о маппинге
без ключа). Полный список: `node bin/hermes-compact.mjs --help`.

## Использование как библиотеки

```ts
import { fromHermes, toHermes, hermesGoal } from './src/hermes.js';
import { compactMessages } from './dist/index.js';

const transcript = fromHermes(hermesMessages);
const result = await compactMessages(transcript.messages, {
  model: 'jev-1.13.0',
  goal: hermesGoal(transcript.systemTexts),
});
const compacted = toHermes(result.messages, transcript);
```

Если передать транскрипт обратно в `toHermes`, сохраняется всё, что маппинг не моделирует (изображения, неизвестные
роли, непрозрачные поля, сырые аргументы): круг «всё оставить» равен входу. `HermesMessage.content` может быть строкой
или массивом контент-частей; вызовы инструментов — вложенными (`function: {name, arguments}`) или плоскими
(`name`, `arguments`).

## Тесты

```bash
npm run build                 # тесты CLI запускают dist/
npx vitest run                # 41/41 (библиотека, адаптер, CLI)
PYTHONPATH=<путь-к-hermes-agent> python -m pytest tests/   # 99/99 (плагин; импортирует agent.context_engine)
```

Счётчики — версии v0.10.0.
