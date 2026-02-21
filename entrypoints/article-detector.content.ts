import {
  extractArticleBody,
  extractArticleDomBlocks,
  type ArticleBodyBlock,
  type ArticleBodyExtractionResult,
} from '@/lib/article-body';
import { classifyCurrentPage, type ArticleDetectionResult } from '@/lib/article-detection';
import { rankTitleAgainstBlocks, type RankedArticleChunk } from '@/lib/title-ranker';

interface RankingSnapshot {
  matchCount: number;
  topMatchSnippet: string | null;
  topMatchScore: number | null;
}

type ArticlePageDetectionResult = ArticleDetectionResult & ArticleBodyExtractionResult & RankingSnapshot;

const NAV_ID = 'to-the-point-nav';
const STYLE_ID = 'to-the-point-style';
const HIGHLIGHT_CLASS = 'to-the-point-highlight';

declare global {
  interface Window {
    __toThePointArticleDetection?: ArticlePageDetectionResult;
  }
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main() {
    removeNavigator(document);
    clearHighlights(document);

    const baseDetection = classifyCurrentPage(document);
    const bodyExtraction: ArticleBodyExtractionResult = baseDetection.isArticle
      ? extractArticleBody(document)
      : {
          bodyText: null,
          bodyTextSource: null,
          bodyReasons: ['body:skipped:not-article'],
        };

    let rankedMatches: RankedArticleChunk[] = [];

    if (baseDetection.isArticle && baseDetection.title) {
      const domBlocksResult = extractArticleDomBlocks(document);

      if (domBlocksResult.blocks.length > 0) {
        rankedMatches = rankTitleAgainstBlocks(baseDetection.title, domBlocksResult.blocks).matches;

        if (rankedMatches.length > 0) {
          mountNavigator(document, domBlocksResult.blocks, rankedMatches);
        }
      }
    }

    const detection: ArticlePageDetectionResult = {
      ...baseDetection,
      ...bodyExtraction,
      matchCount: rankedMatches.length,
      topMatchSnippet: rankedMatches[0]?.snippet ?? null,
      topMatchScore: rankedMatches[0]?.score ?? null,
    };

    window.__toThePointArticleDetection = detection;

    if (import.meta.env.COMMAND === 'serve') {
      console.debug('[to-the-point] article detection', detection);
    }
  },
});

function mountNavigator(doc: Document, blocks: ArticleBodyBlock[], matches: RankedArticleChunk[]): void {
  injectStyles(doc);
  removeNavigator(doc);

  if (matches.length === 0 || !doc.body) {
    return;
  }

  const nav = doc.createElement('div');
  nav.id = NAV_ID;

  const title = doc.createElement('div');
  title.textContent = 'to the point';
  title.className = 'to-the-point-title';

  const status = doc.createElement('div');
  status.className = 'to-the-point-status';

  const controls = doc.createElement('div');
  controls.className = 'to-the-point-controls';

  const topButton = createButton(doc, 'Top match');
  const prevButton = createButton(doc, 'Prev');
  const nextButton = createButton(doc, 'Next');

  controls.append(topButton, prevButton, nextButton);
  nav.append(title, status, controls);

  doc.body.append(nav);

  let currentMatchIndex = 0;
  let highlightedElements: Element[] = [];

  const applyMatch = (nextIndex: number) => {
    if (matches.length === 0) {
      return;
    }

    const normalizedIndex = normalizeMatchIndex(nextIndex, matches.length);
    const match = matches[normalizedIndex];
    const elements = getMatchElements(blocks, match);

    for (const element of highlightedElements) {
      element.classList.remove(HIGHLIGHT_CLASS);
    }

    for (const element of elements) {
      element.classList.add(HIGHLIGHT_CLASS);
    }

    highlightedElements = elements;
    currentMatchIndex = normalizedIndex;
    status.textContent = `match ${currentMatchIndex + 1} / ${matches.length}`;

    const anchor = elements[0];

    if (anchor) {
      anchor.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
    }
  };

  topButton.addEventListener('click', () => applyMatch(0));
  prevButton.addEventListener('click', () => applyMatch(currentMatchIndex - 1));
  nextButton.addEventListener('click', () => applyMatch(currentMatchIndex + 1));

  applyMatch(0);
}

function createButton(doc: Document, label: string): HTMLButtonElement {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'to-the-point-button';
  button.textContent = label;

  return button;
}

function getMatchElements(blocks: ArticleBodyBlock[], match: RankedArticleChunk): Element[] {
  const unique = new Set<Element>();

  for (let index = match.startBlockIndex; index <= match.endBlockIndex; index += 1) {
    const block = blocks[index];

    if (!block) {
      continue;
    }

    unique.add(block.element);
  }

  return Array.from(unique);
}

function normalizeMatchIndex(nextIndex: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return ((nextIndex % total) + total) % total;
}

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) {
    return;
  }

  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${NAV_ID} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 220px;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid rgba(27, 45, 52, 0.28);
      background: rgba(245, 239, 228, 0.95);
      color: #1b2d34;
      font-family: Georgia, 'Times New Roman', serif;
      box-shadow: 0 14px 32px rgba(21, 31, 35, 0.2);
      backdrop-filter: blur(8px);
    }

    #${NAV_ID} .to-the-point-title {
      font-size: 14px;
      letter-spacing: 0.03em;
      text-transform: lowercase;
      font-weight: 700;
    }

    #${NAV_ID} .to-the-point-status {
      font-size: 13px;
      opacity: 0.86;
    }

    #${NAV_ID} .to-the-point-controls {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }

    #${NAV_ID} .to-the-point-button {
      border: 1px solid rgba(27, 45, 52, 0.36);
      border-radius: 8px;
      padding: 7px 8px;
      background: #fffdf8;
      color: #1b2d34;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
    }

    #${NAV_ID} .to-the-point-button:hover {
      background: #f1e4ca;
    }

    .${HIGHLIGHT_CLASS} {
      background: rgba(255, 227, 122, 0.35);
      border-radius: 4px;
      box-shadow: inset 0 0 0 1px rgba(150, 106, 0, 0.25);
      scroll-margin-top: 88px;
      transition: background-color 180ms ease;
    }
  `;

  if (doc.head) {
    doc.head.append(style);
    return;
  }

  doc.documentElement.append(style);
}

function removeNavigator(doc: Document): void {
  doc.getElementById(NAV_ID)?.remove();
}

function clearHighlights(doc: Document): void {
  for (const element of doc.querySelectorAll(`.${HIGHLIGHT_CLASS}`)) {
    element.classList.remove(HIGHLIGHT_CLASS);
  }
}
