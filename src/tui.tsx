/** @jsxImportSource @opentui/solid */
import { createSignal, Show } from "solid-js"
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
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

const DEFAULT_TIMEOUT = 900_000
const DEFAULT_POLL = 200
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
  const DEBUG_FILE = "D:\\codes\\prompt-opt-debug.json"
  let attemptCount = 0

  while (Date.now() < deadline) {
    attemptCount++
    const elapsed = Date.now() - (deadline - timeoutMs)
    console.error(`[prompt-optimizer] poll attempt #${attemptCount} (elapsed ${elapsed}ms)`)

    try {
      // Use api.client.session.messages with { sessionID }
      const resp = await api.client.session.messages({ sessionID })
      console.error("[prompt-optimizer] resp type:", typeof resp)

      // Write full raw response to debug file
      try {
        writeFileSync(DEBUG_FILE, JSON.stringify(resp, null, 2), "utf-8")
        console.error("[prompt-optimizer] wrote raw response to", DEBUG_FILE)
      } catch (e) {
        console.error("[prompt-optimizer] debug file write failed:", String(e))
      }

      // Log resp top-level shape
      const respAny = resp as any
      console.error("[prompt-optimizer] resp keys:", Object.keys(respAny))
      if (respAny.data !== undefined) {
        const d = respAny.data
        console.error("[prompt-optimizer] resp.data type:", typeof d, Array.isArray(d) ? "Array" : "not Array")
        if (!Array.isArray(d) && typeof d === "object" && d !== null) {
          console.error("[prompt-optimizer] resp.data keys:", Object.keys(d))
          if (d.data !== undefined) {
            console.error("[prompt-optimizer] resp.data.data type:", typeof d.data, Array.isArray(d.data) ? "Array" : typeof d.data)
          }
        }
      }

      // --- Attempt all possible paths to find messages array ---
      const paths = [
        { label: "resp.data.data", val: respAny?.data?.data },
        { label: "resp.data", val: respAny?.data },
      ]

      let messages: unknown[] | undefined
      for (const p of paths) {
        if (Array.isArray(p.val)) {
          console.error(`[prompt-optimizer] ✅ messages array found at "${p.label}" length=${p.val.length}`)
          messages = p.val
          break
        }
        console.error(`[prompt-optimizer] ❌ "${p.label}" not an array:`, typeof p.val)
      }

      if (!messages) {
        console.error("[prompt-optimizer] no messages array yet, retrying...")
        await new Promise((r) => setTimeout(r, pollMs))
        continue
      }

      // Log every message in the array
      messages.forEach((m: any, i: number) => {
        console.error(`[prompt-optimizer] msg[${i}] id=${m.id} type=${m.type} role=${m.role} keys=${Object.keys(m).join(",")}`)
      })

      // Find the first completed assistant message
      for (const m of messages) {
        const mAny = m as any

        // Check all possible assistant role indicators
        const roleChecks = [
          { label: "m.type === 'assistant'", val: mAny.type === "assistant" },
          { label: "m.role === 'assistant'", val: mAny.role === "assistant" },
          { label: "m.info?.role === 'assistant'", val: mAny.info?.role === "assistant" },
        ]
        const isAssistant = roleChecks.some((c) => c.val)
        for (const c of roleChecks) {
          console.error(`[prompt-optimizer]   role check "${c.label}": ${c.val}`)
        }

        if (!isAssistant) {
          console.error("[prompt-optimizer]   skipping: not an assistant message")
          continue
        }

        // Check all possible time completed indicators
        const timeCompleted = mAny.time?.completed
        const infoTimeCompleted = mAny.info?.time?.completed
        const hasCompleted = !!(timeCompleted ?? infoTimeCompleted)
        console.error(`[prompt-optimizer]   time.completed=${timeCompleted} info.time.completed=${infoTimeCompleted} hasCompleted=${hasCompleted}`)

        if (!hasCompleted) {
          console.error("[prompt-optimizer]   skipping: not completed yet")
          continue
        }

        console.error(`[prompt-optimizer] ✅ found completed assistant message id=${mAny.id}`)

        // --- Extract text content: try all possible sources ---
        let text = ""

        // Source 1: m.content (array of { type: "text", text: string })
        if (Array.isArray(mAny.content)) {
          console.error(`[prompt-optimizer]   m.content array length=${mAny.content.length}`)
          for (const part of mAny.content) {
            console.error(`[prompt-optimizer]     content part:`, JSON.stringify(part))
            if (part?.type === "text" && typeof part?.text === "string") {
              text += part.text
            }
          }
          if (text) console.error(`[prompt-optimizer]   ✅ text from m.content, length=${text.length}`)
        } else {
          console.error(`[prompt-optimizer]   m.content not array:`, typeof mAny.content)
        }

        // Source 2: m.parts (array of { type: "text", text: string })
        if (!text && Array.isArray(mAny.parts)) {
          console.error(`[prompt-optimizer]   m.parts array length=${mAny.parts.length}`)
          for (const part of mAny.parts) {
            console.error(`[prompt-optimizer]     parts item:`, JSON.stringify(part))
            if (part?.type === "text" && typeof part?.text === "string") {
              text += part.text
            }
          }
          if (text) console.error(`[prompt-optimizer]   ✅ text from m.parts, length=${text.length}`)
        } else if (!text) {
          console.error(`[prompt-optimizer]   m.parts not array:`, typeof mAny.parts)
        }

        // Source 3: api.state.part(m.id) as fallback
        if (!text) {
          console.error(`[prompt-optimizer]   trying api.state.part(${mAny.id}) as fallback...`)
          try {
            const parts = api.state.part(mAny.id)
            console.error(`[prompt-optimizer]   api.state.part result:`, JSON.stringify(parts))
            if (Array.isArray(parts)) {
              for (const part of parts) {
                const p = part as any
                if (p?.type === "text" && typeof p?.text === "string") {
                  text += p.text
                }
              }
            }
            if (text) console.error(`[prompt-optimizer]   ✅ text from api.state.part, length=${text.length}`)
          } catch (e) {
            console.error(`[prompt-optimizer]   api.state.part error:`, String(e))
          }
        }

        const cleaned = stripThinkBlocks(text).trim()
        console.error(`[prompt-optimizer]   raw text length=${text.length} cleaned length=${cleaned.length}`)

        if (cleaned.length > 0) {
          // Write final result to debug file
          try {
            const resultPayload = { text: cleaned, id: mAny.id, sessionID }
            writeFileSync(
              DEBUG_FILE.replace(".json", "-result.json"),
              JSON.stringify(resultPayload, null, 2),
              "utf-8",
            )
          } catch { /* ignore */ }
          return cleaned
        }
      }

      console.error("[prompt-optimizer] no completed assistant with content yet, retrying...")
    } catch (err) {
      console.error("[prompt-optimizer] poll fetch error:", err instanceof Error ? err.message : String(err))
      console.error("[prompt-optimizer] full poll error:", err)
    }

    await new Promise((r) => setTimeout(r, pollMs))
  }

  console.error(`[prompt-optimizer] TIMEOUT after ${timeoutMs}ms`)
  return undefined
}

const plugin: TuiPluginModule = {
  id: "opencode-prompt-optimizer",
  tui,
}

export default plugin
