export type ArticleBodySource = 'jsonld:articleBody' | 'dom:itemprop:articleBody' | 'dom:scored-container';

export interface ArticleBodyExtractionResult {
  bodyText: string | null;
  bodyTextSource: ArticleBodySource | null;
  bodyReasons: string[];
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
}

interface CandidateScore {
  element: Element;
  blocks: ExtractedBlock[];
  score: number;
  textLength: number;
}

export function extractArticleBody(doc: Document = document): ArticleBodyExtractionResult {
  const jsonLdBody = extractJsonLdArticleBody(doc);

  if (jsonLdBody) {
    return {
      bodyText: jsonLdBody,
      bodyTextSource: 'jsonld:articleBody',
      bodyReasons: ['body:jsonld:articleBody'],
    };
  }

  const itempropBody = extractBodyFromItemprop(doc);

  if (itempropBody) {
    return {
      bodyText: itempropBody,
      bodyTextSource: 'dom:itemprop:articleBody',
      bodyReasons: ['body:dom:itemprop=articleBody'],
    };
  }

  const scoredBody = extractBodyFromBestContainer(doc);

  if (scoredBody) {
    return {
      bodyText: scoredBody.bodyText,
      bodyTextSource: 'dom:scored-container',
      bodyReasons: [
        `body:dom:scored-container:score=${Math.round(scoredBody.score)}`,
        `body:dom:scored-container:length=${scoredBody.bodyText.length}`,
      ],
    };
  }

  return {
    bodyText: null,
    bodyTextSource: null,
    bodyReasons: ['body:not-found'],
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

      if (isValidBodyText(normalized)) {
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

function extractBodyFromItemprop(doc: Document): string | null {
  const nodes = Array.from(doc.querySelectorAll('[itemprop="articleBody"]'));

  if (nodes.length === 0) {
    return null;
  }

  const rootNodes = nodes.filter((node) => !node.parentElement?.closest('[itemprop="articleBody"]'));
  const blocks = dedupeBlocks(rootNodes.flatMap((node) => extractBlocksFromContainer(node)));
  const bodyText = joinBlocks(blocks);

  if (!isValidBodyText(bodyText, blocks.length)) {
    return null;
  }

  return bodyText;
}

function extractBodyFromBestContainer(doc: Document): { bodyText: string; score: number } | null {
  const candidates = collectCandidateContainers(doc);
  const scoredCandidates: CandidateScore[] = [];

  for (const candidate of candidates) {
    const blocks = dedupeBlocks(extractBlocksFromContainer(candidate));

    if (blocks.length === 0) {
      continue;
    }

    const bodyText = joinBlocks(blocks);
    const textLength = bodyText.length;

    if (textLength < MIN_BODY_CHARS) {
      continue;
    }

    const score = scoreCandidate(candidate, blocks, textLength);
    scoredCandidates.push({
      element: candidate,
      blocks,
      score,
      textLength,
    });
  }

  if (scoredCandidates.length === 0) {
    return null;
  }

  scoredCandidates.sort((a, b) => b.score - a.score);
  const best = scoredCandidates[0];
  const bestText = joinBlocks(best.blocks);

  if (!isValidBodyText(bestText, best.blocks.length)) {
    return null;
  }

  return {
    bodyText: bestText,
    score: best.score,
  };
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

    if (!container.contains(node)) {
      continue;
    }

    const text = normalizeInlineText(node.textContent);

    if (!text) {
      continue;
    }

    if (isLikelyBoilerplate(text)) {
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
    });
  }

  return blocks;
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

function joinBlocks(blocks: ExtractedBlock[]): string {
  return blocks.map((block) => block.text).join('\n\n');
}

function isValidBodyText(bodyText: string | null, blockCount = MIN_DOM_BLOCKS): boolean {
  if (!bodyText) {
    return false;
  }

  if (bodyText.length < MIN_BODY_CHARS) {
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
