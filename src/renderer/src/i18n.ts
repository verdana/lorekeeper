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
