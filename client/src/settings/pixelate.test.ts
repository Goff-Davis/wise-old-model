import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enlarge, headCrop, type Pixels, pixelate, pixelatedPicture } from './pixelate.ts';

/** A picture from its pixels, each [red, green, blue, alpha], row by row. */
const picture = (width: number, height: number, pixels: number[][]) => ({
  width,
  height,
  data: new Uint8ClampedArray(pixels.flat()),
});

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

describe('pixelate', () => {
  it('averages each block of the crop into one pixel', () => {
    const source = picture(2, 2, [RED, RED, BLUE, BLUE]);
    const out = pixelate(source, { x: 0, y: 0, side: 2 }, 1);
    expect(out).toMatchObject({ width: 1, height: 1 });
    expect([...out.data]).toEqual([128, 0, 128, 255]);
  });

  it('leaves see-through pixels out of the color, and keeps a block mostly covered', () => {
    const source = picture(2, 2, [WHITE, WHITE, WHITE, CLEAR]);
    expect([...pixelate(source, { x: 0, y: 0, side: 2 }, 1).data]).toEqual(WHITE);
  });

  it('weighs a part see-through pixel by how much of it there is', () => {
    const faint = [0, 0, 255, 85];
    const source = picture(2, 2, [RED, RED, faint, faint]);
    expect([...pixelate(source, { x: 0, y: 0, side: 2 }, 1).data]).toEqual([191, 0, 64, 255]);
  });

  it('keeps a block exactly half covered', () => {
    const source = picture(2, 2, [WHITE, WHITE, CLEAR, CLEAR]);
    expect([...pixelate(source, { x: 0, y: 0, side: 2 }, 1).data]).toEqual(WHITE);
  });

  it('makes a block less than half covered see-through', () => {
    const source = picture(2, 2, [WHITE, CLEAR, CLEAR, CLEAR]);
    expect([...pixelate(source, { x: 0, y: 0, side: 2 }, 1).data]).toEqual(CLEAR);
  });

  it("counts what lies past the picture's edges as see-through", () => {
    // Past the left edge isn't the end of the row above (blue), and past the bottom is nothing.
    const source = picture(2, 2, [RED, BLUE, RED, BLUE]);
    const out = pixelate(source, { x: -1, y: 1, side: 2 }, 2);
    expect([...out.data]).toEqual([...CLEAR, ...RED, ...CLEAR, ...CLEAR]);
  });

  it('shares a pixel that a block edge cuts through by how much of it falls in each block', () => {
    const source = picture(3, 3, [RED, GREEN, BLUE, RED, GREEN, BLUE, RED, GREEN, BLUE]);
    const out = pixelate(source, { x: 0, y: 0, side: 3 }, 2);
    // The top-left block holds 1 column of red and half a column of green.
    expect([...out.data.slice(0, 4)]).toEqual([170, 85, 0, 255]);
    expect([...out.data.slice(4, 8)]).toEqual([0, 85, 170, 255]);
  });
});

describe('headCrop', () => {
  it('takes a square from the top, wider than the picture and centred on it', () => {
    expect(headCrop(78, 148)).toEqual({ x: -11, y: 0, side: 100 });
  });

  it('is never taller than the picture', () => {
    expect(headCrop(100, 60)).toEqual({ x: 20, y: 0, side: 60 });
  });
});

describe('enlarge', () => {
  it('turns each pixel into a square of them', () => {
    const big = enlarge(picture(2, 1, [RED, BLUE]), 2);
    expect(big).toMatchObject({ width: 4, height: 2 });
    const row = [...RED, ...RED, ...BLUE, ...BLUE];
    expect([...big.data]).toEqual([...row, ...row]);
  });
});

describe('pixelatedPicture', () => {
  // jsdom loads no pictures and draws nothing, so the picture, its size and the canvas are
  // stand-ins: the picture is 2 wide and 3 tall, red over blue over nothing.
  const decode = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
  const PICTURE = picture(2, 3, [RED, RED, BLUE, BLUE, CLEAR, CLEAR]);
  let drawn: (string | null)[] = [];
  let put: Pixels | undefined;

  const loads = (outcome: () => Promise<void>) =>
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      writable: true,
      value: outcome,
    });

  beforeEach(() => {
    drawn = [];
    put = undefined;
    loads(() => Promise.resolve());
    vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(2);
    vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(3);
    vi.stubGlobal(
      'ImageData',
      class {
        data: Uint8ClampedArray<ArrayBuffer>;
        width: number;
        height: number;
        constructor(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) {
          this.data = data;
          this.width = width;
          this.height = height;
        }
      },
    );
    const context = {
      drawImage: (image: HTMLImageElement) => drawn.push(image.getAttribute('src')),
      getImageData: () => PICTURE,
      putImageData: (pixels: Pixels) => {
        put = pixels;
      },
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as RenderingContext,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      return `data:image/png;${this.width}x${this.height}`;
    });
  });

  afterEach(() => {
    if (decode) Object.defineProperty(HTMLImageElement.prototype, 'decode', decode);
    else delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('draws the picture, pixelates its crop and gives it back enlarged, as a PNG', async () => {
    const crop = vi.fn(() => ({ x: 0, y: 0, side: 2 }));
    const href = await pixelatedPicture('/api/icons/wiki/Example.png', crop, 1, 2);
    expect(drawn).toEqual(['/api/icons/wiki/Example.png']);
    expect(crop).toHaveBeenCalledWith(2, 3);
    expect(put).toMatchObject({ width: 2, height: 2 });
    const purple = [128, 0, 128, 255];
    expect([...(put?.data ?? [])]).toEqual([...purple, ...purple, ...purple, ...purple]);
    expect(href).toBe('data:image/png;2x2');
  });

  it("fails when the picture can't be loaded", async () => {
    loads(() => Promise.reject(new Error('The source image cannot be decoded.')));
    await expect(pixelatedPicture('/api/icons/wiki/Gone.png', headCrop, 16, 2)).rejects.toThrow(
      'The source image cannot be decoded.',
    );
    expect(drawn).toEqual([]);
  });

  it("fails when the browser can't draw", async () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    await expect(pixelatedPicture('/api/icons/wiki/Example.png', headCrop, 16, 2)).rejects.toThrow(
      "This browser can't draw pictures.",
    );
  });
});
