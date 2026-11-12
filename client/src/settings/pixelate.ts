/** A picture's pixels, four bytes each (red, green, blue, alpha), row by row, as canvases hold them. */
export type Pixels = { width: number; height: number; data: Uint8ClampedArray<ArrayBuffer> };

/** The square of a picture to keep: its top-left corner and side, which may reach past the edges. */
export type Crop = { x: number; y: number; side: number };

/**
 * Shrinks a square of a picture to size × size pixels, each the average of the block it covers:
 * a pixel the block's edge cuts through counts by how much of it falls inside, and anything past
 * the picture's edges is see-through. See-through pixels add nothing to the color, and a block
 * less than half covered is left see-through, so the result has clean edges like pixel art.
 */
export function pixelate(source: Pixels, crop: Crop, size: number): Pixels {
  const data = new Uint8ClampedArray(size * size * 4);
  const block = crop.side / size;
  for (let row = 0; row < size; row++) {
    const top = crop.y + row * block;
    const bottom = top + block;
    for (let column = 0; column < size; column++) {
      const left = crop.x + column * block;
      const right = left + block;
      let red = 0;
      let green = 0;
      let blue = 0;
      let cover = 0;
      for (let y = Math.max(0, Math.floor(top)); y < Math.min(source.height, bottom); y++) {
        const height = Math.min(y + 1, bottom) - Math.max(y, top);
        for (let x = Math.max(0, Math.floor(left)); x < Math.min(source.width, right); x++) {
          const at = (y * source.width + x) * 4;
          const weight = (Math.min(x + 1, right) - Math.max(x, left)) * height;
          const alpha = ((source.data[at + 3] ?? 0) / 255) * weight;
          red += (source.data[at] ?? 0) * alpha;
          green += (source.data[at + 1] ?? 0) * alpha;
          blue += (source.data[at + 2] ?? 0) * alpha;
          cover += alpha;
        }
      }
      if (cover / (block * block) < 0.5) continue;
      const at = (row * size + column) * 4;
      data.set([red / cover, green / cover, blue / cover, 255].map(Math.round), at);
    }
  }
  return { width: size, height: size, data };
}

/**
 * The square holding a character's head in a wiki chathead picture: from the top, centred, and
 * 1.28 times as wide as the picture, which in the Wise Old Man's (78 × 148) takes in his hat, his
 * specs and the top of his beard, leaving the rest of the beard out.
 */
export function headCrop(width: number, height: number): Crop {
  const side = Math.min(height, Math.round(width * 1.28));
  return { x: (width - side) / 2, y: 0, side };
}

/** Each pixel made a scale × scale square of them, so the browser has no in-betweens to blur. */
export function enlarge(source: Pixels, scale: number): Pixels {
  const width = source.width * scale;
  const height = source.height * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = (Math.floor(y / scale) * source.width + Math.floor(x / scale)) * 4;
      data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/**
 * A picture from this site, pixelated (see pixelate) to size × size and enlarged by scale, as a
 * PNG data URL. It fails if the picture can't be loaded or the browser can't draw.
 */
export async function pixelatedPicture(
  url: string,
  crop: (width: number, height: number) => Crop,
  size: number,
  scale: number,
): Promise<string> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const { naturalWidth: width, naturalHeight: height } = image;
  const source = canvas(width, height);
  source.context.drawImage(image, 0, 0);
  const pixels = pixelate(
    source.context.getImageData(0, 0, width, height),
    crop(width, height),
    size,
  );
  const big = enlarge(pixels, scale);
  const out = canvas(big.width, big.height);
  out.context.putImageData(new ImageData(big.data, big.width, big.height), 0, 0);
  return out.element.toDataURL('image/png');
}

function canvas(width: number, height: number) {
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  const context = element.getContext('2d');
  if (!context) throw new Error("This browser can't draw pictures.");
  return { element, context };
}
