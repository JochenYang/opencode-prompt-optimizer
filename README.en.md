<div align="center">

# opencode-prompt-optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.3-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-opencode-blueviolet.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6.svg?logo=typescript&logoColor=white)]()

**English | [中文](./README.md)**

A OpenCode TUI plugin that adds a **✦ one-click optimize button** next to the prompt input. Click it, and your brief request is expanded into a directly-executable task specification the LLM can act on immediately.

</div>

---

## Before / After

You type:

```
I want to build a hiking landing page
```

After clicking ✦, the input is replaced with:

```
Please build a landing page for a hiking event. The page should include:

[CORE MODULES] Event info section (date/location/difficulty/cost), gear checklist,
registration form, photo gallery, FAQ
[DESIGN STYLE] Outdoor / natural aesthetic, primary color: forest green + warm orange,
emphasize immersive imagery
[RESPONSIVE] Desktop + mobile adaptive layout
[TECH STACK] Single HTML file + Tailwind CSS (no framework), double-click to open
[DELIVERABLES] Chinese copy, replaceable image placeholders, brief README
```

Direct task spec — the agent immediately knows what to build.

---

## Install

### From npm (recommended)

```bash
opencode plugin opencode-prompt-optimizer
```

This will:

1. Install the npm package into OpenCode's internal cache
2. Automatically append `"opencode-prompt-optimizer"` to the `plugin` array in your `tui.json`

Restart OpenCode and you're good to go.

> To install globally (`~/.config/opencode/tui.json`) instead of the current project, add `--global`:
>
> ```bash
> opencode plugin opencode-prompt-optimizer --global
> ```

### Local file (development)

Reference a local path or built dist directly in `tui.json`:

```jsonc
{
  "plugin": [
    "./plugins/prompt-optimizer.tsx",   // source (bun auto-loads)
    // or
    "./plugins/prompt-optimizer.js"    // build artifact
  ]
}
```

### Uninstall

> ⚠️ opencode CLI does **not** provide a `plugin remove` / `plugin uninstall` subcommand. Manual steps:

**1. Remove the plugin entry from `tui.json`**:

```bash
# Global install
$ notepad ~/.config/opencode/tui.json
# Project-level install
$ notepad <project>/.opencode/tui.json
```

Delete `"opencode-prompt-optimizer"` from the `"plugin"` array.

**2. Delete the cache directory**:

```bash
# Windows
$ Remove-Item -Recurse "$env:USERPROFILE\.cache\opencode\packages\opencode-prompt-optimizer*"
# Linux/macOS
$ rm -rf ~/.cache/opencode/packages/opencode-prompt-optimizer*
```

**3. Restart opencode.**

---

## Configuration

Pass options to the plugin in `tui.json` (the second item in the array is the options object):

```jsonc
{
  "plugin": [
    [
      "opencode-prompt-optimizer",
      {
        "language": "auto",
        "timeoutMs": 90000
      }
    ]
  ]
}
```

### Options

| Option           | Type                       | Default     | Description                                                                                                            |
| ---------------- | -------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `language`       | `"auto"\|"en"\|"zh"`        | `"auto"`    | UI + LLM output language. `"auto"` auto-detects from input (CJK → zh, otherwise → en).                                  |
| `overrideModel`  | `{ providerID, modelID }`  | (inherit)   | Force a specific model. **By default inherits from the primary agent's model** — no config needed.                     |
| `variant`        | `string`                   | (none)      | Model variant (e.g. `"non-thinking"` for some providers). Provider-specific.                                           |
| `timeoutMs`      | `number`                   | `90000`     | Max wait time per optimization call (milliseconds).                                                                    |
| `pollIntervalMs` | `number`                   | `800`       | How often to poll the LLM response (milliseconds).                                                                      |

---

## Design Philosophy

This plugin is **not** a "plan mode" — it does NOT output structured meta-prompts (`## Task / ## Goal / ## Input`) for the LLM to think about again. It directly outputs a **directly-executable task spec** the LLM can act on immediately.

Three things it does:

1. **Statement → imperative**: "I want to build X" → "Please build X"
2. **Specify sub-type**: vague description → concrete type (landing page / API endpoint / CLI tool / ...)
3. **Add 3-5 key elements**: core modules, design style, tech stack, responsive, deliverables

Output is capped at **300 words** to avoid prompt bloat.

---

## How It Works

```
[User clicks ✦]
    ↓
Read current input text
    ↓
Detect language (auto CJK detection) → switch system prompt hint
    ↓
Spawn a one-shot session using the primary agent's model
    ↓
Poll the assistant response (90s default timeout)
    ↓
Strip <think> / <thinking> blocks
    ↓
Replace input text
```

**Model source**: by default, the plugin does **NOT** pass the `model` field — the primary agent decides. If your primary agent is configured with a specific model (e.g. `minimax-国内` / `deepseek-v4-flash-free`), that's what gets used.

---

## Development

```bash
# Install deps
bun install

# Build (outputs dist/tui.js)
bun run build

# Watch mode (auto-rebuild)
bun run dev

# Typecheck
bun run typecheck
```

The build artifact is loaded directly by OpenCode (see "Local file" install above).

---

## Troubleshooting

| Symptom                            | Fix                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| ✦ click does nothing               | Check that `tui.json` `plugin` array includes this plugin; run `typecheck` for TS errors.         |
| Output is English when input is CN | Set `"language": "zh"` explicitly (auto mode falls back to en on detection failure).              |
| Home page wraps the icon           | Add `"prompt": { "max_width": 80 }` at the top of `tui.json` to widen the prompt.                |
| "Optimization failed" toast        | Usually timeout or rate limit. Bump `timeoutMs` or switch `overrideModel`.                        |

---

## License

[MIT](./LICENSE)
