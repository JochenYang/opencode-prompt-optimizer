/** @jsxImportSource @opentui/solid */
/**
 * Prompt Optimizer TUI Plugin for OpenCode
 *
 * Renders a "✦" icon in the input prompt footer (home + session).
 * On click, runs a background LLM session to expand the user's brief
 * request into a directly-executable task specification.
 *
 * By default, inherits the primary agent's model — no configuration
 * needed. Power users can pin a model via `overrideModel` in tui.json.
 *
 * The `language` option drives both the LLM output language and the
 * toast messages. Default: "zh".
 */

import { createSignal, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPromptRef } from "@opencode-ai/plugin/tui"

type ModelSpec = { providerID: string; modelID: string }
type Language = "en" | "zh"
type LanguageSetting = Language | "auto"

type PluginOptions = {
  /** Force a specific model. Default: inherit from primary agent. */
  overrideModel?: ModelSpec
  /** Model variant (e.g. "non-thinking"). Provider-specific. */
  variant?: string
  /** UI + LLM output language. "auto" detects from input text. Default: "auto". */
  language?: LanguageSetting
  /** Polling timeout per session (ms). Default: 90000. */
  timeoutMs?: number
  /** Polling interval (ms). Default: 800. */
  pollIntervalMs?: number
}

const DEFAULT_TIMEOUT = 90_000
const DEFAULT_POLL = 800
const IDLE_ICON = "✧" // hollow four-pointed star

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// System prompt hints per language — drives the LLM's output language.
// Toast strings are always English (single source of truth for UI).
const LANG = {
  en: {
    hint: "Output the optimized prompt in English. No explanation, no preamble, no think tags.",
  },
  zh: {
    hint: "用中文输出优化后的 prompt. 不要任何解释、前缀或 think 标签.",
  },
} as const satisfies Record<Language, { hint: string }>

// English-only UI strings.
const TOAST = {
  success: "Optimized",
  failedTitle: "Optimization failed",
  emptyInput: "Input is empty, nothing to optimize",
} as const

// Heuristic: any CJK Unified Ideograph means zh, otherwise en.
const detectLanguage = (text: string): Language => /[\u4e00-\u9fff]/.test(text) ? "zh" : "en"

const stripThinkBlocks = (s: string): string =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\|begin▁of▁thinking\|>[\s\S]*?<\|end▁of▁thinking\|>/gi, "")
    .trim()

const buildSystem = (lang: Language) => `You are a senior PM + full-stack engineer. Expand the user's brief request into a concise, directly-executable task spec.

Principles:
1. Convert statement → imperative ("I want X" → "Please help me build X")
2. Specify the sub-type
3. Add 3-5 KEY industry-standard elements (NOT all possible — be concise)
4. Add brief non-functional requirements
5. One-line style/UX requirement
6. Format: natural language + short list, no Markdown headings
7. **Hard length limit: 300 words max**
8. Keep user's original intent; do not invent roles
9. Fill missing info with sensible defaults; do not ask back
10. ${LANG[lang].hint}

Template:
"Please help me build [specific type] of [product]. It should include: [element 1], [element 2].... Non-functional: [brief]. Style: [brief]."

Forbidden:
- "## Task / ## Goal" sections (that's plan mode, not prompt optimization)
- "Please provide more info" reverse questions
- "You are XX" role assignments
- Enumerating every possible element (3-5 is enough)

Output the spec text only.`

const tui: TuiPlugin = async (api: TuiPluginApi, options?: PluginOptions) => {
  const languageSetting: LanguageSetting = options?.language ?? "auto"
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT
  const pollMs = options?.pollIntervalMs ?? DEFAULT_POLL
  const variant = options?.variant
  const overrideModel = options?.overrideModel

  console.error("[prompt-optimizer] plugin loaded", {
    language: languageSetting,
    model: overrideModel ?? "(inherit)",
    variant: variant ?? "(none)",
  })

  let homeCaptured: TuiPromptRef | undefined
  let sessionCaptured: TuiPromptRef | undefined
  const [busy, setBusy] = createSignal(false)

  const runEnhance = async (ref: TuiPromptRef) => {
    if (busy()) return
    const raw = ref.current.input.trim()
    if (!raw) {
      api.ui.toast({ variant: "warning", message: TOAST.emptyInput })
      return
    }

    setBusy(true)
    try {
      const language = languageSetting === "auto" ? detectLanguage(raw) : languageSetting
      const system = buildSystem(language)
      const userText = `${raw}

（请直接输出优化后的 prompt, 不要任何解释、标记或格式说明）`
      const result = await tryOne(api, overrideModel, variant, system, userText, timeoutMs, pollMs)
      ref.set({
        input: result,
        mode: "normal",
        parts: [{ type: "text", text: result }],
      })
      ref.focus()
      api.ui.toast({ variant: "success", message: TOAST.success })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[prompt-optimizer] enhance failed:", msg)
      api.ui.toast({
        variant: "error",
        title: TOAST.failedTitle,
        message: msg.slice(0, 240),
        duration: 8000,
      })
    } finally {
      setBusy(false)
    }
  }

  api.slots.register({
    slots: {
      home_prompt(_ctx, props) {
        const refCapture = (ref: TuiPromptRef | undefined) => {
          homeCaptured = ref
          props.ref?.(ref)
        }
        return api.ui.Prompt({
          ref: refCapture,
          right: (
            <EnhanceButton
              api={api}
              busy={busy}
              getRef={() => homeCaptured}
              onEnhance={(ref) => void runEnhance(ref)}
            />
          ),
        })
      },
      session_prompt(_ctx, props) {
        const refCapture = (ref: TuiPromptRef | undefined) => {
          sessionCaptured = ref
          props.ref?.(ref)
        }
        return api.ui.Prompt({
          ref: refCapture,
          sessionID: props.session_id,
          visible: props.visible,
          disabled: props.disabled,
          onSubmit: props.on_submit,
          right: (
            <EnhanceButton
              api={api}
              busy={busy}
              getRef={() => sessionCaptured}
              onEnhance={(ref) => void runEnhance(ref)}
            />
          ),
        })
      },
    },
  })
}

function EnhanceButton(props: {
  api: TuiPluginApi
  busy: () => boolean
  getRef: () => TuiPromptRef | undefined
  onEnhance: (ref: TuiPromptRef) => void
}) {
  const handleClick = () => {
    if (props.busy()) return
    const ref = props.getRef()
    if (!ref) return
    props.onEnhance(ref)
  }

  return (
    <Show
      when={props.busy()}
      fallback={
        <text fg={props.api.theme.current.accent} wrapMode="none" onMouseDown={handleClick}>
          {IDLE_ICON}
        </text>
      }
    >
      <spinner
        frames={SPINNER_FRAMES}
        interval={80}
        color={props.api.theme.current.textMuted}
      />
    </Show>
  )
}

async function tryOne(
  api: TuiPluginApi,
  model: ModelSpec | undefined,
  variant: string | undefined,
  system: string,
  userText: string,
  timeoutMs: number,
  pollMs: number,
): Promise<string> {
  const createBody: Record<string, unknown> = {}
  if (model) {
    const m: Record<string, unknown> = { id: model.modelID, providerID: model.providerID }
    if (variant) m.variant = variant
    createBody.model = m
  }
  const created = await api.client.session.create(createBody)
  const sessionID = created.data?.id
  if (!sessionID) throw new Error("session.create returned no data")

  await api.client.session.prompt({
    sessionID,
    ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
    ...(variant ? { variant } : {}),
    system,
    parts: [{ type: "text", text: userText }],
  })

  const optimized = await pollAssistantText(api, sessionID, timeoutMs, pollMs)
  if (!optimized) {
    throw new Error(`${Math.round(timeoutMs / 1000)}s timeout`)
  }
  return optimized
}

async function pollAssistantText(
  api: TuiPluginApi,
  sessionID: string,
  timeoutMs: number,
  pollMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const resp = await api.client.session.messages({ sessionID })
    const messages = (resp.data ?? []) as Array<{
      info: { role: "user" | "assistant"; time?: { completed?: number } }
      parts: Array<{ type: string; text?: string }>
    }>

    const assistant = messages.find((m) => m.info.role === "assistant")
    if (assistant?.info.time?.completed) {
      const text = assistant.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")

      const cleaned = stripThinkBlocks(text)
      if (cleaned.length > 0) return cleaned
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }

  return undefined
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-prompt-optimizer",
  tui,
}

export default plugin
