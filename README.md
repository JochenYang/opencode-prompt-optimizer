<div align="center">

# opencode-prompt-optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-opencode-blueviolet.svg)]()

**[English](./README.en.md) | 中文**

OpenCode TUI 插件。点击输入框旁的 **✦** 按钮，把随手写的需求扩写成 LLM 能直接执行的工程任务。

</div>

---

## 效果

你在输入框写：

```
我想增加一个会话区 chat 框下面有 statusbar，显示当前模型和上下文占用
```

点击 ✦ 后，输入框被替换为：

```
[DRAFT] 基于现有前端栈（请先用 Read 工具查看侧边栏组件、会话区组件目录结构，
定位 Sidebar、ChatInput/MessageInput 等关键文件路径），按以下顺序交付：

1. 侧边栏插件导览
- 在 Sidebar 新增"插件"入口分组，从本地清单 plugins/manifest.json 读取可用
插件列表，渲染为可点击项。
- 点击触发 Modal/Drawer 弹出安装确认窗口，展示插件名、版本、描述、权限/依赖，
确认后调用 installPlugin 流程（写入已安装列表 + 持久化），并更新 UI 状态。
- 错误处理：清单加载失败、依赖缺失、用户取消分别走 toast/错误态。

2. 公共要求
- 严格遵循现有 TS/组件风格（无 any、props 显式类型），复用既有 design tokens。
- 错误以 actionable message 抛出，敏感信息不入日志。
- 为新增逻辑补充最小单元测试（StatusBar 渲染、install 流程成功/失败分支、清单解析）。
- 完成后运行项目 lint/typecheck/test，记录结果交付说明。

执行顺序：先定位文件 > 设计稿（控件/数据流）> Sidebar 入口与 Modal > StatusBar >
测试与验证。中间若需架构决策先暂停确认。
```

输出以 `[DRAFT]` 开头，自动引用了当前项目的真实文件（`Sidebar`、`ChatInput`、`plugins/manifest.json`），用户可以编辑后再发。

---

## 安装

### 从 npm（推荐）

```bash
opencode plugin opencode-prompt-optimizer
```

需要全局装的话加 `--global`：

```bash
opencode plugin opencode-prompt-optimizer --global
```

重启 OpenCode 生效。

### 本地文件（开发用）

在 `tui.json` 直接引用：

```jsonc
{
  "plugin": [
    "./plugins/prompt-optimizer.tsx"
  ]
}
```

构建产物 `dist/tui.js` 也可以直接引用。

### 卸载

1. 从 `tui.json` 的 `plugin` 数组删掉本插件项
2. 删 cache 目录：
   ```bash
   # Windows
   Remove-Item -Recurse "$env:USERPROFILE\.cache\opencode\packages\opencode-prompt-optimizer*"
   # Linux/macOS
   rm -rf ~/.cache/opencode/packages/opencode-prompt-optimizer*
   ```
3. 重启 OpenCode

---

## 配置

在 `tui.json` 的 plugin 元组第二项传 options：

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

### 可选项

| 选项              | 类型                                | 默认值       | 说明                                                                                                |
| ----------------- | ----------------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| `language`        | `"auto"` / `"en"` / `"zh"`             | `"auto"`     | 输出语言。`"auto"` 根据输入文本自动检测（中文 → zh，其它 → en）。                                       |
| `overrideModel`   | `{ providerID, modelID }`             | （继承）     | 强制使用指定模型。默认继承主 agent 的模型，不用配。                                                          |
| `variant`         | `string`                              | （无）       | 模型变体名（如 `"none"` 关掉 thinking）。Provider-specific，未注册时静默回退。                                  |
| `includeContext`  | `boolean`                             | `true`       | 是否读项目文件 + git 状态。关掉后只润色文本，不感知项目。                                                    |
| `timeoutMs`       | `number`                              | `90000`      | 单次优化最大等待时间（毫秒）。                                                                                |
| `pollIntervalMs`  | `number`                              | `800`        | 轮询 LLM 响应的间隔（毫秒）。                                                                                |

---

## 项目感知

v0.3.0 默认开启项目感知：每次点击 ✦ 自动读取当前项目信息并注入到 system prompt，包括：

- `package.json` 里的 name / description / dependencies
- 项目根目录下的 AI 工具规则文件（按优先级合并到 2KB 预算）：`AGENTS.md` / `CLAUDE.md` / `GEMINI.md` / `.cursorrules` / `.windsurfrules` / `CONVENTIONS.md` / `INSTRUCTIONS.md` / `.github/copilot-instructions.md` / `.continue/rules/*.md`
- Git 状态：当前分支 + 已修改文件（前 12 个，过滤 `node_modules/`）

context 在同一 CWD 5 分钟内复用，不重复扫。**plugin 只读这些固定文件，不递归扫描项目**。想完全关闭项目读取：设 `"includeContext": false`。

---

## 故障排查

| 现象                          | 排查                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------- |
| 点 ✦ 没反应                    | 检查 `tui.json` 的 `plugin` 数组是否包含本插件；`typecheck` 是否有 TS 报错。       |
| 优化结果是英文（输入是中文）  | 显式设 `"language": "zh"`（`"auto"` 检测失败时回退到 en）。                          |
| 主屏布局换行                   | 在 `tui.json` 顶部加 `"prompt": { "max_width": 80 }` 扩宽输入框。                 |
| 报 "Optimization failed"      | 多半是模型超时或 rate limit。调大 `timeoutMs` 或换 `overrideModel`。                |

---

## License

[MIT](./LICENSE)
