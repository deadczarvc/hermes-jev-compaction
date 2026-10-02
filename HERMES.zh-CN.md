# hermes-jev-compaction — Hermes 集成说明

请先阅读 [README](README.md)（英文）。语言：[English](HERMES.md) · [Русский](HERMES.ru.md) · **中文**

本 fork 以两种方式在 Hermes Agent 中运行 Jev 压缩：

- **会话内** —— `hermes-plugin/` 是 Hermes 的上下文引擎插件（`jev-context-engine`，`ContextEngine` 扩展点）。
  每当上下文越过压缩阈值，Hermes 就会调用它；无需修改核心。
- **按需** —— `bin/hermes-compact.mjs` 将 OpenAI-chat 会话记录映射为库的 `Message[]`，交由 Jev 决策模型
  （TypeSafe System One API，`jev-1.13.0`）评分，再将结果映射回去。

两种方式都遵循 [docs/fact-rails.md](docs/fact-rails.md) 中的事实护栏：被丢弃的调用保留其行；可复现的读取折叠为
一行说明；其余结果保留开头、事实行与结尾，完整输出保存到说明中写明的文件里。

## 安装

```bash
git clone https://github.com/deadczarvc/hermes-jev-compaction
cd hermes-jev-compaction
npm install && npm run build
```

CLI 和库需要 Node >= 18；插件只需要 Hermes 的 Python 环境。

## 会话内插件

1. 将 `hermes-plugin/` 复制到 `~/.hermes/plugins/jev-context-engine/`。
2. 在 `config.yaml` 中设置 `context.engine: jev`。
3. 将 `TYPESAFE_API_KEY` 写入 Hermes 的 `.env`（启动时会加载到进程环境）。

`context.jev` 下的可选设置：`model`（默认 `jev-1.13.0`）、`keep_threshold`（0.5）、`max_state_tokens`（25000）、
`max_request_tokens`（30000）、`egress_mode`（默认 `metadata`：结果文本不离开进程；另有 `redacted_text`、
`full_text`、`off`——未知值时不发送任何内容）。

开关默认全部开启（设为 `=0` 即关闭）：

| 变量 | 关闭后恢复为 |
|---|---|
| `JEV_COMPACTION_SAVE_OUTPUTS` | 不保存完整输出；说明指向 `state.db` |
| `JEV_COMPACTION_VALUE_SELECT` | v0.7.x 的正则事实行，而非学习到的 token 价值 |
| `JEV_COMPACTION_POOL` | 每个存根各自的事实预算（v0.8） |
| `JEV_COMPACTION_CONTAIN` | v0.9 的覆盖方式，不计入嵌在更长 token 中可读的 token |

Jev 不可用时，同样的规则在本地执行（`mode = "fallback"`）：不发 HTTP，也不做摘要。

## CLI：hermes-compact

```bash
export TYPESAFE_API_KEY=...   # 你的 TypeSafe 密钥（console.typesafe.ai）
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

输入：OpenAI-chat 消息的 JSON 数组、`{"messages": [...]}` 或 JSONL。
输出：JSON `{"messages": [...], "stats": {...}}`。

常用选项：`--model jev-1.13.0`（固定版本；默认 `jev-latest`）、`--goal`、`--keep-threshold`、`--preserve-recent`、
`--max-state-tokens`、`--max-request-tokens`、`--truncate-head`、`--dry-run`（仅输出映射报告，不需要密钥）。
完整列表：`node bin/hermes-compact.mjs --help`。

## 作为库使用

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

把会话记录传回 `toHermes`，映射未建模的内容（图片、未知角色、不透明字段、原始参数）都会保留：全部保留时的往返结果
与输入相同。`HermesMessage.content` 可以是字符串或内容片段数组；工具调用可以是嵌套（`function: {name, arguments}`）
或扁平（`name`、`arguments`）写法。

## 测试

```bash
npm run build                 # CLI 测试运行 dist/
npx vitest run                # 41/41（库、适配层、CLI）
PYTHONPATH=<hermes-agent 路径> python -m pytest tests/   # 99/99（插件；导入 agent.context_engine）
```

计数对应 v0.10.0。
