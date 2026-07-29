import type { RulesPack } from './rules.types'

/**
 * English de-slop rules pack (v1).
 *
 * Weighted signals, not a blacklist. English AI prose leans on explicit
 * connective scaffolding, symmetric "not just X but Y" constructions, and
 * abstract-noun fog. Patterns are case-insensitive at match time.
 */
export const enRules: RulesPack = {
  version: 'en-v1',
  lang: 'en',
  rules: [
    // ---- Explicit connectives / transition scaffolding ----
    { pattern: '\\bhowever\\b', category: 'connective', weight: 0.5 },
    { pattern: '\\btherefore\\b', category: 'connective', weight: 0.5 },
    { pattern: '\\bmoreover\\b', category: 'connective', weight: 0.6 },
    { pattern: '\\bfurthermore\\b', category: 'connective', weight: 0.6 },
    { pattern: '\\bin conclusion\\b', category: 'connective', weight: 0.85 },
    { pattern: '\\ball in all\\b', category: 'connective', weight: 0.8 },
    { pattern: "\\bit(?:\\u2019|')?s worth noting that\\b", category: 'connective', weight: 0.85 },
    { pattern: '\\bit is important to note\\b', category: 'connective', weight: 0.85 },
    { pattern: '\\bneedless to say\\b', category: 'connective', weight: 0.6 },
    { pattern: "\\bin today(?:\\u2019|')?s [a-z-]+ world\\b", category: 'connective', weight: 0.8 },
    { pattern: '\\ba testament to\\b', category: 'idiomHint', weight: 0.7 },

    // ---- Symmetric / parallel scaffolding ----
    {
      pattern: '\\bnot just [^,.]{1,30}(?:,)? but\\b',
      category: 'parallelism',
      weight: 0.75,
      note: 'not just X but Y',
    },
    {
      pattern: '\\bnot only [^,.]{1,30}(?:,)? but (?:also)?\\b',
      category: 'parallelism',
      weight: 0.7,
    },
    { pattern: '\\bwhether [^,.]{1,30} or\\b', category: 'parallelism', weight: 0.5 },
    {
      pattern: '\\b(?:firstly|secondly|thirdly|lastly|finally),',
      category: 'parallelism',
      weight: 0.5,
    },
    {
      pattern: '\\bon (?:the )?one hand\\b[^.]{1,60}on the other hand\\b',
      category: 'parallelism',
      weight: 0.6,
    },

    // ---- Abstract-noun / hedge fog ----
    { pattern: '\\ba sense of [a-z]+\\b', category: 'abstractNoun', weight: 0.5 },
    { pattern: '\\bthe essence of\\b', category: 'abstractNoun', weight: 0.5 },
    { pattern: '\\bmyriad\\b', category: 'abstractNoun', weight: 0.4 },
    { pattern: '\\btapestry\\b', category: 'idiomHint', weight: 0.6 },
    { pattern: '\\bdelve into\\b', category: 'idiomHint', weight: 0.6 },
    { pattern: '\\brealm of\\b', category: 'abstractNoun', weight: 0.45 },
    { pattern: '\\bnavigate the [a-z]+\\b', category: 'idiomHint', weight: 0.45 },
  ],
}
