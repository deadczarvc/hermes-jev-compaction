# hermes-jev-compaction — 面向 Hermes Agent 的 Jev 压缩

本仓库是 [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) 面向 Hermes 的专用 fork。语言：[English](README.md) · [Русский](HERMES.ru.md) · **中文**

本 fork 为 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 添加了
fast-jev-compaction 库的适配层：将 OpenAI-chat 格式的会话记录映射为库内部的
`Message[]`，交由 Jev 决策模型（TypeSafe System One API，`jev-1.13.0`）评分，
再将结果映射回去。

除本移植外，未改动上游的任何内容：同一套库、同一套测试、同一套语义。上游的
Claude Code 钩子对 Hermes 无效（Hermes 没有压缩事件；压缩逻辑位于核心）——
因此本移植提供的是**库适配层 + 按需 CLI**。

## 安装

```bash
git clone https://github.com/deadczarvc/fast-jev-compaction
cd fast-jev-compaction
npm install && npm run build
```

要求 Node >= 18。

## CLI：hermes-compact

```bash
export TYPESAFE_API_KEY=...   # 你的 TypeSafe 密钥（console.typesafe.ai）
node bin/hermes-compact.mjs transcript.json --out compacted.json
```

输入：OpenAI-chat 消息的 JSON 数组、`{"messages": [...]}` 或 JSONL。
输出：JSON `{"messages": [...], "stats": {...}}`。

常用选项：`--model jev-1.13.0`（固定版本；默认 `jev-latest`）、`--goal`、
`--keep-threshold`、`--preserve-recent`、`--max-state-tokens`、
`--max-request-tokens`、`--truncate-head`、`--dry-run`（仅输出映射报告，
不需要密钥）。完整列表：`node bin/hermes-compact.mjs --help`。

## 作为库使用

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

语义与库完全一致：保留的消息逐字不变（原始对象）；被丢弃的结果只保留有界
头部加注记；被丢弃的调用连同其结果一起消失。`HermesMessage.content` 可以是
字符串或内容片段数组；工具调用可以是嵌套（`function: {name, arguments}`）
或扁平（`name`、`arguments`）两种写法。非文本内容片段（如图片）不会进入文本
映射——工具输入保留完整结构。

## 测试

```bash
npx vitest run   # 38/38：上游 29 + 适配层 9
```

## 为什么是按需调用而不是钩子

Hermes 0.21.x 的 shell 钩子只有 `pre_tool_call`、`post_tool_call`、
`pre_llm_call`、`on_session_start` —— 没有压缩事件，而压缩位于核心
（`agent/conversation_compression.py`）。给核心打补丁会在下次更新时被冲掉。
关于钩子/扩展点的提案已提交给 agent 上游；在此之前，受支持的集成方式就是这个
按需调用的 CLI + 适配层，可从会话或计划任务中调用。
