<div align="center">

# opencode-prompt-optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-opencode-blueviolet.svg)]()

**[English] | [中文](./README.md)**

OpenCode TUI plugin. Click the **✦** button next to the input box to expand a brief request into an engineering task the LLM can execute directly.

</div>

---

## Demo

You type:

```
Add a status bar under the chat panel showing current model and session context usage.
```

Click ✦. The input is replaced with:

```
[DRAFT] Based on the existing frontend stack (first use Read to inspect the sidebar
components and chat panel directory structure, locate Sidebar, ChatInput/MessageInput
and other key file paths), deliver in this order:

1. Sidebar plugin entry
- Add a "Plugins" group in the Sidebar, read from local manifest plugins/manifest.json
and render each item as a clickable row.
- Click triggers a Modal/Drawer that shows the plugin name, version, description,
permissions, and dependencies. On confirm, call the installPlugin flow (persist the
installed list) and update UI state.
- Error handling: manifest load failure, missing dependency, user cancel each map
to a distinct toast/error state.

2. Shared requirements
- Strictly follow existing TS/component style (no any, explicit prop types), reuse
existing design tokens.
- Errors are actionable, no sensitive data in logs.
- Add minimal unit tests (StatusBar render, install flow success/failure, manifest
parsing).
- After implementation, run lint/typecheck/test and record results in a delivery note.

Execution order: locate files > design (component/data flow) > Sidebar entry + Modal >
StatusBar > test + verify. Pause for confirmation on any architecture decision.
```

Output starts with `[DRAFT]` and references real files in the current project (`Sidebar`, `ChatInput`, `plugins/manifest.json`). Edit before sending.

---

## Install

### From npm (recommended)

```bash
opencode plugin opencode-prompt-optimizer
```

For a global install, add `--global`:

```bash
opencode plugin opencode-prompt-optimizer --global
```

Restart OpenCode to take effect.

### Local file (for development)

Reference directly in `tui.json`:

```jsonc
{
  "plugin": [
    "./plugins/prompt-optimizer.tsx"
  ]
}
```

The built artifact `dist/tui.js` can be referenced the same way.

### Uninstall

1. Remove the entry from the `plugin` array in `tui.json`
2. Delete the cache directory:
   ```bash
   # Windows
   Remove-Item -Recurse "$env:USERPROFILE\.cache\opencode\packages\opencode-prompt-optimizer*"
   # Linux/macOS
   rm -rf ~/.cache/opencode/packages/opencode-prompt-optimizer*
   ```
3. Restart OpenCode

---

## Configuration

Pass options as the second item in the plugin tuple in `tui.json`:

```jsonc
{
  "plugin": [
    [
      "opencode-prompt-optimizer",
      { "variant": "none" }
    ]
  ]
}
```

### Options

| Option           | Type                              | Default     | Description                                                                                                            |
| ---------------- | --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `language`       | `"auto"` / `"en"` / `"zh"`           | `"auto"`    | Output language. `"auto"` auto-detects from input (CJK → zh, otherwise → en).                                              |
| `overrideModel`  | `{ providerID, modelID }`           | (inherit)   | Force a specific model. Defaults to the primary agent's model — usually no need to set.                                       |
| `variant`        | `string`                            | (none)      | Model variant name (e.g. `"none"` to disable thinking). Provider-specific; silently ignored if the provider doesn't register it. |
| `includeContext` | `boolean`                           | `true`      | Whether to read project files + git state. Disable to polish text without project awareness.                                |
| `timeoutMs`      | `number`                            | `90000`     | Maximum wait time per optimization call (ms).                                                                              |
| `pollIntervalMs` | `number`                            | `800`       | Interval to poll the LLM response (ms).                                                                                   |

---

## Project Awareness

v0.3.0 enables project awareness by default. Every ✦ click reads the current project and injects it into the system prompt, including:

- `package.json` name / description / dependencies
- AI tool rule docs at the project root (merged under a 2KB budget, by priority): `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursorrules` / `.windsurfrules` / `CONVENTIONS.md` / `INSTRUCTIONS.md` / `.github/copilot-instructions.md` / `.continue/rules/*.md`
- Git state: current branch + modified files (first 12, `node_modules/` filtered)

Context is cached per CWD for 5 minutes — no re-scan. **The plugin only reads these fixed files; it never recursively scans the project.** To disable project reading entirely, set `"includeContext": false`.

---

## Troubleshooting

| Symptom                              | Fix                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| ✦ click does nothing                  | Check that `tui.json`'s `plugin` array includes this plugin; run `typecheck` for TS errors.            |
| Output is English when input is CN  | Set `"language": "zh"` explicitly (`"auto"` falls back to en on detection failure).                       |
| Home page wraps the icon             | Add `"prompt": { "max_width": 80 }` at the top of `tui.json` to widen the input.                          |
| "Optimization failed" toast          | Usually a model timeout or rate limit. Increase `timeoutMs` or switch `overrideModel`.                  |

---

## License

[MIT](./LICENSE)
