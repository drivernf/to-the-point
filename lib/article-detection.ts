export type ArticleTitleSource = 'jsonld:headline' | 'meta:og:title' | 'meta:twitter:title';

export interface ArticleDetectionResult {
  isArticle: boolean;
  metadataMatched: boolean;
  title: string | null;
  titleSource: ArticleTitleSource | null;
  reasons: string[];
}

const GENERIC_TITLES = new Set([
  'home',
  'homepage',
  'index',
  'welcome',
  'untitled',
  'new tab',
  'page not found',
  '404',
  'not found',
]);

const TITLE_MIN_LENGTH = 12;
const TITLE_MAX_LENGTH = 220;

export function classifyCurrentPage(doc: Document = document): ArticleDetectionResult {
  const reasons: string[] = [];
  const jsonLdResult = inspectJsonLd(doc);

  if (jsonLdResult.hasArticleType) {
    reasons.push(...jsonLdResult.reasons);
  }

  const metaEntries = collectMetaEntries(doc);

  if (hasOgTypeArticle(metaEntries)) {
    reasons.push('meta:og:type=article');
  }

  if (hasArticleOpenGraphMeta(metaEntries)) {
    reasons.push('meta:article:*');
  }

  if (hasArticleMicrodata(doc)) {
    reasons.push('microdata:itemtype=*Article');
  }

  const metadataMatched = reasons.length > 0;
  const titleCandidate = extractTitleCandidate(metaEntries, jsonLdResult.headline);
  const title = isValidTitle(titleCandidate?.title ?? null) ? titleCandidate!.title : null;
  const titleSource = title ? titleCandidate!.source : null;

  return {
    isArticle: metadataMatched && Boolean(title),
    metadataMatched,
    title,
    titleSource,
    reasons,
  };
}

interface JsonLdInspectionResult {
  hasArticleType: boolean;
  headline: string | null;
  reasons: string[];
}

interface MetaEntry {
  key: string;
  content: string;
}

function inspectJsonLd(doc: Document): JsonLdInspectionResult {
  const scripts = Array.from(doc.querySelectorAll('script[type*="ld+json"]'));
  const reasons: string[] = [];
  let headline: string | null = null;
  let hasArticleType = false;

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
      const normalizedTypes = extractNormalizedTypes(node);
      const articleType = normalizedTypes.find(isArticleSchemaType);

      if (!articleType) {
        continue;
      }

      hasArticleType = true;
      reasons.push(`jsonld:@type=${articleType}`);

      if (!headline) {
        const candidateHeadline = normalizeTitle(getStringValue(node.headline));

        if (isValidTitle(candidateHeadline)) {
          headline = candidateHeadline;
        }
      }
    }
  }

  return {
    hasArticleType,
    headline,
    reasons,
  };
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

function collectMetaEntries(doc: Document): MetaEntry[] {
  const tags = Array.from(doc.querySelectorAll('meta'));

  return tags
    .map((tag) => {
      const rawKey = tag.getAttribute('property') ?? tag.getAttribute('name') ?? '';
      const content = (tag.getAttribute('content') ?? '').trim();

      return {
        key: rawKey.trim().toLowerCase(),
        content,
      };
    })
    .filter((entry) => Boolean(entry.key));
}

function hasOgTypeArticle(metaEntries: MetaEntry[]): boolean {
  return metaEntries.some((entry) => entry.key === 'og:type' && entry.content.toLowerCase() === 'article');
}

function hasArticleOpenGraphMeta(metaEntries: MetaEntry[]): boolean {
  return metaEntries.some((entry) => entry.key.startsWith('article:') && Boolean(entry.content));
}

function hasArticleMicrodata(doc: Document): boolean {
  const nodes = Array.from(doc.querySelectorAll('[itemtype]'));

  for (const node of nodes) {
    const itemtype = node.getAttribute('itemtype');

    if (!itemtype) {
      continue;
    }

    const itemTypes = itemtype.split(/\s+/);

    for (const rawType of itemTypes) {
      const normalizedType = normalizeSchemaType(rawType);

      if (isArticleSchemaType(normalizedType)) {
        return true;
      }
    }
  }

  return false;
}

function extractTitleCandidate(
  metaEntries: MetaEntry[],
  jsonLdHeadline: string | null,
): { title: string; source: ArticleTitleSource } | null {
  if (jsonLdHeadline && isValidTitle(jsonLdHeadline)) {
    return {
      title: jsonLdHeadline,
      source: 'jsonld:headline',
    };
  }

  const ogTitle = normalizeTitle(findMetaContent(metaEntries, ['og:title']));

  if (ogTitle && isValidTitle(ogTitle)) {
    return {
      title: ogTitle,
      source: 'meta:og:title',
    };
  }

  const twitterTitle = normalizeTitle(findMetaContent(metaEntries, ['twitter:title']));

  if (twitterTitle && isValidTitle(twitterTitle)) {
    return {
      title: twitterTitle,
      source: 'meta:twitter:title',
    };
  }

  return null;
}

function findMetaContent(metaEntries: MetaEntry[], keys: string[]): string | null {
  for (const key of keys) {
    const match = metaEntries.find((entry) => entry.key === key && Boolean(entry.content));

    if (match) {
      return match.content;
    }
  }

  return null;
}

function normalizeTitle(rawTitle: string | null): string | null {
  if (!rawTitle) {
    return null;
  }

  const collapsed = rawTitle.replace(/\s+/g, ' ').trim();

  if (!collapsed) {
    return null;
  }

  return stripCommonSiteSuffix(collapsed);
}

function stripCommonSiteSuffix(title: string): string {
  for (const separator of [' | ', ' - ']) {
    const separatorIndex = title.lastIndexOf(separator);

    if (separatorIndex <= 0) {
      continue;
    }

    const left = title.slice(0, separatorIndex).trim();
    const right = title.slice(separatorIndex + separator.length).trim();

    if (left.length >= TITLE_MIN_LENGTH && right.length > 0 && right.length <= 40) {
      return left;
    }
  }

  return title;
}

function isValidTitle(title: string | null): boolean {
  if (!title) {
    return false;
  }

  const normalized = title.trim();

  if (normalized.length < TITLE_MIN_LENGTH || normalized.length > TITLE_MAX_LENGTH) {
    return false;
  }

  const lower = normalized.toLowerCase();

  if (GENERIC_TITLES.has(lower)) {
    return false;
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return false;
  }

  return true;
}

function getStringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
