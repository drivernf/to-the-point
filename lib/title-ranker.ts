import type { ArticleBodyBlock } from '@/lib/article-body';

export interface RankedArticleChunk {
  startBlockIndex: number;
  endBlockIndex: number;
  score: number;
  text: string;
  snippet: string;
}

export interface TitleRankingResult {
  queryTokens: string[];
  chunkCount: number;
  matches: RankedArticleChunk[];
}

interface ChunkCandidate {
  startBlockIndex: number;
  endBlockIndex: number;
  text: string;
  normalizedText: string;
  tokens: string[];
  tf: Map<string, number>;
  tokenCount: number;
  startsWithHeading: boolean;
}

const WINDOW_SIZES = [1, 2, 3];
const MAX_MATCHES = 10;
const K1 = 1.2;
const B = 0.75;

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'he',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'to',
  'was',
  'were',
  'will',
  'with',
]);

export function rankTitleAgainstBlocks(title: string, blocks: ArticleBodyBlock[]): TitleRankingResult {
  const queryTokens = tokenize(title);

  if (queryTokens.length === 0 || blocks.length === 0) {
    return {
      queryTokens,
      chunkCount: 0,
      matches: [],
    };
  }

  const chunkCandidates = buildChunkCandidates(blocks);

  if (chunkCandidates.length === 0) {
    return {
      queryTokens,
      chunkCount: 0,
      matches: [],
    };
  }

  const queryTermFrequency = getTermFrequency(queryTokens);
  const documentFrequency = getDocumentFrequency(chunkCandidates);
  const averageDocumentLength =
    chunkCandidates.reduce((sum, chunk) => sum + chunk.tokenCount, 0) / chunkCandidates.length;
  const normalizedTitle = normalizeForPhrase(title);
  const queryBigrams = getBigrams(queryTokens);

  const scoredCandidates = chunkCandidates
    .map((chunk) => {
      let score = 0;

      for (const [term, queryFrequency] of queryTermFrequency.entries()) {
        const tf = chunk.tf.get(term) ?? 0;

        if (tf === 0) {
          continue;
        }

        const df = documentFrequency.get(term) ?? 0;

        if (df === 0) {
          continue;
        }

        const idf = Math.log(1 + (chunkCandidates.length - df + 0.5) / (df + 0.5));
        const normalization = 1 - B + B * (chunk.tokenCount / averageDocumentLength);
        const tfWeight = (tf * (K1 + 1)) / (tf + K1 * normalization);
        const queryWeight = 1 + Math.log1p(queryFrequency);

        score += idf * tfWeight * queryWeight;
      }

      score += computeBigramBoost(queryBigrams, chunk.tokens);
      score += computePhraseBoost(normalizedTitle, chunk.normalizedText);

      if (chunk.startsWithHeading) {
        score += 0.2;
      }

      return {
        ...chunk,
        score,
      };
    })
    .filter((chunk) => chunk.score > 0);

  const mergedByRange = new Map<string, (typeof scoredCandidates)[number]>();

  for (const chunk of scoredCandidates) {
    const key = `${chunk.startBlockIndex}-${chunk.endBlockIndex}`;
    const current = mergedByRange.get(key);

    if (!current || chunk.score > current.score) {
      mergedByRange.set(key, chunk);
    }
  }

  const sorted = Array.from(mergedByRange.values()).sort((a, b) => b.score - a.score);
  const selected: RankedArticleChunk[] = [];

  for (const candidate of sorted) {
    if (selected.some((match) => hasHighOverlap(candidate, match))) {
      continue;
    }

    selected.push({
      startBlockIndex: candidate.startBlockIndex,
      endBlockIndex: candidate.endBlockIndex,
      score: Number(candidate.score.toFixed(4)),
      text: candidate.text,
      snippet: toSnippet(candidate.text),
    });

    if (selected.length >= MAX_MATCHES) {
      break;
    }
  }

  return {
    queryTokens,
    chunkCount: chunkCandidates.length,
    matches: selected,
  };
}

function buildChunkCandidates(blocks: ArticleBodyBlock[]): ChunkCandidate[] {
  const candidates: ChunkCandidate[] = [];

  for (const windowSize of WINDOW_SIZES) {
    if (windowSize > blocks.length) {
      continue;
    }

    for (let start = 0; start <= blocks.length - windowSize; start += 1) {
      const end = start + windowSize - 1;
      const windowBlocks = blocks.slice(start, end + 1);
      const text = windowBlocks.map((block) => block.text).join(' ');
      const tokens = tokenize(text);

      if (tokens.length === 0) {
        continue;
      }

      candidates.push({
        startBlockIndex: start,
        endBlockIndex: end,
        text,
        normalizedText: normalizeForPhrase(text),
        tokens,
        tf: getTermFrequency(tokens),
        tokenCount: tokens.length,
        startsWithHeading: /^h[2-6]$/.test(windowBlocks[0].tagName),
      });
    }
  }

  return candidates;
}

function getTermFrequency(tokens: string[]): Map<string, number> {
  const termFrequency = new Map<string, number>();

  for (const token of tokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  return termFrequency;
}

function getDocumentFrequency(candidates: ChunkCandidate[]): Map<string, number> {
  const df = new Map<string, number>();

  for (const candidate of candidates) {
    const uniqueTokens = new Set(candidate.tokens);

    for (const token of uniqueTokens) {
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  }

  return df;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const matches = lower.match(/[a-z0-9]+(?:'[a-z0-9]+)?/g);

  if (!matches) {
    return [];
  }

  return matches.filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function normalizeForPhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function getBigrams(tokens: string[]): string[] {
  const bigrams: string[] = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    bigrams.push(`${tokens[index]} ${tokens[index + 1]}`);
  }

  return bigrams;
}

function computeBigramBoost(queryBigrams: string[], chunkTokens: string[]): number {
  if (queryBigrams.length === 0 || chunkTokens.length < 2) {
    return 0;
  }

  const chunkBigramSet = new Set(getBigrams(chunkTokens));
  let overlapCount = 0;

  for (const bigram of queryBigrams) {
    if (chunkBigramSet.has(bigram)) {
      overlapCount += 1;
    }
  }

  return overlapCount * 0.35;
}

function computePhraseBoost(normalizedTitle: string, normalizedChunk: string): number {
  if (!normalizedTitle || normalizedTitle.length < 8 || !normalizedChunk) {
    return 0;
  }

  if (normalizedChunk.includes(normalizedTitle)) {
    return 1.2;
  }

  return 0;
}

function hasHighOverlap(
  candidate: Pick<RankedArticleChunk, 'startBlockIndex' | 'endBlockIndex'>,
  existing: Pick<RankedArticleChunk, 'startBlockIndex' | 'endBlockIndex'>,
): boolean {
  const left = Math.max(candidate.startBlockIndex, existing.startBlockIndex);
  const right = Math.min(candidate.endBlockIndex, existing.endBlockIndex);

  if (left > right) {
    return false;
  }

  const overlap = right - left + 1;
  const candidateLength = candidate.endBlockIndex - candidate.startBlockIndex + 1;
  const existingLength = existing.endBlockIndex - existing.startBlockIndex + 1;
  const denominator = Math.min(candidateLength, existingLength);

  return overlap / denominator > 0.6;
}

function toSnippet(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (normalized.length <= 180) {
    return normalized;
  }

  return `${normalized.slice(0, 177)}...`;
}
