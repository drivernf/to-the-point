export type ArticleBodySource = 'jsonld:articleBody' | 'dom:itemprop:articleBody' | 'dom:scored-container';

export interface ArticleBodyExtractionResult {
  bodyText: string | null;
  bodyTextSource: ArticleBodySource | null;
  bodyReasons: string[];
}

export interface ArticleBodyBlock {
  index: number;
  text: string;
  tagName: string;
  element: Element;
}

export interface ArticleDomBlocksResult {
  blocks: ArticleBodyBlock[];
  source: Exclude<ArticleBodySource, 'jsonld:articleBody'> | null;
  reasons: string[];
}

const BLOCK_SELECTOR = 'p, h2, h3, h4, h5, h6, blockquote, li';
const EXCLUDED_SELECTOR =
  'nav, header, footer, aside, form, script, style, noscript, svg, canvas, iframe, button, input, select, textarea';

const MIN_BODY_CHARS = 250;
const MIN_DOM_BLOCKS = 3;

const BOILERPLATE_PATTERNS = [
  /^read more\b/i,
  /^related\b/i,
  /^recommended\b/i,
  /^advertisement\b/i,
  /^sponsored\b/i,
  /^sign up\b/i,
  /^subscribe\b/i,
  /^share\b/i,
  /^follow us\b/i,
  /^copyright\b/i,
  /^all rights reserved\b/i,
];

interface ExtractedBlock {
  text: string;
  tagName: string;
  element: Element;
}

interface CandidateScore {
  element: Element;
  blocks: ExtractedBlock[];
  score: number;
}

export function extractArticleBody(doc: Document = document): ArticleBodyExtractionResult {
  const jsonLdBody = extractJsonLdArticleBody(doc);

  if (isValidJsonLdBodyText(jsonLdBody)) {
    return {
      bodyText: jsonLdBody,
      bodyTextSource: 'jsonld:articleBody',
      bodyReasons: ['body:jsonld:articleBody'],
    };
  }

  const domBlocksResult = extractArticleDomBlocks(doc);
  const domBodyText = joinBlocks(domBlocksResult.blocks);

  if (domBlocksResult.source && isValidDomBodyText(domBodyText, domBlocksResult.blocks.length)) {
    return {
      bodyText: domBodyText,
      bodyTextSource: domBlocksResult.source,
      bodyReasons: domBlocksResult.reasons,
    };
  }

  return {
    bodyText: null,
    bodyTextSource: null,
    bodyReasons: ['body:not-found'],
  };
}

export function extractArticleDomBlocks(doc: Document = document): ArticleDomBlocksResult {
  const itempropBlocks = extractBlocksFromItemprop(doc);

  if (isValidDomBodyText(joinBlocks(itempropBlocks), itempropBlocks.length)) {
    return {
      blocks: toArticleBodyBlocks(itempropBlocks),
      source: 'dom:itemprop:articleBody',
      reasons: ['body:dom:itemprop=articleBody'],
    };
  }

  const scoredCandidate = extractBestScoredCandidate(doc);

  if (scoredCandidate) {
    const blocks = toArticleBodyBlocks(scoredCandidate.blocks);

    if (isValidDomBodyText(joinBlocks(blocks), blocks.length)) {
      return {
        blocks,
        source: 'dom:scored-container',
        reasons: [
          `body:dom:scored-container:score=${Math.round(scoredCandidate.score)}`,
          `body:dom:scored-container:length=${joinBlocks(blocks).length}`,
        ],
      };
    }
  }

  return {
    blocks: [],
    source: null,
    reasons: ['body:dom:not-found'],
  };
}

function extractJsonLdArticleBody(doc: Document): string | null {
  const scripts = Array.from(doc.querySelectorAll('script[type*="ld+json"]'));

  for (const script of scripts) {
    const text = script.textContent?.trim();

    if (!text) {
      continue;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }

    const nodes: Record<string, unknown>[] = [];
    collectJsonLdNodes(parsed, nodes);

    for (const node of nodes) {
      const typeNames = extractNormalizedTypes(node);

      if (!typeNames.some(isArticleSchemaType)) {
        continue;
      }

      const articleBody = getJsonLdArticleBody(node);

      if (!articleBody) {
        continue;
      }

      const normalized = normalizeParagraphText(articleBody);

      if (isValidJsonLdBodyText(normalized)) {
        return normalized;
      }
    }
  }

  return null;
}

function getJsonLdArticleBody(node: Record<string, unknown>): string | null {
  const value = node.articleBody;

  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const lines = value.filter((item): item is string => typeof item === 'string');

    return lines.length > 0 ? lines.join('\n\n') : null;
  }

  return null;
}

function extractBlocksFromItemprop(doc: Document): ExtractedBlock[] {
  const nodes = Array.from(doc.querySelectorAll('[itemprop="articleBody"]'));

  if (nodes.length === 0) {
    return [];
  }

  const rootNodes = nodes.filter((node) => !node.parentElement?.closest('[itemprop="articleBody"]'));

  return dedupeBlocks(rootNodes.flatMap((node) => extractBlocksFromContainer(node)));
}

function extractBestScoredCandidate(doc: Document): CandidateScore | null {
  const candidates = collectCandidateContainers(doc);
  const scoredCandidates: CandidateScore[] = [];

  for (const candidate of candidates) {
    const blocks = dedupeBlocks(extractBlocksFromContainer(candidate));

    if (blocks.length === 0) {
      continue;
    }

    const bodyText = joinBlocks(blocks);

    if (!isValidDomBodyText(bodyText, blocks.length)) {
      continue;
    }

    scoredCandidates.push({
      element: candidate,
      blocks,
      score: scoreCandidate(candidate, blocks, bodyText.length),
    });
  }

  if (scoredCandidates.length === 0) {
    return null;
  }

  scoredCandidates.sort((a, b) => b.score - a.score);

  return scoredCandidates[0];
}

function collectCandidateContainers(doc: Document): Element[] {
  const ordered = new Set<Element>();

  for (const selector of ['article', '[itemprop="articleBody"]', 'main', '[role="main"]']) {
    for (const element of doc.querySelectorAll(selector)) {
      ordered.add(element);
    }
  }

  const paragraphContainers = new Map<Element, number>();
  const paragraphs = Array.from(doc.querySelectorAll('p'));

  for (const paragraph of paragraphs) {
    if (paragraph.closest(EXCLUDED_SELECTOR)) {
      continue;
    }

    const container = paragraph.closest('article, main, section, div, [role="main"]');

    if (!container || container === doc.body) {
      continue;
    }

    paragraphContainers.set(container, (paragraphContainers.get(container) ?? 0) + 1);
  }

  const ranked = Array.from(paragraphContainers.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  for (const [element] of ranked) {
    ordered.add(element);
  }

  return Array.from(ordered);
}

function extractBlocksFromContainer(container: Element): ExtractedBlock[] {
  const nodes = Array.from(container.querySelectorAll(BLOCK_SELECTOR));
  const blocks: ExtractedBlock[] = [];

  for (const node of nodes) {
    if (node.closest(EXCLUDED_SELECTOR)) {
      continue;
    }

    const text = normalizeInlineText(node.textContent);

    if (!text || isLikelyBoilerplate(text)) {
      continue;
    }

    const tagName = node.tagName.toLowerCase();
    const minLength = tagName === 'li' ? 8 : tagName.startsWith('h') ? 10 : 20;

    if (text.length < minLength) {
      continue;
    }

    blocks.push({
      text,
      tagName,
      element: node,
    });
  }

  return blocks;
}

function toArticleBodyBlocks(blocks: ExtractedBlock[]): ArticleBodyBlock[] {
  return blocks.map((block, index) => ({
    index,
    text: block.text,
    tagName: block.tagName,
    element: block.element,
  }));
}

function dedupeBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  const seen = new Set<string>();
  const deduped: ExtractedBlock[] = [];

  for (const block of blocks) {
    const key = block.text.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(block);
  }

  return deduped;
}

function scoreCandidate(candidate: Element, blocks: ExtractedBlock[], textLength: number): number {
  const paragraphCount = blocks.filter((block) => block.tagName === 'p').length;
  const headingCount = blocks.filter((block) => block.tagName.startsWith('h')).length;
  const listItemCount = blocks.filter((block) => block.tagName === 'li').length;
  const blockquoteCount = blocks.filter((block) => block.tagName === 'blockquote').length;
  const boilerplateHits = blocks.filter((block) => isLikelyBoilerplate(block.text)).length;
  const linkDensity = computeLinkDensity(candidate);

  let score = textLength;
  score += paragraphCount * 180;
  score += headingCount * 60;
  score += listItemCount * 30;
  score += blockquoteCount * 90;
  score -= Math.round(linkDensity * 1200);
  score -= boilerplateHits * 250;

  if (candidate.matches('article, [itemprop="articleBody"]')) {
    score += 500;
  }

  if (candidate.matches('main, [role="main"]')) {
    score += 250;
  }

  return score;
}

function computeLinkDensity(container: Element): number {
  const totalTextLength = normalizeInlineText(container.textContent).length;

  if (totalTextLength === 0) {
    return 0;
  }

  const links = Array.from(container.querySelectorAll('a'));
  const linkTextLength = links.reduce((sum, link) => sum + normalizeInlineText(link.textContent).length, 0);

  return linkTextLength / totalTextLength;
}

function joinBlocks(blocks: Pick<ArticleBodyBlock, 'text'>[] | Pick<ExtractedBlock, 'text'>[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

function isValidJsonLdBodyText(bodyText: string | null): boolean {
  if (!bodyText) {
    return false;
  }

  return bodyText.length >= MIN_BODY_CHARS;
}

function isValidDomBodyText(bodyText: string | null, blockCount: number): boolean {
  if (!bodyText || bodyText.length < MIN_BODY_CHARS) {
    return false;
  }

  return blockCount >= MIN_DOM_BLOCKS;
}

function normalizeInlineText(rawText: string | null): string {
  if (!rawText) {
    return '';
  }

  return rawText.replace(/\s+/g, ' ').trim();
}

function normalizeParagraphText(rawText: string): string {
  const lines = rawText
    .replace(/\r\n/g, '\n')
    .split(/\n{1,}/)
    .map(normalizeInlineText)
    .filter((line) => line.length > 0)
    .filter((line) => !isLikelyBoilerplate(line));

  return lines.join('\n\n');
}

function isLikelyBoilerplate(text: string): boolean {
  return BOILERPLATE_PATTERNS.some((pattern) => pattern.test(text));
}

function collectJsonLdNodes(value: unknown, nodes: Record<string, unknown>[]): void {
  if (!value) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLdNodes(item, nodes);
    }

    return;
  }

  if (typeof value !== 'object') {
    return;
  }

  const node = value as Record<string, unknown>;
  nodes.push(node);

  if (Array.isArray(node['@graph'])) {
    collectJsonLdNodes(node['@graph'], nodes);
  }
}

function extractNormalizedTypes(node: Record<string, unknown>): string[] {
  const rawType = node['@type'];

  if (typeof rawType === 'string') {
    return [normalizeSchemaType(rawType)].filter(Boolean);
  }

  if (Array.isArray(rawType)) {
    return rawType
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeSchemaType)
      .filter(Boolean);
  }

  return [];
}

function normalizeSchemaType(rawType: string): string {
  const trimmed = rawType.trim();

  if (!trimmed) {
    return '';
  }

  const slashPart = trimmed.split('/').pop() ?? trimmed;
  const hashPart = slashPart.split('#').pop() ?? slashPart;
  const colonPart = hashPart.split(':').pop() ?? hashPart;

  return colonPart.trim();
}

function isArticleSchemaType(typeName: string): boolean {
  if (!typeName) {
    return false;
  }

  return typeName.endsWith('Article') || typeName === 'BlogPosting' || typeName === 'LiveBlogPosting';
}
