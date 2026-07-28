# P0/P1 改造方案

> 基于 docs/competitor-research-writingwithai.md 的调研结论。
> 每项给出：问题、现状（源码定位）、方案、涉及文件、风险。

---

## P0-1（修正）：续写/大纲写作前文上下文无上限，长篇 context bloat

### 问题

`AiAssistPanel.tsx` 的 `useOutlineContext`（第 83-108 行）为续写（continue）和大纲写作（outline-write）加载**全部** settingDocs 与**全部**前文章节，无裁剪、无上限。长篇（数十章）下 context 超出模型窗口或稀释聚焦。

与 osiworx 的"冷上下文写新章不丢连接"构成真实差距：不是"不注入"，而是"全量注入无裁剪"。

### 现状

- `AiAssistPanel.tsx:62-119`：`useOutlineContext` 加载全部 settingDocs（for-of settingDocs，无上限）和全部前文章节（for-of chapters，断在"当前章之前"但无上限）。
- `AiAssistPanel.tsx:229-247`：buildMessages 的 continue 分支把 settings、outline、prevChapters 全量拼进 user message。
- 对比：`Consistency.tsx` 有 MAX_CHAPTERS=12 和 CONTEXT_BUDGET 字数检查，但续写/大纲没有。

### 方案

**方案 A（轻量，推荐先做）：加字数上限 + 前文尾截断**

- 给 `useOutlineContext` 加总字数上限（如 8000-12000 字），超出时：settings 截断到等分、prevChapters 倒序取最近 N 章摘要。
- 优点：改动最小，不引入新依赖。

**方案 B（中量）：前文摘要 + 相关性裁剪**

- 对 prevChapters 用 AI 做摘要（每章提取 3-5 个关键点），替代全文注入。
- 对 settings 用 writers' room 的 selectDocs 同款机制（agent-driven 相关性选择），只注入与当前章节相关的 codex。
- 优点：精确裁剪，信息密度高。
- 缺点：额外 AI 调用（摘要），增加延迟。

**方案 C（完整）：冷上下文 state 引擎**

- 将 codex + 前文状态抽象为结构化 state（角色当前状态、未解决剧情线、世界观关键约束），续写时注入 state 而非全文。
- 对应 osiworx 的"world definition"。
- 优点：信息密度最高，长篇最优。
- 缺点：工作量大，需新建 state 模型和提取逻辑。

### 涉及文件

- `src/renderer/src/components/AiAssistPanel.tsx`（useOutlineContext + buildMessages）
- 可能新增 `src/shared/prompts/context.ts`（上下文裁剪/摘要逻辑）

### 风险

- 截断/摘要可能丢失关键信息，需提供"未包含的上下文"提示。
- 额外 AI 摘要调用增加延迟（方案 B/C），需异步 + loading 状态。

---

## P0-2：Voice 仅是 prompt 愿望，非可学习档案

### 问题

Lorekeeper 的 polish（润色）systemPrompt 是 `"keep the author's original voice"`（`en.ts:81`），仅一条指令。bookmoth 宣称"读取你的散文在句子级建立风格档案，每稿对照"——这是质差。

### 现状

- `AiAssistPanel.tsx:194-203` polish 分支：`const target = selectedText || content.slice(0, 6000)`，把当前段落 + systemPrompt 发 AI，无作者风格档案注入。
- `types.ts` WritingConfig 有 temperature/topP 但无 voiceProfile 字段。
- `store.ts` 无风格档案存储。

### 方案

**Phase 1：风格档案生成**

- 新增"分析我的风格"功能：选 3-5 段代表性章节，AI 提取风格档案（句长分布、用词偏好、叙述口吻、对话节奏、常用修辞），输出结构化 JSON。
- 存储到世界目录下 `voice-profile.json`。

**Phase 2：润色时注入**

- polish 的 systemPrompt 注入风格档案（如 `"The author's voice profile: sentence length ~15-25 words, prefers concrete verbs over adverbs, dialogue is terse with subtext..."`）。
- 在 AiAssistPanel 的 buildMessages polish 分支拼接 voiceProfile。

**Phase 3：档案迭代**

- 每次润色后可选"是否更新风格档案"，用加权方式更新。

### 涉及文件

- `src/shared/types.ts`（新增 VoiceProfile 类型）
- `src/renderer/src/components/AiAssistPanel.tsx`（buildMessages polish 分支注入 voiceProfile）
- `src/shared/prompts/en.ts`（新增 voice analysis prompt）
- `src/server/store.ts`（读写 voice-profile.json）
- `src/renderer/src/store.ts`（voiceProfile state）
- 可新增 `src/renderer/src/views/VoiceProfile.tsx`（风格分析 UI）

### 风险

- 风格档案质量依赖 AI 分析能力，需验证不同模型表现。
- 档案可能过于僵化（作者风格会变化），需要迭代更新机制。

---

## P0-3：无移动端/跨设备

### 问题

竞品 BookZeta 面向"手机 20 分钟碎片写作"，bookmoth 有 iPhone/iPad companion + iCloud 同步。Lorekeeper 仅 Electron 桌面（Windows），无移动端。

### 现状

- Electron 桌面应用，`electron-builder` 打包为 zip。
- 数据存储 `~/.lorekeeper`，纯 Markdown+JSON，天然可同步。
- 无 web 端（但项目有 vite 构建 + express 后端，HTML 渲染层存在）。

### 方案

**方案 A：PWA 渐进式 Web 应用**

- 利用已有 vite + React 前端，构建 PWA（Service Worker + manifest）。
- 数据层：已有 `/api/*` HTTP 端点，移动端用同一套。
- 优点：开发成本最低，复用现有代码。
- 缺点：依赖网络，非纯本地。

**方案 B：React Native / Capacitor 移动端**

- 用 Capacitor 打包现有 web 前端为 iOS/Android 应用。
- 数据层：用设备本地存储替代 HTTP 服务端。
- 优点：真本地离线。
- 缺点：工作量大，需适配移动端 UI。

**方案 C：跨设备同步层**

- 保持桌面 Electron 为主，加 iCloud/Dropbox/自建 sync 同步 `~/.lorekeeper` 目录。
- 配合 PWA 或轻量移动端。
- 优点：保留桌面端所有功能，同步是增量。
- 缺点：同步层有冲突处理成本。

**建议**：短期做 PWA（方案 A），解决"碎片时间查看/小修"需求；长期结合方案 C（同步层）实现真跨设备。

### 涉及文件

- 新建 PWA 配置（manifest.json, service worker）
- `vite.config.ts`（PWA 插件）
- `src/renderer/src/`（移动端适配，响应式布局）

### 风险

- PWA 的纯本地数据读写需要额外设计（当前 /api 走 HTTP 到本地服务端，移动端无法运行 node 服务端）。
- 移动端 UI 适配工作量可能被低估。

---

## P1-1：AI 修订缺 inline diff 视图

### 问题

WordBird 的"rewrite 给红绿 diff 像 code review"是亮点特性。Lorekeeper 的 polish 模式直接替换选中文本（`AiAssistPanel.tsx:524-528`），或追加到文档末尾。用户无法直观看到 AI 改了什么。

### 现状

- `AiAssistPanel.tsx:523-529`：`onInsert` 直接用 `before + text + after` 替换选区。
- 无 diff 算法或 diff 视图。
- `History.tsx` 有快照列表（可恢复），但非 inline diff。

### 方案

**Phase 1：polish 结果预览**

- polish 完成后不直接替换，而是显示"原文 vs 修订"并排或 inline diff（红删绿增）。
- 用轻量 diff 库（如 `diff` 或自实现 token-level diff）。
- 用户确认后替换。

**Phase 2：snapshot diff**

- History 快照列表加"对比"按钮，显示快照与当前版本的 inline diff。

### 涉及文件

- `src/renderer/src/components/AiAssistPanel.tsx`（polish 流程改为预览模式）
- 新增 `src/renderer/src/components/DiffView.tsx`（diff 视图组件）
- `package.json`（加 diff 库依赖，或自实现）

### 风险

- token-level diff 对中文分词需额外处理（CJK 语义边界）。
- 大段替换的 diff 可能难以阅读，需设置阈值（超过一定差异率直接显示"全文替换"）。

---

## P1-2：不兼容外部 Markdown/Obsidian 文件夹

### 问题

icanwrite 可"加一个 .md 文件夹直接编辑、兼容 Obsidian 文件夹"。Lorekeeper 用自有 `~/.lorekeeper` + `novel.json` 结构，已有 Obsidian vault 的用户无法直接接入。

### 现状

- `server/store.ts` 的数据路径由 `projectRoot()`（`~/.lorekeeper` 或 `ORBIT_DATA_DIR`）决定。
- 目录结构：`worlds/<id>/settings/...`, `chapters/...`, `novel.json`, `discussions/...`, `.snapshots/...`。
- `src/shared/types.ts` 的 SettingDoc 和 Chapter 通过 id/file 引用文件，路径相对世界目录。

### 方案

**方案 A：外部文件夹链接模式**

- 新增"链接外部文件夹为 codex 源"功能：指定一个本地文件夹路径，Lorekeeper 读取其 .md 文件作为只读 codex 文档，不修改、不迁移。
- 用于 AI 引用（consistency/discussion/续写），不在 codex 面板编辑。

**方案 B：Obsidian 兼容模式**

- 新增配置项将数据目录结构改为 Obsidian 兼容（flat .md 文件 + frontmatter 元数据），或直接以 Obsidian vault 为数据目录。
- 优点：完全兼容。
- 缺点：工作量大，需改造整个数据模型。

**建议**：先做方案 A（轻量，解决"AI 引用我有 Obsidian 笔记"的痛点），评估需求后考虑方案 B。

### 涉及文件

- `src/server/store.ts`（新增外部文件夹读取）
- `src/shared/types.ts`（ExternalDoc 或 LinkSource 类型）
- 新增 `src/renderer/src/views/LinkedSources.tsx`（管理外部链接）
- `src/renderer/src/store.ts`（外部文件夹 state）

### 风险

- 外部文件变化检测（文件被外部编辑器修改后需刷新）。
- 权限问题（Windows 跨目录读取）。

---

## P1-3：缺少"与故事角色 in-character 对话"模式

### 问题

Khotan Studios 和 MATRA 提供"与角色本身对话，in-character 推回/躲闪"（voice discovery）。Lorekeeper 的 Writers' Room 是元角色（编辑/读者/作者/学者）讨论故事问题，不是与故事角色对话。

### 现状

- `en.ts:5-38` personas：Vera(Editor)、Sam(Reader)、Marcus(Author)、Dr. Okafor(Scholar)——全是元角色。
- `Discussion.tsx` 的讨论流程：选择 personas -> 讨论 topic -> 总结 -> merge。
- 角色 codex 在 settings 里（character 分类），但未被当作 persona 注入。

### 方案

**新增"角色对话"模式**：

- 在 Writers' Room 或单独的"角色工坊"中，新增 persona 来源：从 codex 的 character 分类文档中选取角色。
- 角色 persona 的 systemPrompt 基于 codex 角色设定自动生成（如 `"You are [character name], [role/background]. You speak with [tone trait]. You know [knowledge scope]. Respond in-character, stay within your worldview, push back when appropriate."`）。
- 对话流程与 Writers' Room 类似（selectDocs -> 角色发言 -> 用户引导），但目标不是"讨论故事问题"而是"挖掘角色声音"。
- 对话可导出为 .md，角色档案可更新回 codex。

### 涉及文件

- `src/shared/prompts/en.ts`（新增 character persona 生成 prompt）
- `src/shared/types.ts`（AgentPersona 可扩展或新增 CharacterPersona）
- `src/renderer/src/views/Discussion.tsx`（或新建 CharacterChat.tsx）
- `src/renderer/src/store.ts`（角色 persona state）

### 风险

- 生成的角色 persona 质量依赖 codex 角色设定的完整度。
- 角色"推回/躲闪"行为需要 prompt 工程调试。

---

## P1-4：出版导出缺 epub + 封面 prompt

### 问题

Plot & Prompt 有 KDP-ready listing + cover prompt，Automateed 有出版市场。Lorekeeper 已有 exportWorld(zip) 和 exportWiki(html)，但缺 epub 格式化导出和封面生成。

### 现状

- `server/index.ts`：`/api/exportWorld`（zip 打包原始 md+json）、`/api/exportWiki`（静态 HTML wiki）。
- 无 epub 生成逻辑。
- 无封面相关 prompt 或生成。

### 方案

**Phase 1：epub 导出**

- 新增 `/api/exportEpub` 端点，将当前世界的章节 + codex 打包为 epub。
- 用 npm 库如 `epub-gen` 或 `@lesjoursfr/html-to-epub`。
- 输出：标题页（封面文字）、目录、章节正文、附录（codex 摘要）。

**Phase 2：封面 prompt**

- 在 Overview 或导出面板加"生成封面 prompt"按钮：AI 读 synopsis + genre + tags，输出 Midjourney/Ideogram 封面 prompt。
- 不直接生成图片（保持 local-first），只输出 prompt 供用户自行生成。

### 涉及文件

- `src/server/index.ts`（新增 /api/exportEpub 端点）
- `src/shared/prompts/en.ts`（新增封面 prompt 模板）
- `src/renderer/src/views/Dashboard.tsx`（导出面板加 epub 选项）
- `package.json`（epub 生成库依赖）

### 风险

- epub 格式对中文排版支持需验证。
- 封面 prompt 质量依赖 AI 对 genre 的理解。

---

## 附录：涉及文件总览

| 文件                                            | 涉及方案                                                                                 |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/renderer/src/components/AiAssistPanel.tsx` | P0-1, P0-2, P1-1                                                                         |
| `src/shared/prompts/en.ts`                      | P0-2, P1-3, P1-4                                                                         |
| `src/shared/types.ts`                           | P0-2, P1-2, P1-3                                                                         |
| `src/server/store.ts`                           | P0-2, P1-2                                                                               |
| `src/server/index.ts`                           | P1-4                                                                                     |
| `src/renderer/src/store.ts`                     | P0-2, P1-2, P1-3                                                                         |
| `src/renderer/src/views/Consistency.tsx`        | P0-1（参考 MAX_CHAPTERS 模式）                                                           |
| `src/renderer/src/views/Discussion.tsx`         | P1-3                                                                                     |
| `src/renderer/src/views/Dashboard.tsx`          | P1-4                                                                                     |
| `src/renderer/src/views/History.tsx`            | P1-1                                                                                     |
| `vite.config.ts`                                | P0-3                                                                                     |
| `package.json`                                  | P0-3, P1-1, P1-4                                                                         |
| 新增文件                                        | P0-2 VoiceProfile.tsx, P1-1 DiffView.tsx, P1-2 LinkedSources.tsx, P1-3 CharacterChat.tsx |
