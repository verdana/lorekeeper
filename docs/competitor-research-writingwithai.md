# WritingWithAI 竞品调研结论

> 数据来源：r/WritingWithAI Weekly Tool Thread
>
> - July 21 帖 (id: 1v28pmi) - 51 条评论
> - July 14 帖 (id: 1uvz0uk) - 62 条评论
>   调研日期：2026-07-27
>   抓取方式：Reddit 被 GFW 屏蔽且 .json 端点被 WAF 封，最终经代理 + 应用内浏览器接管已打开标签页提取已渲染评论。

## 0. 方法说明与可信度

- 这两个帖子是 weekly tool thread，主体是**工具作者自荐**与**用户提问**。下文竞品特性多为作者自述，未经独立验证，请按"自述特性"对待。
- Reddit 新版懒加载，提取的是首屏已渲染评论，深层折叠评论可能未完全纳入。
- Lorekeeper 的能力判断基于**实际源码核实**（非仅 README），关键定位见文末"源码核实记录"。

## 1. 竞品反复出现的特性主题

从约 30 个被提及工具中提炼的高频主题（括号为代表工具，均为作者自述）：

| 主题                               | 代表工具                                     | 自述能力                                                              |
| ---------------------------------- | -------------------------------------------- | --------------------------------------------------------------------- |
| 长程一致性检查                     | novilot、WordBird、DeepCrafter               | 跨章节抓矛盾，引用两处冲突原文并解释                                  |
| Story Bible/Codex 持久化 + AI 引用 | WordBird、bookmoth、WorldOS                  | 锁定角色/设定/规则，生成时引用                                        |
| 生成时状态追踪防漂移               | AI Book Generator、osiworx、Open-Write       | 角色/codex/剧情线作为草稿外 state，生成时校验，冷上下文写新章不丢连接 |
| Voice/风格保持                     | bookmoth、CharmWriter                        | 分析作者真实散文建立风格档案，每稿对照；口述转散文                    |
| Diff 修订视图                      | WordBird                                     | 重写给出红绿 diff，像 code review                                     |
| 多角色协作/writers' room           | Open-Write、OkIsland9262                     | brainstorm/critique/记忆/编辑分工                                     |
| 本地优先 + BYOK + 隐私             | icanwrite、Storythread Studio、MATRA、Proser | 无服务端副本、Obsidian 文件夹直读、本地 LLM                           |
| 移动端/跨设备                      | BookZeta、bookmoth                           | 手机碎片写作、iCloud 同步                                             |
| 角色对话/voice discovery           | Khotan Studios、MATRA                        | 与角色本身 in-character 对话，推回/躲闪                               |
| 出版/垂直产出                      | Plot & Prompt、Automateed、Radiate Studio    | KDP listing、封面 prompt、epub、出版市场                              |
| 新手零门槛                         | Tex_Non_Scripta（提问）、BookZeta            | 不要复杂界面、无需配 key                                              |

被提及的主要工具清单（去重）：Novelmint、Plot & Prompt、Storythread Studio、Open-Write、bookmoth、Proser(VSCode 插件)、grabaprompt、DeepCrafter、Fatekissed、Wistful_Ail(无名工作区)、Storyteller(new_mind)、NexusStoriesAI、AI Book Generator、Khotan Studios、BookZeta、ari、osiworx、WordBird、CharmWriter、novilot、icanwrite、WorldOS、Radiate Studio、Plotlytics、Riffable、MATRA、Automateed、Versey、Acurio/citecheck，以及通用模型 Claude/ChatGPT/Gemini/DeepSeek/Gemma。

## 2. Lorekeeper 已有的强项（源码确认，应作为卖点）

这些**不需要改**，部分已领先竞品宣传点：

- **Consistency Check 实际强于多数竞品宣传**：`src/shared/prompts/en.ts:40` 起，6 维度、要求"quote the two conflicting passages"、3 级严重度（🔴🟡🟢）、修复建议、禁止臆造。`Consistency.tsx` 还有可选范围（codex 文档 + 章节复选）、MAX_CHAPTERS=12、CONTEXT_BUDGET 字数预算检查。novilot 主打的"引用两处冲突行" Lorekeeper 已具备。
- **Writers' Room 闭环成熟**：`en.ts:143` 起，selectDocs 选相关文档 -> proposal 各提一个点 -> focus/open 轮次 -> moderator 总结 -> merge 进 codex，外加 7 个 topic 模板。比 Open-Write 的"多 agent pipeline"和 OkIsland9262 的"角色分离"更完整。
- **续写/大纲写作已注入完整上下文**（见下方修正说明）。
- **本地优先最彻底**：纯 Markdown+JSON、无数据库无云、BYOK、密钥 OS 加密（DPAPI/Keychain）。
- **已有 wiki 导出**：`server/index.ts` 的 `/api/exportWiki` 可导出自包含 HTML wiki（README 未提及，是隐藏卖点）；另有 `/api/exportWorld` zip 导出。
- **Multi-world、Graph（vis-network 关系图）、Timeline**：README 对 Graph/Timeline 着墨很少，实际是差异化点。

## 3. 重要修正：关于"续写漂移"的判断

> 本节是对上一轮分析的自我修正。

上一轮分析曾判断"续写/inline 润色不注入 codex 状态，存在漂移风险"（P0-1）。**经源码核实，该判断错误，予以撤回。**

实际源码（`src/renderer/src/components/AiAssistPanel.tsx`）：

- 第 154 行：`useOutlineContext(chapterId, mode === 'outline-write' || mode === 'continue')` -- **continue 模式同样加载 codex settings + outline + prevChapters**。
- 第 229-247 行 buildMessages 的 continue 分支：把 settings、outline、prevChapters 全部拼进 user message。
- 第 156 行：`tailContext = content.slice(-2000)` 作为"前文末尾"。

即**续写已有 codex + outline + 前文上下文，具备防漂移能力**。仅 polish（润色）模式只传当前段落（第 198 行 `selectedText || content.slice(0, 6000)`），但润色本就以文字质量为目标、不需要世界观注入，不算缺陷。

**修正后的真实问题**（见改进计划 P0-1）：`useOutlineContext`（第 83-108 行）加载**全部** settingDocs 与**全部**前文章节且无上限。Consistency 有 MAX_CHAPTERS=12 与 budget 检查，但续写/大纲的前文**无裁剪、无上限**，长篇（数十章）下会 context bloat、超出模型窗口或稀释聚焦。这才是比 osiworx"冷上下文写新章不丢连接"更精准的技术差距--不是"不注入"，而是"全量注入无裁剪"。

## 4. 改进建议汇总（详见 improvement-plan-p0-p1.md）

**P0 - 真实缺口**

- P0-1（修正）：续写/大纲写作前文上下文无上限 -> 长篇 context bloat
- P0-2：Voice 仅是 prompt 愿望，非可学习档案
- P0-3：无移动端/跨设备

**P1 - 有竞品先例，性价比中等**

- P1-1：AI 修订缺 inline diff 视图
- P1-2：不兼容外部 Markdown/Obsidian 文件夹
- P1-3：缺少"与故事角色 in-character 对话"模式
- P1-4：出版导出缺 epub + 封面 prompt（注：wiki/zip 导出已存在）

**不建议跟风**

- 托管/免 key 模式（会稀释 local-first 卖点，应改做顺滑 onboarding + 试用 key）
- 协作/社区接力（与单人本地定位不同）
- 改开源许可（Source Available - Non-Commercial 是商业选择，不应因竞品压力被动调整）

## 5. 源码核实记录

| 关注点               | 文件                          | 结论                                                 |
| -------------------- | ----------------------------- | ---------------------------------------------------- |
| 续写 context 注入    | AiAssistPanel.tsx:154,229-247 | 已注入 codex+outline+prevChapters                    |
| 续写前文无上限       | AiAssistPanel.tsx:83-108      | 全量加载 settingDocs + 全部前章，无裁剪              |
| polish context       | AiAssistPanel.tsx:198         | 仅 selectedText 或前 6000 字，无 voice 档案          |
| consistency material | Consistency.tsx:114-124       | 可选 codex + 可选章节，MAX_CHAPTERS=12，budget 检查  |
| consistency prompt   | en.ts:40-62                   | 6 维度、引用两处冲突、3 级严重度                     |
| writers' room        | en.ts:143-213                 | selectDocs->proposal->speak->summary->merge + 7 模板 |
| 导出端点             | server/index.ts               | exportWorld(zip) + exportWiki(html) 已存在           |
| 移动端               | src grep                      | 无 mobile/ios/android                                |
| Obsidian 兼容        | src grep                      | 无；自有 ~/.lorekeeper + novel.json 结构             |
