---
name: DSH 任务派发
description: 沿用 DSH 原生风格的中文本机任务调度面板
colors:
  background: "#fff"
  panel: "#f5f6f8"
  text: "#242833"
  muted: "#555e70"
  border: "#d9dde5"
  blue: "#205abe"
  selected: "#edf3ff"
  text-selection: "#c9dcff"
  success: "#206044"
  uncertainty: "#865800"
  failure: "#a52736"
  notice-background: "#fff4dc"
  notice-text: "#714d00"
  dark-background: "#1c1e23"
  dark-panel: "#252830"
  dark-text: "#eaedf3"
  dark-muted: "#b0b8c8"
  dark-border: "#424752"
  dark-blue: "#8eb5ff"
  dark-primary-text: "#142542"
  dark-selected: "#263851"
  dark-success: "#8bd6ad"
  dark-uncertainty: "#e4bd72"
  dark-failure: "#ff9eaa"
  dark-notice-background: "#40331e"
  dark-notice-text: "#f0d29c"
typography:
  headline:
    fontFamily: "system-ui, sans-serif"
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.55
  secondary:
    fontFamily: "system-ui, sans-serif"
    fontSize: "13px"
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
  output:
    fontFamily: "ui-monospace, monospace"
    fontSize: "13px"
    lineHeight: 1.6
rounded:
  control: "6px"
  row: "0px"
spacing:
  compact: "8px"
  field: "12px"
  item: "16px"
  section: "24px"
  columns: "32px"
components:
  button:
    backgroundColor: "{colors.background}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  button-primary:
    backgroundColor: "{colors.blue}"
    textColor: "{colors.background}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
  task-selected:
    backgroundColor: "{colors.selected}"
    rounded: "{rounded.row}"
    padding: "14px 12px"
  empty:
    backgroundColor: "{colors.panel}"
    padding: "36px 24px"
---

# Design System: DSH 任务派发

## Overview

已确认方向：沿用 DSH 原生风格。以系统字体、中性底色、蓝色选择和明确的中文状态表达本机调度过程。界面保持操作面板的密度，让执行顺位、控制归属与验收状态容易辨认。

**Key Characteristics:**
- 中文优先，状态同时使用文字和颜色。
- 平面分区，以留白和细分隔线建立层级。
- 继承宿主的原生操作感，支持系统深浅色偏好。

## Colors

### Primary
蓝色用于主按钮、链接、焦点环和输入光标。队列选中背景使用较浅的蓝色，文字选择另有浅蓝背景。深色模式通过面板局部 CSS 变量切换主题。

### Neutral
白色主面板与浅灰辅助底色承载内容；正文、次要文字和边界各有独立角色。深色模式使用深灰底色、浅色文字和更亮的边界。

状态色是语义辅助：执行中、待验收、已验收使用绿色；等待输入、状态待核对、人工接管、会话忙碌使用琥珀色；执行失败、无可用执行器使用红色。其余状态保留次要文字色。告警条使用独立的琥珀背景和文字组合。

## Typography

系统无衬线字体用于界面，等宽字体用于结果文本和配置。主标题采用 headline，分区标题采用 title；三级标题与正文同为（14px），通过字重和上下间距区分。次要说明使用 secondary，状态与开关标签使用 label。正文段落最大宽度（72ch）。顺位与计数使用等宽数字。

## Layout

根容器最大宽度（1500px），居中，默认内边距（28px）。标题与操作横向排列，底部细线及上下间距分隔内容。主区左侧为执行优先级与本地任务，右侧为队列及选中任务详情；列宽为 `minmax(280px,340px) minmax(0,1fr)`，列间距采用 columns。

视口宽度不超过（760px）时改为单列，根内边距（18px），列间距（28px）；标题操作区与告警条纵向排列，队列行内容顶部对齐。操作组可换行。长任务标题、代码和结果允许换行，结果区最高（340px）并内部滚动。

## Elevation & Depth

当前实现没有阴影。以背景色、边界和留白区分层级；告警、选中行、结果与空状态通过底色获得辨识度。

## Shapes

按钮、输入框、下拉框与文本域采用 control 圆角及（1px）边界。队列是全宽平直行，取消外框，只保留下边线。空状态和结果区保持平面矩形。

## Components

Agent identities pair a bundled Lobe Icons brand mark with the visible executor name. Priority rows use 24px marks and execution records use 20px marks; all reserve fixed space and are hidden from accessibility APIs because the adjacent name supplies the label. DSH uses the DeepSeek mark in the existing blue accent, Codex inherits text color, and Claude uses `#ad502d` in light mode / `#e8a082` in dark mode. Unknown adapter types use a neutral terminal SVG. Attribution and license live beside the source assets.

### Buttons
常规按钮最小高度（36px），悬停使用 panel 底色。主按钮使用蓝色背景和同色边界；其悬停仍保持蓝色，深色模式使用专门的深色文字。禁用态透明度（0.5），光标为不可用。所有可聚焦元素的键盘焦点使用（2px）蓝色外轮廓，偏移（3px）。仅在用户未请求减少动态时，按钮背景以（0.12s ease-out）过渡。

### Inputs / Fields
控件继承正文排版与颜色，内边距与常规按钮一致。表单字段全宽，标签位于上方；文本域可纵向缩放。配置文本域采用等宽字体。输入光标为蓝色；浏览器原生 required 行为承担必填校验，应用错误显示在告警条中。

### Navigation
队列按钮承担任务选择，标题在左、状态在右，间距（16px）。选中态使用 selected 背景。执行器列表显示数字顺位、执行器说明、启用开关及上下移按钮；拖动与按钮两种方式调整顺序，修改后出现保存与撤销操作。

### Containers / Status
空状态用浅灰底色、居中说明和配置入口。详情以顶部边界分隔，执行记录以行边界区分；告警使用 `role="alert"`。状态必须保留中文标签，颜色不替代文字。结果区使用等宽预格式文本；历史区使用原生可展开摘要。

## Do's and Don'ts

### Do:
- **Do** 沿用 DSH 原生风格和中文操作文案。
- **Do** 用文字同时表达状态、控制归属和禁用原因的上下文。
- **Do** 保留键盘焦点、上下移按钮、窄屏单列和减少动态偏好。
- **Do** 将源代码 `src/ui/style.css` 与 `src/ui/panel.jsx` 作为实现事实来源，变更后同步本档案。

### Don't:
- **Don't** 为调度面板另建品牌视觉或装饰性阴影。
- **Don't** 用颜色取代状态文字。
- **Don't** 把执行完成与人工验收混为一个状态。
