import { type Response, Router } from 'express';
import { HttpError } from '../http/errors.ts';
import { NotFoundError } from '../http/requester.ts';
import { type IconSource, type IconStore, itemIcon, wikiIcon } from '../sources/icons.ts';

async function serve(res: Response, store: IconStore, icon: IconSource | null): Promise<void> {
  if (!icon) throw new HttpError(400, "That isn't an icon's name.");
  let bytes: Uint8Array;
  try {
    bytes = await store.get(icon);
  } catch (error) {
    if (error instanceof NotFoundError) {
      // The site doesn't have it; the browser needn't ask again for a day.
      res.set('Cache-Control', 'public, max-age=86400');
      throw new HttpError(404, `There's no icon ${icon.file}.`);
    }
    throw error;
  }
  // An icon never changes once fetched, so the browser may keep it for good.
  res
    .set('Cache-Control', 'public, max-age=31536000, immutable')
    .type('png')
    .send(Buffer.from(bytes));
}

export function iconRoutes(store: IconStore): Router {
  const router = Router();
  router.get('/icons/wiki/:file', async (req, res) => {
    await serve(res, store, wikiIcon(req.params.file));
  });
  router.get('/icons/item/:id', async (req, res) => {
    await serve(res, store, itemIcon(req.params.id));
  });
  return router;
}
