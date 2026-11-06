import { useEffect } from 'react';

/**
 * Names the browser tab after what's open (WCAG 2.4.2), most specific first and the app last:
 * "Goals – Lumby Pete – Wise Old Model".
 */
export function useDocumentTitle(...parts: string[]): void {
  const title = [...parts, 'Wise Old Model'].join(' – ');
  useEffect(() => {
    document.title = title;
  }, [title]);
}
