import { classifyCurrentPage, type ArticleDetectionResult } from '@/lib/article-detection';

declare global {
  interface Window {
    __toThePointArticleDetection?: ArticleDetectionResult;
  }
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_idle',
  main() {
    const detection = classifyCurrentPage(document);
    window.__toThePointArticleDetection = detection;

    if (import.meta.env.COMMAND === 'serve') {
      console.debug('[to-the-point] article detection', detection);
    }
  },
});
