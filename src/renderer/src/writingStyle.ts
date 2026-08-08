import type { VoiceProfile } from '@shared/types'
import { PROMPT_LANG, PROMPTS } from '@shared/prompts'

/**
 * Pure prompt-assembly helpers for the AI writing panels. Kept out of the
 * .tsx component so they are unit-testable without a JSX transform.
 */

/** Build voice-profile injection text for system prompts. Shared by all writing modes. */
export function buildVoiceContext(voiceProfile: VoiceProfile | null): string {
  const t = voiceProfile?.traits
  if (!t) return ''
  if (PROMPT_LANG === 'zh') {
    return `\n\n## 作者声音档案（严格遵循以下特征）：\n- 句长：${t.sentenceLength}\n- 动词风格：${t.verbStyle}\n- 叙事距离：${t.narrativeDistance}\n- 对话：${t.dialogueStyle}\n- 修辞习惯：${t.rhetoricalPatterns}\n- 备注：${t.proseNotes}`
  }
  return `\n\n## Author voice profile (follow these traits strictly):\n- Sentence length: ${t.sentenceLength}\n- Verb style: ${t.verbStyle}\n- Narrative distance: ${t.narrativeDistance}\n- Dialogue: ${t.dialogueStyle}\n- Rhetorical patterns: ${t.rhetoricalPatterns}\n- Notes: ${t.proseNotes}`
}

// ---- Setting-doc relevance matching ----
//
// Old behavior matched a codex doc only when its *title* appeared verbatim in
// the signal (chapter title + prose + outline). A doc like 「魔法体系」 whose
// title the outline never mentions was silently dropped — the model then
// "ignored" settings it never saw. New behavior:
//   - worldview + character docs are always included (global rules; and OOC
//     is the most common continuity failure);
//   - other docs match on title appearance OR ≥3 signal n-grams found in the
//     doc body (so body references are caught too).

/** Common words that carry no setting-matching signal. */
export const SIGNAL_STOPWORDS = new Set<string>([
  // 中文高频双字（代词 / 连词 / 虚词 / 常见心理动词）
  '我们',
  '你们',
  '他们',
  '她们',
  '它们',
  '咱们',
  '自己',
  '别人',
  '大家',
  '什么',
  '怎么',
  '怎样',
  '为什么',
  '这个',
  '那个',
  '这些',
  '那些',
  '一个',
  '一种',
  '一些',
  '一下',
  '一点',
  '这里',
  '那里',
  '然后',
  '但是',
  '可是',
  '不过',
  '因为',
  '所以',
  '如果',
  '虽然',
  '尽管',
  '而且',
  '并且',
  '以及',
  '或者',
  '于是',
  '接着',
  '突然',
  '忽然',
  '仿佛',
  '好像',
  '似乎',
  '已经',
  '正在',
  '可以',
  '可能',
  '应该',
  '需要',
  '必须',
  '只有',
  '只要',
  '就是',
  '还是',
  '不是',
  '没有',
  '知道',
  '看到',
  '听到',
  '觉得',
  '感到',
  '想要',
  '开始',
  '最后',
  '终于',
  '常常',
  '往往',
  '真的',
  '其实',
  '难道',
  '到底',
  '究竟',
  '大概',
  '也许',
  '或许',
  '非常',
  '十分',
  '特别',
  '有点',
  '有些',
  '一起',
  '一直',
  '一边',
  '一面',
  '起来',
  '下去',
  '过来',
  '过去',
  '这时',
  '那时',
  '这时',
  '心里',
  '心中',
  '脸上',
  '眼睛',
  '声音',
  '语气',
  '眼神',
  '目光',
  '说话',
  '开口',
  '回答',
  '说道',
  '问道',
  '笑道',
  '喊道',
  '想道',
  '时候',
  '现在',
  '之前',
  '之后',
  '前面',
  '后面',
  '身边',
  '眼前',
  '手里',
  '脚下',
  '回头',
  '转身',
  '抬头',
  '低头',
  '看见',
  '听见',
  '想起',
  '记起',
  '忘记',
  '回忆',
  '脑海',
  '记忆',
  '一切',
  '每个',
  '任何',
  '所有',
  '整个',
  '其他',
  '另外',
  '其中',
  '之间',
  '之中',
  '之后',
  '面前',
  '背后',
  '旁边',
  '再次',
  '重新',
  '继续',
  '离开',
  '回到',
  '走进',
  '走出',
  '来到',
  '出现',
  '消失',
  '发现',
  '明白',
  '清楚',
  '应该',
  '决定',
  '答应',
  '摇头',
  '点头',
  '沉默',
  '安静',
  '呼吸',
  '心跳',
  '片刻',
  '一时',
  // English stop words
  'the',
  'and',
  'that',
  'this',
  'with',
  'from',
  'they',
  'them',
  'their',
  'there',
  'where',
  'what',
  'when',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'have',
  'has',
  'had',
  'been',
  'being',
  'were',
  'was',
  'will',
  'would',
  'shall',
  'should',
  'could',
  'can',
  'may',
  'might',
  'must',
  'not',
  'but',
  'because',
  'then',
  'than',
  'into',
  'onto',
  'upon',
  'about',
  'after',
  'before',
  'between',
  'through',
  'during',
  'without',
  'against',
  'these',
  'those',
  'here',
  'there',
  'again',
  'just',
  'only',
  'very',
  'really',
  'some',
  'any',
  'all',
  'each',
  'every',
  'other',
  'another',
  'also',
  'even',
  'still',
  'though',
  'although',
  'however',
  'therefore',
])

/** Extract signal n-grams: English words (≥3 letters) + Chinese bigrams.
 *  Grams are stored lowercased so body matching is case-insensitive. */
export function extractSignalGrams(text: string, maxGrams = 160): string[] {
  const grams: string[] = []
  const seen = new Set<string>()
  const push = (s: string): void => {
    const key = s.toLocaleLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    grams.push(key)
  }
  for (const t of text.match(/[A-Za-z]{3,}/g) ?? []) {
    if (SIGNAL_STOPWORDS.has(t.toLocaleLowerCase())) continue
    push(t)
    if (grams.length >= maxGrams) return grams
  }
  for (const run of text.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length < 2) continue
    for (let i = 0; i < run.length - 1; i++) {
      const bigram = run.slice(i, i + 2)
      if (SIGNAL_STOPWORDS.has(bigram)) continue
      push(bigram)
      if (grams.length >= maxGrams) return grams
    }
  }
  return grams
}

/** How many signal n-grams appear in a doc body (hit counts are capped cheaply).
 *  Both sides lowercased once: grams are already lowercased by the extractor. */
export function countGramHits(body: string, grams: string[]): number {
  const normalized = body.toLocaleLowerCase()
  let hits = 0
  for (const g of grams) {
    if (normalized.includes(g)) {
      hits++
      if (hits >= 3) return hits
    }
  }
  return hits
}

/**
 * Assemble a writing-mode system prompt: base prompt + genre anchor +
 * style exemplars + voice profile. Genre anchors the register (so a Western
 * fantasy world does not drift into wuxia phrasing); exemplars supply a
 * human-chosen prose model; the voice profile carries the author's traits.
 */
export function buildWritingSystemPrompt(
  base: string,
  opts: { voiceProfile: VoiceProfile | null; genre: string; exemplars: string[] },
): string {
  const parts = [base]
  const anchor = PROMPTS.assist.genreAnchor(opts.genre)
  if (anchor) parts.push(anchor)
  if (opts.exemplars.length > 0) {
    const ex = PROMPTS.assist.exemplar
    parts.push(
      `${ex.header}\n${opts.exemplars
        .map((t, i) => `${i + 1}. ${t.trim()}`)
        .join('\n\n')}\n\n${ex.instruction}`,
    )
  }
  const voice = buildVoiceContext(opts.voiceProfile)
  if (voice) parts.push(voice)
  return parts.join('\n\n')
}
