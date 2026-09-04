# Subtitle Navigator for IINA

A standalone subtitle navigation and learning tool for **IINA** on macOS.  
Designed for language learners who want **precise subtitle browsing, jumping, looping, and copying**.

一个基于 **IINA（macOS）** 的 **独立窗口字幕浏览与学习插件**，专为语言学习场景设计，支持精确跳转、循环、搜索和复制字幕。

---

## ⚠️ Project Status / 项目说明（请先阅读）

### English
This project was created using **GPT-5.2 vibe coding** as an exploratory and practical experiment.

- The code works and is actively used by the author.
- **There is no guarantee of long-term maintenance.**
- This repository is provided **as-is**.
- You are **strongly encouraged to fork, modify, and customize** it for your own needs.

This project is intended to be:
- A **useful reference implementation**
- A **starting point** for your own IINA subtitle tools
- A practical example of what GPT-assisted development can produce

### 中文
本项目是一个基于 **GPT-5.2 vibe coding** 完成的实验性 / 实用性项目。

- 插件功能完整，可正常使用
- **不承诺长期维护**
- 本仓库以 **“现状提供（as-is）”**
- **非常欢迎 Fork、本地修改、二次定制**

本项目的定位是：
- 一个**可直接使用的工具**
- 一个**IINA 插件开发参考实现**
- 一个 **GPT 辅助开发的真实示例**

---

## ✨ Features | 功能特性

### Core Features | 核心功能
- **Standalone Window** (not sidebar)  
  独立窗口显示，不占用 IINA 侧边栏空间
- **Select subtitle track** (external subtitles)  
  选择外挂字幕轨（`.srt`）
- **Robust SRT parsing**
  - Supports `,` and `.` millisecond formats  
  - Handles irregular spacing and BOM  
  - Removes style tags like `{...}`
- **Filter non-dialog overlays**  
  Automatically removes top-of-screen annotation subtitles  
  （如 `{\an7}`, `{\an8}`, `{\an9}`）

---

### Navigation & Learning | 跳转与学习
- **Clickable subtitle list**  
  点击字幕即可跳转
- **Jump to time (hh:mm:ss)**  
  适配数小时长视频（支持上下调节输入）
- **Scroll to current subtitle**  
  滚动到当前播放行
- **Loop current line**  
  单句循环，适合听力与跟读
- **Search subtitles**
- **Multi-select & copy**

---

### Editing | 字幕编辑
- **Right-click a line for a context menu**: edit, jump, loop, copy  
  右键点击字幕行弹出菜单：编辑、跳转、循环、复制
- While editing, `Enter` commits, `Shift+Enter` adds a newline, `Escape` cancels  
  编辑时 `Enter` 确认，`Shift+Enter` 换行，`Escape` 取消
- `Cmd+Enter` edits the line playing right now  
  `Cmd+Enter` 直接编辑当前播放行
- **Saving is invisible.** There is no dirty marker and no Save step: an edit is
  written to the `.srt` shortly after you stop typing, and the subtitle track
  reloads so the fix shows up in playback  
  无需手动保存，也没有“未保存”状态：停止输入后自动写回 `.srt` 并重载字幕轨
- A run of edits batches into **one** write and **one** reload  
  连续编辑会合并为一次写入与一次重载
- **If a save fails, the line reverts** to what the file actually contains, and the
  discarded text is shown so you can type it back in — the list never claims an
  edit the `.srt` does not have  
  保存失败时该行会回退到文件中的实际内容，并显示被放弃的文本
- **A backup is made before the first write**: `yourfile.srt` → `yourfile.srt.bak`,
  and it keeps the pristine original even across sessions  
  首次写入前会自动备份为 `yourfile.srt.bak`，且始终保留最初的原始版本
- Writes are **atomic** — the file is replaced by rename, never truncated in place  
  写入是原子的：通过重命名替换文件，不会就地截断

Only the lines you actually edit are rewritten. Everything else in the file —
cue numbering, timestamp formatting, style tags, and any cues the parser skips —
is preserved exactly as it was.

只有被编辑的行会被改写，文件中的其他内容（序号、时间戳格式、样式标签等）保持原样。

> Editing a line that contained `{...}` style tags drops those tags from that line,
> because the editor works on the cleaned text the list displays.

---

### Timing Accuracy | 时间精准度
- Automatically compensates **mpv `sub-delay`**  
  字幕列表、跳转、循环与屏幕字幕同步
- Optimized for **long videos (hours+)**

---

## 📦 Installation | 安装方式

### Requirements | 运行要求
- macOS
- **IINA ≥ 1.4**
- mpv ≥ 0.38
- External subtitles (`.srt`)

### Install Plugin | 安装插件
1. Download the latest `.iinaplgz` from **Releases**
2. Open IINA → **Plugins** → **Install Plugin…**
3. Enable the plugin

插件启用后会**自动打开独立窗口**。

### Build from source | 从源码构建

```bash
./scripts/build-plugin.sh          # release build -> dist/
./scripts/build-plugin.sh --dev    # dev build, installs alongside the release
```

The `--dev` build gets its own plugin identifier, name and menu shortcut
(`Cmd+Shift+D`), so IINA treats it as a separate plugin and you can enable it
next to the released one to compare the two.

`--dev` 构建使用独立的标识符、名称与快捷键，可与正式版同时启用，方便对比。

---

## 🚀 Usage | 使用说明

### Demo | 演示视频

https://github.com/user-attachments/assets/59d68ece-2736-4c01-a10f-d4906d04145e

### Reopen the window | 重新打开窗口
If you close the window:

- **Menu**: `IINA → Plugins → Show Subtitle Navigator`
- **Shortcut**: `Cmd + Shift + S`

---

### Typical Language Learning Workflow | 典型学习流程
1. Load a video with subtitles
2. Open Subtitle Navigator
3. Search unfamiliar lines
4. Jump → loop → repeat
5. Right-click → **Edit text** to fix any mis-transcribed line; it saves itself
6. Copy useful sentences to notes / Anki

---

## 🧠 Design Philosophy | 设计理念

- Treat subtitles as **learning material**
- Prefer **robustness and accuracy** over visual complexity
- Avoid IINA sidebar limitations

这是一个**字幕学习工具**，而不是单纯的字幕显示插件。

---

## 🛠 Customization & Forking | 定制与二次开发

You are encouraged to:
- Fork this repository
- Modify UI / parsing / timing logic
- Adapt it to your personal workflow

欢迎基于本项目进行：
- UI 改造
- 支持更多字幕格式
- 更复杂的语言学习功能

---

## ⚠️ Limitations | 已知限制
- Only `.srt` supported
- Embedded subtitles not parsed as text
- Single subtitle track by design
- Editing changes subtitle **text** only — timestamps are not editable
- Saving normalizes CRLF line endings to LF
- Edits are written without confirmation; the `.srt.bak` backup is the undo of
  last resort, and it holds the original file rather than the previous save

---

## 📄 License | 许可证

MIT License

---

## 🙏 Acknowledgements | 致谢
- IINA team
- mpv project
- GPT-5.2
- Language learners who want better subtitle tools
