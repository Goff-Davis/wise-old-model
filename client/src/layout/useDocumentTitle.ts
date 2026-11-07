import { useEffect } from 'react';

/**
 * Names the browser tab after what's open (WCAG 2.4.2), most specific first and the app last:
 * "Goals – Lumby Pete – Wise Old Model". A part not known yet (false or undefined) is left out.
 */
export function useDocumentTitle(...parts: (string | false | undefined)[]): void {
  const title = [...parts.filter(Boolean), 'Wise Old Model'].join(' – ');
  useEffect(() => {
    document.title = title;
  }, [title]);
}
