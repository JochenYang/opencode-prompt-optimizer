<div align="center">

# opencode-prompt-optimizer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.3-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-opencode-blueviolet.svg)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6.svg?logo=typescript&logoColor=white)]()

**[English](./README.en.md) | 中文**

一个 OpenCode TUI 插件，在输入框旁边加一个 **✦ 一键优化按钮**。点一下，你随手写的需求就被扩写成 LLM 能直接执行的完整任务说明。

</div>

---

## 效果对比

你在输入框写：

```
我想开发一个徒步落地页
```

点击 ✦ 之后，输入框被替换成：

```
请帮我开发一个徒步旅行活动的落地页面（landing page）。该落地页需要包含以下内容：

【核心模块】活动信息展示区（时间/地点/难度/费用）、装备清单、报名表单、相册、FAQ
【设计风格】户外自然风，主色调森林绿 + 暖橙，强调图片沉浸感
【响应式】桌面端 + 移动端自适应
【技术栈】单页 HTML + Tailwind CSS（无需框架），可直接双击打开
【可交付】含中文文案、可替换的图片占位符、README 简要说明
```

直接可执行 —— Agent 拿到就能开干。

---

## 安装

### 从 npm 安装（推荐）

```bash
opencode plugin opencode-prompt-optimizer
```

这会做两件事：

1. 把 npm 包安装到 OpenCode 的内部缓存目录
2. 自动在你的 `tui.json` 的 `plugin` 数组里追加 `"opencode-prompt-optimizer"`

重启 OpenCode 即可生效。

> 想装到全局（`~/.config/opencode/tui.json`）而不是当前项目，加 `--global`：
>
> ```bash
> opencode plugin opencode-prompt-optimizer --global
> ```

### 本地文件（开发用）

在 `tui.json` 里直接引用本地路径或 dist：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/prompt-optimizer.tsx",   // 源码（自动 bun 加载）
    // 或
    "./plugins/prompt-optimizer.js"    // 构建产物
  ]
}
```

### 卸载

> ⚠️ opencode CLI **目前不提供** `plugin remove` / `plugin uninstall` 子命令。需要手卸载：

**1. 从 tui.json 删 plugin 项**：

```bash
# 全局安装
$ notepad ~/.config/opencode/tui.json
# 项目级安装
$ notepad <project>/.opencode/tui.json
```

把 `"plugin": ["opencode-prompt-optimizer", ...]` 里的 `"opencode-prompt-optimizer"` 删掉。

**2. 删 cache 目录**：

```bash
# Windows
$ Remove-Item -Recurse "$env:USERPROFILE\.cache\opencode\packages\opencode-prompt-optimizer*"
# Linux/macOS
$ rm -rf ~/.cache/opencode/packages/opencode-prompt-optimizer*
```

**3. 重启 opencode 生效**。

---

## 配置

在 `tui.json` 里给插件传选项（数组的第二项是 options）：

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

### 可选项

| 选项              | 类型            | 默认值      | 说明                                                                       |
| ----------------- | --------------- | ----------- | -------------------------------------------------------------------------- |
| `language`        | `"auto"\|"en"\|"zh"` | `"auto"`    | UI 文案 + 优化输出语言。`"auto"` 会自动从输入文本检测（中文 → zh，其它 → en）。 |
| `overrideModel`   | `{ providerID, modelID }` | （继承）    | 强制使用指定模型。**默认继承主 agent 的模型** —— 不用配。                       |
| `variant`         | `string`        | （无）      | 模型变体（如部分 provider 的 `"non-thinking"`）。Provider-specific。          |
| `timeoutMs`       | `number`        | `90000`     | 每次优化调用的最大等待时间（毫秒）。                                          |
| `pollIntervalMs`  | `number`        | `800`       | 轮询 LLM 响应的间隔（毫秒）。                                                  |

---

## 设计理念

这个插件**不是** "plan mode" —— 它不会输出 `## Task / ## Goal / ## Input` 这种结构化元提示让 LLM 再去思考一遍。它直接输出**可执行的任务说明**，LLM 拿到就能开干。

具体做了三件事：

1. **陈述句 → 祈使句**："我想开发 X" → "请帮我开发 X"
2. **明确子类型**：模糊描述 → 具体类型（landing page / API endpoint / CLI tool / ...）
3. **补 3-5 个关键元素**：核心模块、设计风格、技术栈、响应式、可交付物

输出控制在 **300 字以内**，避免 prompt 膨胀。

---

## 工作流程

```
[用户点击 ✦]
    ↓
读取输入框当前文本
    ↓
判断语言（CJK 自动检测）→ 切换 system prompt 提示
    ↓
用主 agent 的 model 跑一个一次性 session
    ↓
轮询 assistant 响应（默认 90s）
    ↓
剥掉 <think> / <thinking> 块
    ↓
替换输入框文本
```

**模型来源**：默认**不传** `model` 字段，由主 agent 决定。如果主 agent 配的是 `minimax-国内` 的某个模型，就用那个。

---

## 开发

```bash
# 安装依赖
bun install

# 构建（输出 dist/tui.js）
bun run build

# 监听模式（自动重建）
bun run dev

# 类型检查
bun run typecheck
```

构建产物直接给 OpenCode 加载（见上文"本地文件安装"）。

---

## 故障排查

| 现象                          | 排查                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------- |
| 点 ✦ 没反应                    | 检查 `tui.json` 的 `plugin` 数组是否包含本插件；`typecheck` 是否有 TS 报错。   |
| 优化结果是英文（输入是中文）  | 显式设 `"language": "zh"`（`"auto"` 模式检测失败时回退到 en）。                  |
| 主屏布局换行                   | 在 `tui.json` 顶部加 `"prompt": { "max_width": 80 }` 扩宽输入框。             |
| 报 "Optimization failed"      | 多半是模型超时或 rate limit。调大 `timeoutMs` 或换 `overrideModel`。            |

---

## License

MIT
