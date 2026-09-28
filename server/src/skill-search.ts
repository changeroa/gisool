export type SearchDocument = {
  uri: string;
  name: string;
  description: string;
  keywords: string[];
  automatic: boolean;
  digest: string;
};

export type SearchMode = "legacy" | "automatic" | "explicit" | "discovery";
const compareUri = (a: SearchDocument, b: SearchDocument) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const stopwords = new Set("a an the and or to of for in on with from by is are be it this that do please use using when how me my can could would should not only then after before need want help 해줘 해주세요 알려줘 작성해줘 만들어줘 확인해줘 검토해줘 필요 없어 있습니다 합니다 작업 사용 통해 대한 위한 관련 현재 다음 먼저 실제 하나 것 수 및 또는 하고 그리고 방법".split(" "));
const stem = (word: string) => {
  if (/^[가-힣]+$/.test(word) && word.length > 2) {
    const stripped = word.replace(/(?:해주세요|해줘|하기|하게|하는|하면서|하려는|으로|에서|에게|에는|까지|부터|처럼|보다|은|는|을|를|이|가|과|와|의|도|로)$/, "");
    return stripped.length >= 2 ? stripped : word;
  }
  return /^[a-z]{5,}s$/.test(word) && !word.endsWith("ss") ? word.slice(0, -1) : word;
};
const terms = (text: string) => [...new Set((normalize(text).match(/[\p{L}\p{N}]+/gu) ?? [])
  .filter(word => !stopwords.has(word)).map(stem).filter(word => !stopwords.has(word)))];
type Indexed = { item: SearchDocument; name: string; keywords: string[]; nameTerms: Set<string>; weights: Map<string, number> };
// Bounded content-keyed indexes survive reconstructed request arrays without
// mixing releases or retaining a catalog forever. No skill-name routing map.
const indexes = new Map<string, { rows: Indexed[]; frequency: Map<string, number> }>();
function index(documents: SearchDocument[]) {
  const key = JSON.stringify(documents);
  const cached = indexes.get(key);
  if (cached) return cached;
  const frequency = new Map<string, number>();
  const rows = documents.map(item => {
    const name = normalize(item.name), keywords = item.keywords.map(normalize);
    const weights = new Map<string, number>();
    for (const [field, weight] of [[item.description, 1], [keywords.join(" "), 4], [name, 8]] as const) {
      for (const term of terms(field)) weights.set(term, weight);
    }
    for (const term of weights.keys()) frequency.set(term, (frequency.get(term) ?? 0) + 1);
    return { item: { ...item, keywords: [...item.keywords] }, name, keywords, nameTerms: new Set(terms(name)), weights };
  });
  const result = { rows, frequency };
  if (indexes.size >= 8) indexes.delete(indexes.keys().next().value!);
  indexes.set(key, result);
  return result;
}

// Keywords belong to the versioned skill content, never a client-side name map.
// Natural-language requests may contain details absent from skill metadata. Rank
// matched subject evidence rather than requiring every word, while abstaining
// on no evidence. Discovery includes manual candidates but never activates them.
export function searchSkills(documents: SearchDocument[], query: string | undefined, mode: SearchMode): SearchDocument[] {
  if (mode === "legacy") {
    const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
    return documents.filter(item => {
      const text = `${item.name} ${item.description} ${item.keywords.join(" ")}`.toLowerCase();
      return words.every(word => text.includes(word));
    }).sort(compareUri);
  }
  const text = normalize(query ?? "");
  const words = terms(text);
  const { rows, frequency } = index(documents);
  return rows.flatMap(({ item, name, keywords, nameTerms, weights }) => {
    if (mode === "automatic" && !item.automatic) return [];
    if (!text) return [{ item, score: 0 }];
    let score = name === text ? 1000 : keywords.includes(text) ? 300 : 0;
    let matched = 0;
    let anchored = name === text || keywords.includes(text);
    for (const word of words) {
      const weight = weights.get(word);
      if (!weight) continue;
      matched++;
      anchored ||= nameTerms.has(word) || keywords.includes(word);
      const rarity = Math.log(1 + (documents.length + .5) / ((frequency.get(word) ?? 0) + .5));
      score += weight * rarity;
    }
    if (!score || (words.length > 1 && matched === 1 && !anchored)) return [];
    // Prefer coverage without allowing unmatched narrative details to erase a result.
    score *= 1 + matched / Math.max(words.length, 1);
    return [{ item, score }];
  }).sort((a, b) => b.score - a.score || compareUri(a.item, b.item)).map(({ item }) => item);
}

const DESCRIPTION_LIMIT = 240;

export function excerpt(description: string, terms: string[]) {
  const text = description.replace(/\s+/g, " ").trim();
  const characters = Array.from(text);
  if (characters.length <= DESCRIPTION_LIMIT) return { description: text };

  const lower = text.toLowerCase();
  const positions = terms.map(term => lower.indexOf(term)).filter(index => index >= 0);
  const firstMatch = positions.length ? Math.min(...positions) : 0;
  const matchPosition = Array.from(lower.slice(0, firstMatch)).length;
  // Leave room for ellipses and show context around a match even late in the description.
  const width = DESCRIPTION_LIMIT - 2;
  const start = Math.min(Math.max(0, matchPosition - 60), characters.length - width);
  const end = start + width;
  return {
    description: `${start > 0 ? "…" : ""}${characters.slice(start, end).join("")}${end < characters.length ? "…" : ""}`,
    descriptionTruncated: true,
  };
}
