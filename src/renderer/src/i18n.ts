// The UI is English by default for public release. Prompt packs
// (shared/prompts) follow PROMPT_LANG / VITE_PROMPT_LANG instead; the UI is
// deliberately decoupled from those variables.
const isElectron = navigator.userAgent.includes('Electron')
export { isElectron }
export type UiLang = 'en' | 'zh'
export const uiLang: UiLang = 'en'

type Params = Record<string, string | number>

const dict: Record<string, { en: string; zh: string }> = {
  'band.green': { en: 'Near-human writing', zh: '接近人类写作' },
  'band.yellow': { en: 'Some AI tone', zh: '有一定机器味' },
  'band.red': { en: 'Strongly AI-sounding', zh: '机器味明显' },

  'voice.sentenceLength': { en: 'Sentence length', zh: '句长' },
  'voice.verbStyle': { en: 'Verb style', zh: '动词风格' },
  'voice.narrativeDistance': { en: 'Narrative distance', zh: '叙事距离' },
  'voice.dialogueStyle': { en: 'Dialogue style', zh: '对话' },
  'voice.rhetoricalPatterns': { en: 'Rhetorical patterns', zh: '修辞习惯' },
  'voice.notes': { en: 'Notes', zh: '备注' },

  title: { en: 'De-slop', zh: '去 AI 味' },
  selectChapterHint: { en: 'Pick a chapter', zh: '选择章节（本地分析，不耗 API）' },
  selectChapterHintSub: { en: '(local analysis, no API cost)', zh: '' },
  noChapters: { en: 'No chapters yet.', zh: 'No chapters yet.' },
  unknown: { en: 'unknown', zh: '未知' },

  emptyTitle: { en: 'Detect AI tone', zh: '检测机器味' },
  emptyDescription: {
    en: 'Pick a chapter. The local stats engine scores its "AI tone" and flags AI-sounding sentences with reasons.',
    zh: '选择一个章节，本地统计引擎会给出「机器味」评分，并逐句标出像 AI 的地方与原因。',
  },
  analyzing: { en: 'Analyzing…', zh: '分析中…' },

  rulesOutdated: {
    en: 'Rules pack updated (current {cur} -> built-in newer). Reset weights in the calibration panel to use the latest rules.',
    zh: '规则包已更新（当前 {cur} -> 内置新版），建议在校准面板重置权重以使用最新规则。',
  },

  'batch.title': { en: 'Chapter sweep', zh: '整章巡检' },
  'batch.scanned': { en: '{n} chapters', zh: '{n} 章' },
  'batch.notScanned': { en: 'Not scanned', zh: '未扫描' },
  'batch.scanAll': { en: 'Scan all chapters', zh: '扫描全部章节' },
  'batch.exportChecklist': { en: 'Export Zhuque checklist', zh: '导出朱雀自测清单' },
  'batch.scanning': {
    en: 'Scanning chapter by chapter (local, no API cost)…',
    zh: '正在逐章扫描（本地，不耗 API）…',
  },
  'batch.col.chapter': { en: 'Chapter', zh: '章节' },
  'batch.col.score': { en: 'AI tone', zh: '机器味' },
  'batch.col.flags': { en: 'Suspect', zh: '可疑句' },
  'batch.col.words': { en: 'Words', zh: '字数' },
  'batch.col.action': { en: 'Action', zh: '操作' },
  'batch.view': { en: 'View', zh: '查看' },

  scoreCaption: {
    en: 'AI-tone score (0–100, lower is more human)',
    zh: '机器味评分 (0–100，越低越像人)',
  },
  rerun: { en: 'Re-analyze', zh: '重新分析' },
  highlightHint: {
    en: 'Highlighted sentences are risky; darker means more AI-like.',
    zh: '高亮句子为风险段落，颜色越深越像 AI',
  },

  rewrite: { en: 'Rewrite {n} suspect sentence(s)', zh: '改写可疑句（{n}）' },
  cancel: { en: 'Cancel', zh: '取消' },
  'intensity.title': { en: 'Rewrite intensity', zh: '改写强度' },
  'intensity.light': { en: 'Light', zh: '轻度' },
  'intensity.balanced': { en: 'Balanced', zh: '平衡' },
  'intensity.strong': { en: 'Strong', zh: '强烈' },

  'rules.title': { en: 'Rules pack', zh: '规则包' },
  'rules.desc': {
    en: 'The local analyzer scores text against a versioned rules pack (zh/en). Import an updated or custom pack to replace the built-in one for that language.',
    zh: '本地分析器按带版本的规则包（中文/英文）给文本打分。可导入更新版或自定义包，替换对应语言的内置包。',
  },
  'rules.import': { en: 'Import rules pack…', zh: '导入规则包…' },
  'rules.restore': { en: 'Restore built-in', zh: '恢复内置' },
  'rules.custom': { en: 'custom', zh: '自定义' },
  'rules.builtin': { en: 'built-in', zh: '内置' },
  'rules.active': {
    en: 'Active pack: {source} {version} · {count} rules ({lang})',
    zh: '当前生效：{source} {version} · {count} 条规则（{lang}）',
  },
  'rules.invalid': { en: 'Invalid rules pack: {err}', zh: '规则包无效：{err}' },
  'rules.previewTitle': { en: 'Import rules pack', zh: '导入规则包' },
  'rules.lang': { en: 'Language: {lang}', zh: '语言：{lang}' },
  'rules.version': { en: 'Version: {version}', zh: '版本：{version}' },
  'rules.count': { en: 'Rules: {count}', zh: '规则数：{count}' },
  'rules.compare': {
    en: 'Current active: {current} → incoming: {incoming}',
    zh: '当前生效：{current} → 导入：{incoming}',
  },
  'rules.resetWeights': {
    en: 'Reset calibrated dimension weights to defaults (recommended after a pack change)',
    zh: '同时将校准的维度权重重置为默认（更换规则包后建议勾选）',
  },
  'rules.confirm': { en: 'Import', zh: '导入' },
  'rules.imported': { en: 'Rules pack {version} imported.', zh: '已导入规则包 {version}。' },
  'rules.restored': { en: 'Restored the built-in rules pack.', zh: '已恢复内置规则包。' },

  stopRewrite: { en: 'Stop rewrite', zh: '停止改写' },
  rewriting: { en: 'Rewriting… {i}/{n}', zh: '正在改写… {i}/{n}' },
  'rewrite.noKey': {
    en: 'No AI provider configured. Add an API key in Settings first.',
    zh: '尚未配置 AI 提供商，请先在「设置」里填写 API Key。',
  },
  'rewrite.noResult': {
    en: 'Model returned no rewrite (it may have spent the budget reasoning).',
    zh: '模型未返回改写结果（可能把预算耗在了思考上）。',
  },
  'rewrite.lowSlop': {
    en: 'This chapter has low AI tone; no sentences to rewrite.',
    zh: '本章节机器味较低，暂无可改写的可疑句。',
  },
  reviewHeader: {
    en: 'Review ({i}/{n}) · {accepted} accepted',
    zh: '逐句审阅（{i}/{n}） · 已接受 {accepted}',
  },
  generatingRewrite: { en: 'Generating rewrite…', zh: '正在生成改写…' },
  reviewDone: {
    en: 'Review done: {accepted} / {n} accepted',
    zh: '审阅完成：已接受 {accepted} / {n} 处',
  },
  writeBack: {
    en: 'Write back chapter (rollback via history)',
    zh: '写回章节（可从历史快照回滚）',
  },
  close: { en: 'Close', zh: '关闭' },
  flagsSummary: {
    en: '{n} suspect sentence(s) (sorted by risk)',
    zh: '共 {n} 处可疑句（按风险排序）',
  },
  flagReason: { en: 'Reason: {note}', zh: '因为：{note}' },

  'calibration.title': { en: 'Calibration (HITL)', zh: '校准（人机协同 HITL）' },
  'calibration.summary': { en: '{n} samples · {m} scored', zh: '{n} 样本 · {m} 已回填' },
  'calibration.desc': {
    en: 'Zhuque has no public API, so calibration is HITL (human-in-the-loop): record sample -> copy prose to Zhuque -> backfill the three percentages -> fit weights. The fit targets the suspected-AI % (highlighted). More samples bring the local score closer to Zhuque, but it remains a reference only.',
    zh: '朱雀无公开 API，校准靠人机协同 HITL：记录样本 -> 复制正文去朱雀检测 -> 回填三项百分比 -> 拟合权重。拟合以疑似 AI 占比（高亮）为目标。样本越多，本地分越贴合朱雀，但永远是参考。',
  },
  'calibration.recordSample': { en: 'Record this chapter as sample', zh: '记录当前章节为样本' },
  'calibration.copyForZhuque': { en: 'Copy prose for Zhuque', zh: '复制正文去朱雀' },
  'calibration.noSamples': { en: 'No samples yet.', zh: '暂无样本。' },
  'calibration.recompute': { en: 'Recompute weights', zh: '重新校准权重' },
  'calibration.maeDefault': { en: 'Current weight MAE {x}', zh: '当前权重平均误差 {x}' },
  'calibration.maeCalibrated': { en: 'Calibrated {x}', zh: '校准后 {x}' },
  'calibration.weightsCompare': { en: 'Calibrated vs current weights', zh: '校准权重 vs 当前权重' },
  'calibration.weightsApplied': { en: 'Calibrated weights applied', zh: '已应用校准权重' },
  'calibration.applyWeights': { en: 'Apply calibrated weights', zh: '应用校准权重' },
  'calibration.resetWeights': { en: 'Reset to default', zh: '恢复默认' },
  localScore: { en: 'Local {n}', zh: '本地 {n}' },
  zhuquePlaceholder: { en: '%', zh: '%' },
  zhuqueAiFeature: { en: 'AI feat.', zh: 'AI特征' },
  zhuqueSuspectedAi: { en: 'Suspected', zh: '疑似AI' },
  zhuqueHumanFeature: { en: 'Human', zh: '人工' },

  'toast.rewriteDone': { en: 'Rewrite done. Review each change.', zh: '改写完成，请逐条审阅' },
  'toast.writtenBack': {
    en: 'Written back to "{title}"; old version saved to history snapshot.',
    zh: '已写回「{title}」，旧版本已存入历史快照',
  },
  'toast.writeBackFailed': { en: 'Write-back failed: {err}', zh: '写回失败：{err}' },
  'toast.sampleRecorded': {
    en: 'Sample recorded. Copy prose to Zhuque and backfill the score.',
    zh: '已记录为校准样本，请复制正文去朱雀检测后回填分数',
  },
  'toast.weightsFit': {
    en: 'Weights refit from backfilled samples.',
    zh: '已根据回填样本重新拟合权重',
  },
  'toast.needSamples': {
    en: 'At least 2 samples with a backfilled suspected-AI % are needed to fit.',
    zh: '至少需要 2 个已回填疑似 AI 占比的样本才能拟合',
  },
  'toast.weightsApplied': {
    en: 'Calibrated weights applied; re-analyzing.',
    zh: '已应用校准权重，将重新分析',
  },
  'toast.weightsReset': { en: 'Weights reset to defaults.', zh: '已恢复默认权重' },
  'toast.copiedForZhuque': {
    en: 'Prose copied. Paste it into Zhuque, then backfill the score.',
    zh: '已复制正文，去朱雀检测后回来回填分数',
  },
  'toast.copyFailed': {
    en: 'Copy failed. Select and copy the prose manually.',
    zh: '复制失败，请手动选择正文复制',
  },
  'toast.scanned': { en: 'Scanned {n} chapters.', zh: '已扫描 {n} 章' },
  'toast.batchFailed': { en: 'Batch scan failed: {err}', zh: '批量扫描失败：{err}' },
  'toast.checklistCopied': {
    en: 'Zhuque checklist copied to clipboard.',
    zh: '朱雀自测清单已复制到剪贴板',
  },
  'toast.copyFailed2': { en: 'Copy failed. Please retry.', zh: '复制失败，请重试' },

  // ---- Batch write (Manuscript N chapters) ----
  'batchWrite.title': { en: 'Batch Write', zh: '批量创作' },
  'batchWrite.subtitle': { en: 'Create or rewrite N chapters', zh: '连续创作或重写 N 章' },
  'batchWrite.mode.continue': { en: 'Create N chapters', zh: '连续创作 N 章' },
  'batchWrite.mode.rewrite': { en: 'Rewrite N chapters', zh: '重写 N 章' },
  'batchWrite.count': { en: 'Chapters (N)', zh: '章节数（N）' },
  'batchWrite.startChapter': { en: 'Start chapter', zh: '起始章节' },
  'batchWrite.startChapterHint': {
    en: 'First chapter to rewrite (inclusive)',
    zh: '要重写的起始章节（含）',
  },
  'batchWrite.maxN': { en: 'Max {n} chapters available', zh: '最多可用 {n} 章' },
  'batchWrite.discussion': { en: 'Workshop report', zh: '讨论组报告' },
  'batchWrite.discussionNone': { en: "Don't use", zh: '不使用' },
  'batchWrite.discussionHint': {
    en: 'Only sessions with a conclusion are listed. The selected conclusion is injected into every rewritten chapter as the primary directive — pick one to drive the rewrite.',
    zh: '仅列出已有结论的讨论组会话。所选结论会作为核心依据注入每个重写章节——记得选择，否则重写不参考讨论。',
  },
  'batchWrite.reportIncluded': {
    en: 'Workshop report injected: {topic} ({characters} chars)',
    zh: '已注入讨论组报告：{topic}（{characters} 字符）',
  },
  'batchWrite.voice': { en: 'Use voice profile', zh: '使用声音档案' },
  'batchWrite.voiceMissing': {
    en: 'No voice profile yet — create one in the Voice Profile page first.',
    zh: '暂无声音档案——请先在「声音档案」页生成。',
  },
  'batchWrite.direction': {
    en: 'Direction / extra instructions (optional)',
    zh: '方向 / 额外指令（可选）',
  },
  'batchWrite.directionPlaceholder': {
    en: 'e.g. advance the A-plot; keep the pacing fast',
    zh: '例如：推进主线；保持快节奏',
  },
  'batchWrite.systemPrompt': { en: 'System prompt', zh: '系统提示词' },
  'batchWrite.systemPromptContinue': { en: 'Batch continue prompt', zh: '批量续写提示词' },
  'batchWrite.systemPromptRewrite': { en: 'Batch rewrite prompt', zh: '批量重写提示词' },
  'batchWrite.reset': { en: 'Reset to default', zh: '重置为默认' },
  'batchWrite.submit': { en: 'Start', zh: '开始' },
  'batchWrite.cancel': { en: 'Cancel', zh: '取消' },
  'batchWrite.progress.preparing': { en: 'Preparing…', zh: '正在准备…' },
  'batchWrite.progress.writing': { en: 'Writing chapter {i}/{n}…', zh: '正在创作第 {i}/{n} 章…' },
  'batchWrite.progress.rewriting': {
    en: 'Rewriting chapter {i}/{n}…',
    zh: '正在重写第 {i}/{n} 章…',
  },
  'batchWrite.progress.attention': {
    en: 'Paused — some chapters failed. Retry, delete, or dismiss.',
    zh: '已暂停——部分章节失败。可重试、删除或关闭。',
  },
  'batchWrite.progress.stopped': { en: 'Stopped.', zh: '已停止。' },
  'batchWrite.progress.failed': { en: 'Failed: {error}', zh: '失败：{error}' },
  'batchWrite.stop': { en: 'Stop', zh: '停止' },
  'batchWrite.retryContinue': { en: 'Retry & continue', zh: '重试并继续' },
  'batchWrite.continueBatch': { en: 'Continue batch', zh: '继续批次' },
  'batchWrite.delete': { en: 'Delete empty chapter', zh: '删除空章' },
  'batchWrite.backToWorld': { en: 'Return to task world', zh: '返回任务世界' },
  'batchWrite.dismiss': { en: 'Dismiss', zh: '关闭' },
  'batchWrite.confirmAbandon': {
    en: 'Abandon recovery and close? Generated / paused content stays on disk.',
    zh: '放弃恢复并关闭？已生成/暂停内容仍保留在磁盘上。',
  },
  'batchWrite.summary': { en: '{done} done · {failed} failed', zh: '完成 {done} · 失败 {failed}' },
  'batchWrite.world': { en: 'World: {name}', zh: '世界：{name}' },
  'batchWrite.status.pending': { en: 'Waiting', zh: '等待' },
  'batchWrite.status.writing': { en: 'Writing', zh: '生成中' },
  'batchWrite.status.done': { en: 'Done', zh: '完成' },
  'batchWrite.status.failed': { en: 'Failed', zh: '失败' },
  'batchWrite.status.stopped': { en: 'Stopped', zh: '已停止' },
  'batchWrite.status.deleted': { en: 'Deleted', zh: '已删除' },
  'batchWrite.lockedHint': {
    en: 'Batch writing in progress — editing and saving are temporarily disabled.',
    zh: '批量写作进行中——编辑与保存已暂时禁用。',
  },
  'batchWrite.worldLocked': {
    en: 'Batch writing is active in this world. Finish or stop it before switching.',
    zh: '当前世界有批量写作任务进行中，请先完成或停止再切换。',
  },
}

/** Translate a key, optionally interpolating `{name}` placeholders. */
export function t(key: string, params?: Params): string {
  const entry = dict[key]
  let s = entry ? entry[uiLang] : key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v))
    }
  }
  return s
}
