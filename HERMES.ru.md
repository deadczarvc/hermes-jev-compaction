# hermes-jev-compaction — Jev-компакция для Hermes Agent

Hermes-специализированный форк [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction). Языки: [English](README.md) · **Русский** · [中文](HERMES.zh-CN.md)

Форк добавляет адаптер библиотеки fast-jev-compaction под [Hermes Agent](https://github.com/NousResearch/hermes-agent): транскрипт в формате OpenAI-chat отображается во внутренний формат `Message[]`, прогоняется через решающую модель Jev (TypeSafe System One API, `jev-1.13.0`), результат отображается обратно.

Больше ничего из апстрима не менялось: та же библиотека, те же тесты, та же семантика. Хуки апстрима под Claude Code для Hermes бесполезны (в Hermes нет события компакции; сжатие живёт в ядре) — поэтому порт поставляется как **адаптер-библиотека + CLI по требованию**.

## Установка

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd fast-jev-compaction
npm install && npm run build
```

Требуется Node >= 18.

## CLI: hermes-compact

```bash
export TYPESAFE_API_KEY=...   # ваш ключ TypeSafe (console.typesafe.ai)
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

Вход: JSON-массив сообщений OpenAI-chat, `{"messages": [...]}` или JSONL.
Выход: JSON `{"messages": [...], "stats": {...}}`.

Ключевые опции: `--model jev-1.13.0` (пин; по умолчанию `jev-latest`), `--goal`,
`--keep-threshold`, `--preserve-recent`, `--max-state-tokens`,
`--max-request-tokens`, `--truncate-head`, `--dry-run` (отчёт о маппинге без
ключа). Полный список: `node bin/hermes-compact.mjs --help`.

## Использование как библиотеки

```ts
import { fromHermes, toHermes, hermesGoal } from './src/hermes.js';
import { compactMessages } from './dist/index.js';

const { messages, systemTexts } = fromHermes(hermesTranscript);
const result = await compactMessages(messages, {
  model: 'jev-1.13.0',
  goal: hermesGoal(systemTexts),
});
const compacted = toHermes(result.messages);
```

Семантика идентична библиотеке: сохранённые сообщения остаются дословно
(исходные объекты), у удалённых результатов остаётся ограниченная голова +
пометка, удалённые вызовы исчезают вместе с результатами.
`HermesMessage.content` может быть строкой или массивом контент-частей; вызовы
инструментов — вложенными (`function: {name, arguments}`) или плоскими
(`name`, `arguments`). Нетекстовые контент-части (например, изображения)
игнорируются текстовым маппингом — входы инструментов сохраняют полную
структуру.

## Тесты

```bash
npx vitest run            # 32/32
python -m pytest tests/test_jev_engine.py   # 18/18
```

## Почему по требованию, а не хук

Hermes 0.21.x открывает shell-хуки на `pre_tool_call`, `post_tool_call`,
`pre_llm_call`, `on_session_start` — события компакции нет, а сжатие живёт в
ядре (`agent/conversation_compression.py`). Патч ядра умирает при следующем
обновлении. Вопрос о hook/точке расширения вынесен апстриму агента; до тех пор
поддерживаемая интеграция — этот CLI + адаптер, вызываемые по требованию из
сессии или планировщика.
