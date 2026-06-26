/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { existsSync, readFileSync, statSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiPromptRef } from "@opencode-ai/plugin/tui"

type ModelSpec = { providerID: string; modelID: string }
type Language = "en" | "zh"
type LanguageSetting = Language | "auto"

type PluginOptions = {
  overrideModel?: ModelSpec
  variant?: string
  language?: LanguageSetting
  timeoutMs?: number
  pollIntervalMs?: number
  includeContext?: boolean
}

const DEFAULT_TIMEOUT = 120_000
const DEFAULT_POLL = 500
const IDLE_ICON = "\u2727"
const CONTEXT_TTL_MS = 5 * 60 * 1000

const SPINNER_FRAMES = ["\u281B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u280F", "\u280F"]

const LANG: Record<Language, { hint: string }> = {
  en: { hint: "Output the optimized prompt in English. No explanation, no preamble, no think tags." },
  zh: { hint: "\u7528\u4E2D\u6587\u8F93\u51FA\u4F18\u5316\u540E\u7684 prompt. \u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3001\u524D\u7F00\u6216 think \u6807\u7B7E." },
}

const TOAST = {
  success: "Optimized (review before sending)",
  failedTitle: "Optimization failed",
  emptyInput: "Input is empty, nothing to optimize",
}

const detectLanguage = (text: string): Language => /[\u4e00-\u9fff]/.test(text) ? "zh" : "en"

const stripThinkBlocks = (s: string): string =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<\|begin\u258Cof\u258Cthinking\|>[\s\S]*?<\|end\u258Cof\u258Cthinking\|>/gi, "")
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
]

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

function readGitStatus(cwd: string): { branch: string; modifiedFiles: string[] } | null {
  try {
    const branch = execFileSync(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd, encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim()

    const statusOut = execFileSync(
      "git",
      ["status", "--porcelain"],
      { cwd, encoding: "utf-8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    )

    const modifiedFiles: string[] = []
    for (const line of statusOut.split(/\r?\n/)) {
      if (!line) continue
      const path = line.slice(3).trim().split(" -> ").pop() ?? ""
      if (path && !path.startsWith("node_modules/")) modifiedFiles.push(path)
      if (modifiedFiles.length >= 12) break
    }

    return { branch, modifiedFiles }
  } catch {
    return null
  }
}

type ProjectContext = {
  name: string
  description: string
  stack: string
  docs: string
  git: string
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

  let git = ""
  const gitInfo = readGitStatus(cwd)
  if (gitInfo) {
    git = "\n[GIT STATE]\n"
    git += "- Branch: " + gitInfo.branch + "\n"
    if (gitInfo.modifiedFiles.length > 0) {
      git += "- Modified:\n"
      for (const f of gitInfo.modifiedFiles) {
        git += "  - " + f + "\n"
      }
    }
  }

  return { name, description, stack, docs: docs.trim(), git: git.trim() }
}

const contextCache = new Map<string, { at: number; ctx: ProjectContext | null }>()

function getCachedContext(cwd: string): ProjectContext | null {
  const hit = contextCache.get(cwd)
  if (hit && Date.now() - hit.at < CONTEXT_TTL_MS) return hit.ctx
  const ctx = gatherProjectContext(cwd)
  contextCache.set(cwd, { at: Date.now(), ctx })
  return ctx
}

function buildSystem(lang: Language, project: ProjectContext | null, userInput: string): string {
  const ctx = project
    ? [
        "[WORKSPACE]",
        "- Project: " + project.name + (project.description ? " - " + project.description : ""),
        "- Stack: " + (project.stack || "(unknown)"),
        "- CWD: " + process.cwd(),
        project.docs ? "\n[PROJECT CONVENTIONS]\n" + project.docs : "",
        project.git ? "\n" + project.git : "",
      ].join("\n")
    : "[WORKSPACE: no project context (no package.json in cwd)]"

  return (
    "You are a project-aware prompt rewriter. Output is a DRAFT that the user will review and edit before sending to the main agent.\n\n" +
    ctx + "\n\n" +
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

const tui: TuiPlugin = async (api: TuiPluginApi, options?: PluginOptions) => {
  const languageSetting: LanguageSetting = options?.language ?? "auto"
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT
  const pollMs = options?.pollIntervalMs ?? DEFAULT_POLL
  const variant = options?.variant
  const overrideModel = options?.overrideModel
  const includeContext = options?.includeContext ?? true

  console.error("[prompt-optimizer] plugin loaded", {
    language: languageSetting,
    model: overrideModel ?? "(inherit)",
    variant: variant ?? "(none)",
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
      const project = includeContext ? getCachedContext(process.cwd()) : null
      const system = buildSystem(language, project, raw)
      const userText = raw + "\n\n\uff08\u8BF7\u76F4\u63A5\u8F93\u51FA\u4F18\u5316\u540E\u7684 prompt, \u4E0D\u8981\u4EFB\u4F55\u89E3\u91CA\u3001\u6807\u8BB0\u6216\u683C\u5F0F\u8BF4\u660E\uff09"

      console.error("[prompt-optimizer] run", {
        projectExists: project !== null,
        docsBytes: project?.docs.length ?? 0,
        gitBytes: project?.git.length ?? 0,
      })

      const result = await tryOne(api, overrideModel, variant, system, userText, timeoutMs, pollMs)
      const resultPart = { type: "text" as const, text: result }
      ref.set({
        input: result,
        mode: "normal",
        parts: [resultPart],
      })
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

  const userPart: Record<string, unknown> = { type: "text", text: userText }
  const promptBody: Record<string, unknown> = {
    sessionID,
    system,
    parts: [userPart],
    tools: {},
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

  try {
    const optimized = await pollAssistantText(api, sessionID, timeoutMs, pollMs)
    if (!optimized) {
      throw new Error(Math.round(timeoutMs / 1000) + "s timeout")
    }
    return optimized
  } finally {
    await api.client.session.delete({ sessionID }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error("[prompt-optimizer] cleanup failed:", msg)
    })
  }
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
    const messages = (resp as any)?.data?.data as Array<any> | undefined
    if (!messages) {
      await new Promise((r) => setTimeout(r, pollMs))
      continue
    }

    for (const m of messages) {
      if (m?.info?.role !== "assistant") continue
      if (!m?.info?.time?.completed) continue

      const text = (m.parts ?? [])
        .filter((p: any) => p?.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text)
        .join("")

      if (text.length > 0) return text
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
