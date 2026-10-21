# dsh-think-zh

让 agent 的**思考过程**（Web 界面「思考」折叠块里的 reasoning 内容）始终用**简体中文**的 DSH 插件。

## 它做什么

在系统提示里注册一个稳定的提示段，声明：模型的 reasoning / thinking 内容块一律用简体中文书写，
包括分析、权衡、计划、试错与自检；同时要求代码、命令、路径、标识符、报错原文保持原样，
不做「翻译式改写」。

注册点是 `systemPrompt.section({ name: 'dsh:think-zh', order: 120 })`，位于部署人设（order 0）
之后、工具与流程段（order 500+）之前。它是**全局作用域**的段，因此对当前 profile 下的所有
agent 生效，子 agent 一并继承。

## 为什么不是「把思考逐段翻译成中文」

这是本插件唯一重要的设计取舍，值得写清楚。DSH 里 reasoning 不是一次性的展示文本：

- `BlockAssembler` 会把 reasoning 的 delta 组装成 assistant 消息的 `reasoning` 内容块，写进
  **durable 会话日志**；
- `dsh-llm-deepseek` 会把提供方返回的 `signature_delta` 累积进 replay 元数据，随后随 finish
  chunk 交给 assembler，最终落在 `message.source.replayState`；
- 下一轮请求时 `serialize()` 原样回放这些块：`{ type: 'thinking', thinking, signature }`。

于是「在 `llm/stream` 瀑布里把 `reasoning-delta` 换成译文」会付出两个代价：

1. **签名与文本不再匹配。** 落库的是译文，signature 还是原来那份，回放是否被提供方接受取决于
   对方实现 —— 这是拿多轮工具调用这条主链路去赌。
2. **翻译落在关键路径上。** 思考流与正文流是同一条有序管道，逐段翻译必然插进每轮请求的时序里，
   既增加延迟又要额外花一遍 token。

而让模型**直接**用中文思考没有任何这类代价：签名、回放、流式时序全部保持原样，也不需要额外的
模型调用。所以本插件做的是「把语言要求稳定地讲给模型听」，而不是「事后翻译已生成的内容」。

## 仓库结构

```
dsh-think-zh/
├── lib/index.js        # 插件本体，零运行时依赖（不 import 任何包）
├── cordis.patch.yml    # bundle 挂载声明：往 profile 里插一行
├── package.json        # dsh.bundle.patch 指向上面那份 patch
└── README.md
```

## 安装

```bash
git clone https://github.com/Muelsyse2023/dsh-think-zh.git
dsh plugin --profile web add link:/path/to/dsh-think-zh
```

`link:` 安装的是本地目录，改代码后重启（或等 HMR 重载）即可生效，不需要重新安装。也可以装成
普通依赖：`dsh plugin --profile web add github:Muelsyse2023/dsh-think-zh`。

包内 `cordis.patch.yml` 声明一行：

```yaml
- insert:
    - id: dsh-think-zh
      name: 'dsh-think-zh'
```

卸载：用 Web 侧边栏的**插件**页删除 `dsh-think-zh`（它会同时取消组合包选择并跑 pnpm）。只用
CLI 时 `dsh plugin --profile web remove dsh-think-zh` 只删依赖，记得再把 `dsh-think-zh` 从
`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里去掉。只想临时关掉而不卸载，
在 `~/.dsh/profiles/web/cordis.patch.yml` 里覆盖同一 id 的 `disabled: true` 即可（Web 的「插件」页
也能直接开关）。

## 配置

在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: dsh-think-zh
  name: 'dsh-think-zh'
  config:
    language: 简体中文
    extra: 如果本轮需要输出英文思考（例如对齐上游日志），在思考开头用一行说明原因。
    warnOnNonChinese: true
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不注册提示段（等价于禁用）。 |
| `language` | `简体中文` | 思考过程使用的语言名，直接写进提示文本。 |
| `extra` | `''` | 追加在规则末尾的额外要求，用来给特定部署打补丁。 |
| `order` | `120` | 系统提示段顺序；人设前缀是 `0`，工具段从 `500` 起。 |
| `warnOnNonChinese` | `true` | 是否开启兜底自检（见下）。 |

## 兜底自检

提示词约束的是模型行为，不是机器的强保证。插件因此在 `session/event` 上做一次极轻的统计：

- 只统计 `assistant/chunk` 里 `reasoning-delta` 的文本，忽略正文；
- 采样上限 20000 字符、同一时刻最多跟踪 16 个会话，回调里不抛异常、不写任何会话内容；
- 统计粒度是 **step**（一次模型请求）：一个 step 结束时，若拉丁字母 ≥ 160 且超过汉字数的 2 倍，
  写一条 `warn` 日志（含短会话名、计数与开头 120 字样本），否则静默。用 step 而不是 turn，
  是为了不让「插件刚挂载那一轮」里前几步的英文思考把后面的中文思考淹没。

它不修改任何内容，只是让「模型哪一轮没听话」在日志里可见，而不是静默失效。

## 验证

1. 提示段是否进了请求：新一轮的 durable 日志里 `system/message` 的文本应包含
   `# 思考语言（dsh-think-zh）`。
2. 模型是否听话：看界面「思考」块的语言，或查日志里有没有上面那条 `warn`。
