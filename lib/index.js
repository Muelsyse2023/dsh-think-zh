/**
 * dsh-think-zh —— 让 agent 的思考过程（界面「思考」折叠块里的 reasoning 内容）始终用中文。
 *
 * ## 为什么是提示词，而不是「把思考翻译一遍」
 *
 * DSH 的 reasoning 不是一次性的展示文本：`BlockAssembler` 把它组装成 assistant 消息的
 * `reasoning` 块写进会话日志，durable 流里的 `source.replayState` 还带着提供方给出的
 * `signature`（`dsh-llm-deepseek` 的 `deltaChunk()` 把 `signature_delta` 累积进 block.replay，
 * 再由 finish chunk 交给 assembler）。下一轮请求时 `serialize()` 会把这些 reasoning 块
 * 原样回放成 `{type:'thinking', thinking, signature}`。
 *
 * 于是「在 `llm/stream` 瀑布里把 reasoning-delta 换成译文」这条路有两个硬代价：
 *   1. 落库的思考文本变了，而 signature 还是原来那份 —— 文本与签名不一致，回放时是否被
 *      提供方接受取决于对方实现，属于拿主链路（多轮工具调用）去赌的行为；
 *   2. 思考流与正文流是同一条有序管道，逐段翻译会插进模型请求的关键路径，拖慢每一轮。
 *
 * 反过来，让模型**直接用中文思考**没有任何这类代价：签名、回放、流式时序全部保持原样，
 * 也不需要额外的模型调用与 token。所以本插件只做一件事 —— 在系统提示里稳定地声明
 * 「思考用简体中文」，这是 profile 级、对所有 agent（含子 agent）生效的接入点。
 *
 * ## 兜底自检
 *
 * 提示词约束的是模型行为，不是机器的强保证。插件因此在会话事件流上做一次极轻的统计：
 * 一个 turn 结束时若思考里拉丁字母明显多于汉字，就写一条 warn 日志。它不修改任何内容，
 * 只是让「模型哪一轮没听话」在日志里可见，便于排查而不是静默失效。
 */

/** Cordis 插件名（Loader 诊断与 patch 里的 id 都用它）。 */
export const name = 'dsh-think-zh'

/** 系统提示段的稳定名字：同名段在作用域内是覆盖关系，改名字等于多一段。 */
const SECTION_NAME = 'dsh:think-zh'

/**
 * 段顺序：紧跟部署人设（DEPLOYMENT_PERSONA_PREFIX = 0）、排在工具与流程段（500+）之前。
 * 语言/风格类要求属于「怎么说话」的一层，放在工具说明前面更容易被当成全局约束。
 */
const DEFAULT_ORDER = 120
const DEFAULT_LANGUAGE = '简体中文'

/** 自检阈值：汉字太少、拉丁字母够多才算「整段没听话」，避免误报短思考与全英文报错片段。 */
const MIN_LATIN_LETTERS = 160
/** 一个 turn 的采样上限：只统计前若干字符，事件回调里不做无界字符串拼接。 */
const MAX_SAMPLED_CHARS = 20000
const MAX_SAMPLE_CHARS = 120
/** 同时跟踪的会话数上限（异常情况下也只会有几十个）。 */
const MAX_TRACKED_SESSIONS = 16

/**
 * 生成系统提示段正文。
 *
 * @param language - 思考过程应当使用的语言名。
 * @param extra - 追加在规则末尾的额外要求（可为空）。
 * @returns 可直接放进系统提示的文本。
 */
function renderPrompt(language, extra) {
  const lines = [
    `# 思考语言（${name}）`,
    `你的思考过程 —— 界面「思考」折叠块里的推理文字，也就是模型返回的 reasoning / thinking 内容块 —— 必须始终使用${language}书写。`,
    `- 与交互语言无关：即使用户用英文提问、代码库与文档全是英文，思考也一律用${language}，不要切换成英文思考。`,
    `- 分析、权衡、比较、计划、试错、自检、对工具结果的判断，全部用${language}表达。`,
    `- 代码、命令、文件路径、标识符、API 与模型名称、报错原文、日志片段保持原样，不要翻译、不要改写。`,
    `- 术语按中文技术写作习惯处理：能自然对应就用中文，生硬音译不如保留英文原词。`,
    `- 这条规则只约束思考过程；最终回复的语言仍由用户与其余指令决定。`,
  ]
  if (extra) lines.push(extra)
  return lines.join('\n')
}

/**
 * 收敛外部配置。插件不导出 Config schema，profile 层写什么都被这里读成「有就用、没有就用默认」，
 * 因此旧配置不会因为一个字段被 Loader 拒绝挂载。
 *
 * @param config - patch 里给出的原始配置。
 * @returns 归一化后的配置。
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const language = typeof raw.language === 'string' && raw.language.trim() !== ''
    ? raw.language.trim()
    : DEFAULT_LANGUAGE
  return {
    enabled: raw.enabled !== false,
    language,
    extra: typeof raw.extra === 'string' ? raw.extra.trim() : '',
    order: Number.isFinite(raw.order) ? Number(raw.order) : DEFAULT_ORDER,
    warnOnNonChinese: raw.warnOnNonChinese !== false,
  }
}

/** 统计一段文本里的汉字个数（基本区 + 扩展 A + 兼容区）。 */
function countCjk(text) {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)
    if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) n += 1
  }
  return n
}

/** 统计一段文本里的拉丁字母个数（只算字母，不算空白、标点与代码符号）。 */
function countLatin(text) {
  let n = 0
  for (const ch of text) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) n += 1
  }
  return n
}

/** 会话标识：优先用 id，取末 8 位做日志里的短名。 */
function sessionKey(session) {
  try {
    const raw = session?.id ?? session?.sessionId ?? ''
    const s = String(raw)
    return s ? s.slice(-8) : '-'
  } catch {
    return '-'
  }
}

/**
 * 安装「思考语言自检」：只听 `session/event`，只统计，不改写。
 *
 * 统计粒度是 **step**（一次模型请求）而不是 turn：一个 turn 里可能有很多步，把整个 turn 的
 * 思考混在一起统计，会让「插件刚挂载的那一轮」里前几步的英文思考把后面的中文思考淹没。
 * 每个 step 结束时给出一条 warn（若判定为没听话），随后丢弃该 step 的计数；step 被中断也不会
 * 把字数带进下一步。
 *
 * @param ctx - 插件上下文。
 * @param cfg - 归一化配置。
 */
function installSelfCheck(ctx, cfg) {
  /** sessionKey → { cjk, latin, sample, truncated } */
  const stats = new Map()

  const bucket = (key) => {
    let entry = stats.get(key)
    if (entry === undefined) {
      entry = { cjk: 0, latin: 0, sample: '', truncated: false }
      stats.set(key, entry)
      if (stats.size > MAX_TRACKED_SESSIONS) {
        const oldest = stats.keys().next().value
        if (oldest !== key) stats.delete(oldest)
      }
    }
    return entry
  }

  const reset = (key) => {
    const entry = stats.get(key)
    if (entry !== undefined) {
      entry.cjk = 0
      entry.latin = 0
      entry.sample = ''
      entry.truncated = false
    }
  }

  const report = (key) => {
    const entry = stats.get(key)
    stats.delete(key)
    if (entry === undefined) return
    if (entry.latin < MIN_LATIN_LETTERS || entry.latin <= entry.cjk * 2) return
    const ratio = entry.latin / Math.max(1, entry.latin + entry.cjk)
    ctx.logger.warn(
      `${name}: 会话 ${key} 本步的思考看起来不是中文`
      + `（拉丁字母 ${entry.latin}，汉字 ${entry.cjk}，拉丁占比 ${Math.round(ratio * 100)}%）：`
      + `${entry.sample}${entry.truncated ? '…' : ''}`,
    )
  }

  ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      const key = sessionKey(session)

      if (type === 'turn/start' || type === 'step/start') {
        reset(key)
        return
      }

      if (type === 'assistant/chunk') {
        const chunk = event.data?.chunk
        if (chunk?.type !== 'reasoning-delta') return
        const piece = typeof chunk.text === 'string' ? chunk.text : ''
        if (piece === '') return
        const entry = bucket(key)
        if (entry.cjk + entry.latin < MAX_SAMPLED_CHARS) {
          entry.cjk += countCjk(piece)
          entry.latin += countLatin(piece)
        } else {
          entry.truncated = true
        }
        if (entry.sample.length < MAX_SAMPLE_CHARS) {
          const one = piece.replace(/\s+/g, ' ')
          entry.sample = (entry.sample + one).slice(0, MAX_SAMPLE_CHARS)
        }
        return
      }

      if (type === 'step/end' || type === 'turn/end') report(key)
    } catch {
      // 事件回调里抛异常会影响 agent 主链路；自检本身不重要，一律吞掉。
    }
  })

  ctx.on('session/disposed', (session) => {
    stats.delete(sessionKey(session))
  })
}

/**
 * 挂载插件：注册系统提示段，并（可选）打开自检。
 *
 * @param ctx - 插件上下文。
 * @param config - profile patch 给出的配置。
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger.info(`${name}: enabled=false，未注册思考语言提示段`)
    return
  }

  const text = renderPrompt(cfg.language, cfg.extra)
  // 作用域注入：systemPrompt 缺席的极简组合不会卡住启动，只是这里不注册。
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.systemPrompt.section({ name: SECTION_NAME, order: cfg.order, text })
    promptCtx.logger.info(`${name}: 已注册系统提示段 ${SECTION_NAME}（language=${cfg.language}, order=${cfg.order}）`)
  })

  if (cfg.warnOnNonChinese) installSelfCheck(ctx, cfg)
}
