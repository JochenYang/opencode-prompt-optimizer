/** @jsxImportSource @opentui/solid */
/**
 * Prompt Optimizer TUI Plugin for OpenCode (v0.2.0)
 *
 * Two modes:
 *   - spec:    generic task spec (v0.1.x behavior, default for new projects)
 *   - enhance: project-aware engineering prompt (default when CWD has a project)
 *
 * NOTE on TSX parsing: avoid `[{` (array-of-object) and `: {` (nested object)
 * in inline expressions — the TSX parser misreads the inner `{` as a JSX
 * fragment start. Always build nested objects in named consts first.
 */

import { createSignal, Show } from "solid-js"
import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPromptRef } from "@opencode-ai/plugin/tui"

type ModelSpec = { providerID: string; modelID: string }
type Language = "en" | "zh"
type LanguageSetting = Language | "auto"
type Mode = "spec" | "enhance"
type ModeSetting = Mode | "auto"

type PluginOptions = {
  overrideModel?: ModelSpec
  variant?: string
  language?: LanguageSetting
  timeoutMs?: number
  pollIntervalMs?: number
  mode?: ModeSetting
  includeContext?: boolean
}

const DEFAULT_TIMEOUT = 90_000
const DEFAULT_POLL = 800
const IDLE_ICON = "✧"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

const LANG: Record<Language, { hint: string }> = {
  en: { hint: "Output the optimized prompt in English. No explanation, no preamble, no think tags." },
  zh: { hint: "用中文输出优化后的 prompt. 不要任何解释、前缀或 think 标签." },
}

const TOAST = {
  successSpec: "Optimized (review before sending)",
  successEnhance: "Enhanced (draft, review before sending)",
  failedTitle: "Optimization failed",
  emptyInput: "Input is empty, nothing to optimize",
}

const detectLanguage = (text: string): Language => /[\u4e00-\u9fff]/.test(text) ? "zh" : "en"

const stripThinkBlocks = (s: string): string =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\|begin▁of▁thinking\|>[\s\S]*?<\|end▁of▁thinking\|>/gi, "")
    .trim()

const STRONG_DOC_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  ".cursorrules",
  ".windsurfrules",
  "CONVENTIONS.md",
  "INSTRUCTIONS.md",
  ".github/copilot-instructions.md",
] as const

function findFirstFile(cwd: string, names: string[]): string | null {
  for (const name of names) {
    const p = join(cwd, name)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

function readTextSafe(path: string, maxBytes: number): string | null {
  try {
    if (!existsSync(path)) return null
    const stat = statSync(path)
    if (!stat.isFile() || stat.size === 0) return null
    const buf = readFileSync(path)
    if (buf.length === 0) return null
    return buf.subarray(0, maxBytes).toString("utf-8")
  } catch {
    return null
  }
}

type ProjectContext = {
  name: string
  description: string
  stack: string
  docs: string
}

function gatherProjectContext(cwd: string): ProjectContext | null {
  const pkgRaw = readTextSafe(join(cwd, "package.json"), 1024)
  if (!pkgRaw) return null

  let name = ""
  let description = ""
  let stack = ""
  try {
    const pkg = JSON.parse(pkgRaw)
    name = typeof pkg.name === "string" ? pkg.name : ""
    description = typeof pkg.description === "string" ? pkg.description : ""
    const depList: string[] = []
    if (pkg.dependencies && typeof pkg.dependencies === "object") {
      depList.push(...Object.keys(pkg.dependencies).slice(0, 8))
    }
    if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
      depList.push(...Object.keys(pkg.devDependencies).slice(0, 6))
    }
    stack = depList.filter(Boolean).join(", ")
  } catch {
    return null
  }

  let docs = ""
  let budget = 2048
  for (const file of STRONG_DOC_FILES) {
    if (budget <= 0) break
    const content = readTextSafe(join(cwd, file), Math.min(budget, 512))
    if (content) {
      const header = "[from: " + file + "]\n"
      docs += "\n" + header + content + "\n"
      budget -= content.length + header.length
    }
  }

  for (const sub of [".cursor/rules", ".continue/rules"]) {
    if (budget <= 0) break
    const dir = join(cwd, sub)
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const found = findFirstFile(dir, ["AGENTS.md", "CLAUDE.md"])
    if (!found) continue
    const content = readTextSafe(found, Math.min(budget, 512))
    if (content) {
      const base = sub + "/" + found.split(/[\\/]/).pop()
      const header = "[from: " + base + "]\n"
      docs += "\n" + header + content + "\n"
      budget -= content.length + header.length
    }
  }

  return { name, description, stack, docs: docs.trim() }
}

const ENHANCE_RE_LIST: RegExp[] = [
  /\b(修复|重构|优化|报错|崩溃|异常|失败|慢|卡|闪退|性能|故障|bug|fix|crash|error|slow|leak|optimize|refactor|regression|broken|debug|trace)\b/i,
  /[\w/\\.-]+\.[a-z][a-z]?[a-z]?[a-z]?:\d\d?\d?\d?/,
  /\b(函数|类|方法|组件|module|function|class|method|component|file|文件|模块|api|endpoint|路由|route)\b/i,
]
const SPEC_RE_LIST: RegExp[] = [
  /\b(博客|文章|邮件|文案|写给|推广|投稿|诗|故事|小说|blog|article|essay|poem|story|newsletter)\b/i,
]
const VAGUE_ACTION_RE =
  /\b(构建|开发|添加|实现|新增|做一个|写个|创建|搞个|来一个|做个|加个|建一个|建个|build|develop|add|create|implement|new)\b/i

function detectMode(input: string, projectExists: boolean): Mode {
  for (const re of ENHANCE_RE_LIST) if (re.test(input)) return "enhance"
  for (const re of SPEC_RE_LIST) if (re.test(input)) return "spec"
  if (projectExists && VAGUE_ACTION_RE.test(input)) return "enhance"
  return "spec"
}

const SPEC_SYSTEM_PROMPT = (lang: Language): string =>
  "You are a senior PM + full-stack engineer. Expand the user's brief request into a concise, directly-executable task spec.\n\n" +
  "Principles:\n" +
  "1. Convert statement to imperative (\"I want X\" -> \"Please help me build X\")\n" +
  "2. Specify the sub-type\n" +
  "3. Add 3-5 KEY industry-standard elements (NOT all possible - be concise)\n" +
  "4. Add brief non-functional requirements\n" +
  "5. One-line style/UX requirement\n" +
  "6. Format: natural language + short list, no Markdown headings\n" +
  "7. Hard length limit: 300 words max\n" +
  "8. Keep user's original intent; do not invent roles\n" +
  "9. Fill missing info with sensible defaults; do not ask back\n" +
  "10. " + LANG[lang].hint + "\n\n" +
  "Template:\n" +
  "\"Please help me build [specific type] of [product]. It should include: [element 1], [element 2].... Non-functional: [brief]. Style: [brief].\"\n\n" +
  "Forbidden:\n" +
  "- \"## Task / ## Goal\" sections (that's plan mode, not prompt optimization)\n" +
  "- \"Please provide more info\" reverse questions\n" +
  "- \"You are XX\" role assignments\n" +
  "- Enumerating every possible element (3-5 is enough)\n\n" +
  "Output the spec text only."

function buildEnhanceSystem(lang: Language, project: ProjectContext | null, userInput: string): string {
  const ws = project
    ? "[WORKSPACE]\n" +
      "- Project: " + project.name + (project.description ? " - " + project.description : "") + "\n" +
      "- Stack: " + (project.stack || "(unknown)") + "\n" +
      "- CWD: " + process.cwd() + "\n" +
      (project.docs ? "\n[PROJECT CONVENTIONS]\n" + project.docs + "\n" : "")
    : "[WORKSPACE: no project context (no package.json in cwd)]"

  return (
    "You are a project-aware prompt enhancer. Output is a DRAFT that the user will review and edit before sending to the main agent.\n\n" +
    ws + "\n\n" +
    "[USER REQUEST]\n" + userInput + "\n\n" +
    "[YOUR JOB]\n" +
    "Rewrite the user's rough request into a clear, directly-executable engineering prompt that:\n" +
    "1. References specific files (path:line) when relevant to the request\n" +
    "2. Follows the project's existing tech stack and conventions (see [WORKSPACE])\n" +
    "3. Lists the sub-tasks in execution order\n" +
    "4. Includes non-functional requirements (tests, types, error handling, perf)\n" +
    "5. Output is a DRAFT - keep it concise, do NOT over-engineer\n" +
    "6. Hard length limit: 300 words max\n" +
    "7. Format: natural language + short list, no Markdown headings\n" +
    "8. " + LANG[lang].hint + "\n\n" +
    "Start the prompt with: \"[DRAFT]\""
  )
}

function buildSystem(lang: Language, mode: Mode, project: ProjectContext | null, userInput: string): string {
  if (mode === "spec") return SPEC_SYSTEM_PROMPT(lang)
  return buildEnhanceSystem(lang, project, userInput)
}

const tui: TuiPlugin = async (api: TuiPluginApi, options?: PluginOptions) => {
  const languageSetting: LanguageSetting = options?.language ?? "auto"
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT
  const pollMs = options?.pollIntervalMs ?? DEFAULT_POLL
  const variant = options?.variant
  const overrideModel = options?.overrideModel
  const modeSetting: ModeSetting = options?.mode ?? "auto"
  const includeContext = options?.includeContext ?? true

  console.error("[prompt-optimizer] plugin loaded", {
    language: languageSetting,
    model: overrideModel ?? "(inherit)",
    variant: variant ?? "(none)",
    mode: modeSetting,
    includeContext,
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
      const language: Language = languageSetting === "auto" ? detectLanguage(raw) : languageSetting

      const project = includeContext ? gatherProjectContext(process.cwd()) : null
      const projectExists = project !== null
      const mode: Mode = modeSetting === "auto" ? detectMode(raw, projectExists) : modeSetting

      const system = buildSystem(language, mode, project, raw)
      const userText = mode === "enhance"
        ? raw
        : raw + "\n\n（请直接输出优化后的 prompt, 不要任何解释、标记或格式说明）"

      console.error("[prompt-optimizer] run", {
        mode,
        projectExists,
        docsBytes: project?.docs.length ?? 0,
      })

      const result = await tryOne(api, overrideModel, variant, system, userText, timeoutMs, pollMs)
      const resultPart = { type: "text" as const, text: result }
      ref.set({
        input: result,
        mode: "normal",
        parts: [resultPart],
      })
      ref.focus()
      api.ui.toast({
        variant: "success",
        message: mode === "enhance" ? TOAST.successEnhance : TOAST.successSpec,
      })
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

  // Build prompt body without inline `[{...}]` to avoid TSX parser confusion.
  const userPart: Record<string, unknown> = { type: "text", text: userText }
  const promptBody: Record<string, unknown> = {
    sessionID,
    system,
    parts: [userPart],
  }
  if (model) {
    const modelSpec: Record<string, string> = {
      providerID: model.providerID,
      modelID: model.modelID,
    }
    promptBody["model"] = modelSpec
  }
  if (variant) promptBody["variant"] = variant

  await api.client.session.prompt(promptBody as any)

  const optimized = await pollAssistantText(api, sessionID, timeoutMs, pollMs)
  if (!optimized) {
    throw new Error(Math.round(timeoutMs / 1000) + "s timeout")
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
    const messages = (resp.data ?? []) as Array<any>

    const assistant = messages.find((m) => m?.info?.role === "assistant")
    if (assistant?.info?.time?.completed) {
      const text = (assistant.parts ?? [])
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text as string)
        .join("")

      const cleaned = stripThinkBlocks(text)
      if (cleaned.length > 0) return cleaned
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }

  return undefined
}

const plugin: TuiPluginModule = {
  id: "opencode-prompt-optimizer",
  tui,
}

export default plugin
