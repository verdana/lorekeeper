// Electron desktop builds are English-only; the web dev server keeps Chinese.
const isElectron = navigator.userAgent.includes('Electron')
export { isElectron }
export type UiLang = 'en' | 'zh'
export const uiLang: UiLang = isElectron ? 'en' : 'zh'

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

  'calibration.title': { en: 'Calibration (human-in-the-loop)', zh: '校准（人在环）' },
  'calibration.summary': { en: '{n} samples · {m} scored', zh: '{n} 样本 · {m} 已回填' },
  'calibration.desc': {
    en: 'Zhuque has no public API, so calibration is human-in-the-loop: record sample -> copy prose to Zhuque -> backfill score -> fit weights. More samples bring the local score closer to Zhuque, but it remains a reference only.',
    zh: '朱雀无公开 API，校准靠人在环：记录样本 -> 复制正文去朱雀检测 -> 回填疑似度 -> 拟合权重。样本越多，本地分越贴合朱雀，但永远是参考。',
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
  zhuquePlaceholder: { en: 'Zhuque %', zh: '朱雀%' },

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
    en: 'At least 2 backfilled Zhuque scores are needed to fit.',
    zh: '至少需要 2 个已回填朱雀分的样本才能拟合',
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
