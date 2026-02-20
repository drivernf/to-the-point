import { extractArticleBody, type ArticleBodyExtractionResult } from '@/lib/article-body';
import { classifyCurrentPage, type ArticleDetectionResult } from '@/lib/article-detection';

type ArticlePageDetectionResult = ArticleDetectionResult & ArticleBodyExtractionResult;

declare global {
  interface Window {
    __toThePointArticleDetection?: ArticlePageDetectionResult;
  }
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main() {
    const baseDetection = classifyCurrentPage(document);
    const bodyExtraction: ArticleBodyExtractionResult = baseDetection.isArticle
      ? extractArticleBody(document)
      : {
          bodyText: null,
          bodyTextSource: null,
          bodyReasons: ['body:skipped:not-article'],
        };
    const detection: ArticlePageDetectionResult = {
      ...baseDetection,
      ...bodyExtraction,
    };

    window.__toThePointArticleDetection = detection;

    if (import.meta.env.COMMAND === 'serve') {
      console.debug('[to-the-point] article detection', detection);
    }
  },
});
