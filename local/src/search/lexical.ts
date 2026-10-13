import type { SkillEntry, SkillUri } from "../types.js";

export const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const STOPWORDS = new Set(("a an the and or to of for in on with from by is are be it this that do please use using when how me my can could would should not only then after before need want help " +
  "해줘 해주세요 알려줘 작성해줘 만들어줘 확인해줘 검토해줘 필요 없어 있습니다 합니다 작업 사용 통해 대한 위한 관련 현재 다음 먼저 실제 하나 것 수 및 또는 하고 그리고 방법 " +
  // Bare particles left over when a Latin/digit token carries a Korean particle ("api가", "19로").
  "은 는 이 가 을 를 의 도 로 와 과 에").split(" "));

export function stem(word: string): string {
  if (/^[가-힣]+$/.test(word) && word.length > 2) {
    const stripped = word.replace(/(?:해주세요|해줘|하기|하게|하는|하면서|하려는|으로|에서|에게|에는|까지|부터|처럼|보다|은|는|을|를|이|가|과|와|의|도|로)$/, "");
    return stripped.length >= 2 ? stripped : word;
  }
  return /^[a-z]{5,}s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Raw word tokens of normalized text, split where Hangul meets Latin/digits ("api가" -> "api", "가"). */
export function words(text: string): string[] {
  return (normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [])
    .flatMap(word => word.split(/(?<=[가-힣])(?=[a-z0-9])|(?<=[a-z0-9])(?=[가-힣])/));
}

export const isStopword = (word: string) => STOPWORDS.has(word);

export function terms(text: string): string[] {
  return [...new Set(words(text).filter(word => !STOPWORDS.has(word)).map(stem).filter(word => !STOPWORDS.has(word)))];
}

export function keywordsOf(entry: SkillEntry): string[] {
  return [...entry.examples, ...entry.aliasesKo, ...(entry.whenToUse ? terms(entry.whenToUse) : [])].map(normalize).filter(Boolean);
}

/** anchor: 2 = exact name, 1 = exact keyword phrase, 0 = none. */
export type LexicalHit = { uri: SkillUri; score: number; matched: string[]; anchor: 0 | 1 | 2 };

type Row = { uri: SkillUri; name: string; keywords: string[]; nameTerms: Set<string>; weights: Map<string, number> };

export interface LexicalIndex { search(query: string): LexicalHit[] }

export function buildLexical(entries: SkillEntry[]): LexicalIndex {
  const frequency = new Map<string, number>();
  const rows: Row[] = entries.map(entry => {
    const name = normalize(entry.name), keywords = keywordsOf(entry);
    const weights = new Map<string, number>();
    for (const [field, weight] of [[entry.description, 1], [keywords.join(" "), 4], [name, 8]] as const) {
      for (const term of terms(field)) weights.set(term, weight);
    }
    for (const term of weights.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return { uri: entry.uri, name, keywords, nameTerms: new Set(terms(name)), weights };
  });
  const size = rows.length;
  return {
    search(query) {
      const text = normalize(query);
      if (!text) return [];
      const queryTerms = terms(text);
      const hits: LexicalHit[] = [];
      for (const { uri, name, keywords, nameTerms, weights } of rows) {
        const anchor: 0 | 1 | 2 = name === text ? 2 : keywords.includes(text) ? 1 : 0;
        let score = anchor === 2 ? 1000 : anchor === 1 ? 300 : 0;
        let anchored = anchor > 0;
        const matched: string[] = [];
        for (const word of queryTerms) {
          const weight = weights.get(word);
          if (!weight) continue;
          matched.push(word);
          anchored ||= nameTerms.has(word) || keywords.includes(word);
          const rarity = Math.log(1 + (size + .5) / ((frequency.get(word) ?? 0) + .5));
          score += weight * rarity;
        }
        if (!score || (queryTerms.length > 1 && matched.length === 1 && !anchored)) continue;
        // Prefer coverage without letting unmatched narrative details erase a result.
        score *= 1 + matched.length / Math.max(queryTerms.length, 1);
        hits.push({ uri, score, matched, anchor });
      }
      return hits.sort((a, b) => b.score - a.score || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
    },
  };
}
