import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Tilt } from './Tilt';
import { MAX_TILT, clampIntensity, specularStyle, tiltFromPointer, tiltStyle } from './tilt-math';

describe('tilt math', () => {
  it('never exceeds 6 degrees, whatever the intensity or pointer position', () => {
    for (const intensity of [undefined, 0, 3, 6, 12, 1e9, Number.NaN, -4]) {
      expect(clampIntensity(intensity)).toBeLessThanOrEqual(MAX_TILT);
      expect(clampIntensity(intensity)).toBeGreaterThanOrEqual(0);
      for (const [x, y] of [
        [0, 0],
        [200, 100],
        [-500, 9999],
        [100, 50],
      ]) {
        const t = tiltFromPointer({ x, y, width: 200, height: 100 }, intensity);
        expect(Math.abs(t.rotateX)).toBeLessThanOrEqual(MAX_TILT);
        expect(Math.abs(t.rotateY)).toBeLessThanOrEqual(MAX_TILT);
      }
    }
  });

  it('is flat at the centre and lifts the near edge toward the pointer', () => {
    const centre = tiltFromPointer({ x: 100, y: 50, width: 200, height: 100 });
    expect(centre.rotateX).toBe(0);
    expect(centre.rotateY).toBe(0);
    const topLeft = tiltFromPointer({ x: 0, y: 0, width: 200, height: 100 });
    expect(topLeft).toMatchObject({ px: 0, py: 0, rotateX: MAX_TILT, rotateY: -MAX_TILT });
    const bottomRight = tiltFromPointer({ x: 200, y: 100, width: 200, height: 100 }, 3);
    expect(bottomRight).toMatchObject({ px: 1, py: 1, rotateX: -3, rotateY: 3 });
  });

  it('produces no transform and a hidden specular at rest', () => {
    expect(tiltStyle(null)).toEqual({});
    expect(specularStyle(null)).toEqual({ opacity: 0 });
    const hot = tiltStyle(tiltFromPointer({ x: 0, y: 0, width: 10, height: 10 }));
    expect(hot.transform).toBe('perspective(800px) rotateX(6deg) rotateY(-6deg)');
  });

  it('keeps the specular neutral: white and ink only, no accent, no hue', () => {
    const bg = String(specularStyle(tiltFromPointer({ x: 2, y: 8, width: 10, height: 10 })).backgroundImage);
    expect(bg).toContain('rgb(255 255 255 / 0.1)');
    expect(bg).toContain('var(--ink) 4%');
    expect(bg).not.toMatch(/accent|#[0-9a-f]{3,8}\b|hsl|oklch/i);
  });
});

describe('<Tilt>', () => {
  it('renders a plain wrapper with no transform when motion is off (server / reduced motion / touch)', () => {
    const html = renderToStaticMarkup(
      <Tilt className="rounded-md" intensity={6}>
        <p>card</p>
      </Tilt>,
    );
    expect(html).toBe('<div class="relative rounded-md"><p>card</p></div>');
    expect(html).not.toContain('transform');
    expect(html).not.toContain('data-tilt');
  });
});
