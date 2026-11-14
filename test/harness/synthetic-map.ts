/**
 * In-memory synthetic vacuum maps for room-detection tests.
 *
 * Each map source draws the same kinds of things over the room fills: walls, cleaning paths, the
 * robot and charger icons, no-go zones, virtual walls, obstacles and furniture, room icons and
 * names. These helpers paint those features into an `ImageDataLike` buffer so a test can
 * reproduce one map style at a time without committing a real user's map. Coordinates are
 * image pixels; rectangles are inclusive.
 */
import type { CalibrationPoint, MapExtractorRoom } from "../../src/types/types";
import type { ImageDataLike } from "../../src/model/room-color-detector";

export type Rgb = readonly [number, number, number];
export type Rgba = readonly [number, number, number, number];
export type Rect = readonly [left: number, top: number, right: number, bottom: number];

/** Vacuum units per image pixel in every synthetic map. */
export const VACUUM_UNITS_PER_PIXEL = 10;

export class SyntheticMap implements ImageDataLike {
    public readonly data: Uint8ClampedArray;

    constructor(
        public readonly width: number,
        public readonly height: number,
        background: Rgba = [255, 255, 255, 255],
    ) {
        this.data = new Uint8ClampedArray(width * height * 4);
        for (let offset = 0; offset < this.data.length; offset += 4) this.data.set(background, offset);
    }

    public set(x: number, y: number, color: Rgb | Rgba): void {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
        const offset = (Math.floor(y) * this.width + Math.floor(x)) * 4;
        this.data.set(color.length === 4 ? color : [...color, 255], offset);
    }

    public get(x: number, y: number): Rgba {
        const offset = (y * this.width + x) * 4;
        return [this.data[offset], this.data[offset + 1], this.data[offset + 2], this.data[offset + 3]];
    }

    /** Alpha-blends a colour over a pixel, as a translucent no-go zone or an anti-aliased edge. */
    public blend(x: number, y: number, color: Rgb, alpha: number): void {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
        const [red, green, blue, a] = this.get(x, y);
        this.set(x, y, [
            Math.round(red * (1 - alpha) + color[0] * alpha),
            Math.round(green * (1 - alpha) + color[1] * alpha),
            Math.round(blue * (1 - alpha) + color[2] * alpha),
            Math.max(a, Math.round(alpha * 255)),
        ]);
    }

    public rect([left, top, right, bottom]: Rect, color: Rgb | Rgba): this {
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) this.set(x, y, color);
        return this;
    }

    public blendRect([left, top, right, bottom]: Rect, color: Rgb, alpha: number): this {
        for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) this.blend(x, y, color, alpha);
        return this;
    }

    /** A rectangle outline `width` pixels thick, drawn inside the rectangle. */
    public frame([left, top, right, bottom]: Rect, color: Rgb, width = 1): this {
        this.rect([left, top, right, top + width - 1], color);
        this.rect([left, bottom - width + 1, right, bottom], color);
        this.rect([left, top, left + width - 1, bottom], color);
        this.rect([right - width + 1, top, right, bottom], color);
        return this;
    }

    /** A filled polygon (even-odd, pixel centres), for L- and U-shaped rooms. */
    public polygon(points: ReadonlyArray<readonly [number, number]>, color: Rgb | Rgba): this {
        const top = Math.floor(Math.min(...points.map(point => point[1])));
        const bottom = Math.ceil(Math.max(...points.map(point => point[1])));
        for (let y = top; y <= bottom; y++) {
            const centreY = y + 0.5;
            const crossings: number[] = [];
            points.forEach((point, index) => {
                const next = points[(index + 1) % points.length];
                if ((point[1] <= centreY) !== (next[1] <= centreY)) {
                    crossings.push(point[0] + ((centreY - point[1]) / (next[1] - point[1])) * (next[0] - point[0]));
                }
            });
            crossings.sort((a, b) => a - b);
            for (let index = 0; index + 1 < crossings.length; index += 2) {
                for (let x = Math.ceil(crossings[index] - 0.5); x + 0.5 <= crossings[index + 1]; x++) this.set(x, y, color);
            }
        }
        return this;
    }

    /** A disc, anti-aliased at its rim when `antialias` is set, like a robot or charger icon. */
    public disc(centreX: number, centreY: number, radius: number, color: Rgb, antialias = false): this {
        for (let y = Math.floor(centreY - radius - 1); y <= Math.ceil(centreY + radius + 1); y++) {
            for (let x = Math.floor(centreX - radius - 1); x <= Math.ceil(centreX + radius + 1); x++) {
                const distance = Math.hypot(x + 0.5 - centreX, y + 0.5 - centreY);
                if (distance <= radius - 0.5) this.set(x, y, color);
                else if (antialias && distance < radius + 0.5) this.blend(x, y, color, radius + 0.5 - distance);
            }
        }
        return this;
    }

    /** A line `width` pixels thick, like a cleaning path or a virtual wall. */
    public line(fromX: number, fromY: number, toX: number, toY: number, color: Rgb, width = 1): this {
        const steps = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY), 1) * 2;
        const half = (width - 1) / 2;
        for (let step = 0; step <= steps; step++) {
            const x = fromX + ((toX - fromX) * step) / steps;
            const y = fromY + ((toY - fromY) * step) / steps;
            for (let dy = -Math.floor(half); dy <= Math.ceil(half); dy++) {
                for (let dx = -Math.floor(half); dx <= Math.ceil(half); dx++) this.set(Math.round(x + dx), Math.round(y + dy), color);
            }
        }
        return this;
    }

    /** A cleaning run: back-and-forth lanes across a rectangle, as every source draws its path. */
    public lanes([left, top, right, bottom]: Rect, spacing: number, color: Rgb, width = 1): this {
        let forward = true;
        for (let y = top; y <= bottom; y += spacing) {
            this.line(forward ? left : right, y, forward ? right : left, y, color, width);
            const nextY = Math.min(y + spacing, bottom);
            if (nextY > y) this.line(forward ? right : left, y, forward ? right : left, nextY, color, width);
            forward = !forward;
        }
        return this;
    }

    /** Blends every pixel within one pixel of a colour boundary halfway, like a smoothed render. */
    public antialiasEdges(): this {
        const source = new Uint8ClampedArray(this.data);
        const at = (x: number, y: number, channel: number): number => source[(y * this.width + x) * 4 + channel];
        for (let y = 1; y < this.height - 1; y++) {
            for (let x = 1; x < this.width - 1; x++) {
                const neighbours: Array<[number, number]> = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
                const differing = neighbours.filter(([nx, ny]) =>
                    [0, 1, 2, 3].some(channel => at(nx, ny, channel) !== at(x, y, channel)),
                );
                if (differing.length === 0) continue;
                const [nx, ny] = differing[0];
                const offset = (y * this.width + x) * 4;
                for (let channel = 0; channel < 4; channel++) {
                    this.data[offset + channel] = Math.round((at(x, y, channel) * 3 + at(nx, ny, channel)) / 4);
                }
            }
        }
        return this;
    }

    /** Deterministic per-pixel noise, like a lossy (JPEG) camera image. */
    public noise(amplitude: number, seed = 1): this {
        let state = seed >>> 0 || 1;
        const next = (): number => {
            state ^= state << 13;
            state ^= state >>> 17;
            state ^= state << 5;
            return ((state >>> 0) / 0xffffffff) * 2 - 1;
        };
        for (let offset = 0; offset < this.data.length; offset += 4) {
            if (this.data[offset + 3] === 0) continue;
            for (let channel = 0; channel < 3; channel++) {
                this.data[offset + channel] = this.data[offset + channel] + Math.round(next() * amplitude);
            }
        }
        return this;
    }

    /** What the card's `transparent_background` does to the canvas before detection. */
    public makeNearWhiteTransparent(): this {
        for (let offset = 0; offset < this.data.length; offset += 4) {
            const red = this.data[offset];
            const green = this.data[offset + 1];
            const blue = this.data[offset + 2];
            const minimum = Math.min(red, green, blue);
            const maximum = Math.max(red, green, blue);
            if (minimum >= 250 && maximum - minimum <= 6) this.data[offset + 3] = 0;
        }
        return this;
    }

    /** A copy, so one base map can be drawn over in several ways. */
    public clone(): SyntheticMap {
        const copy = new SyntheticMap(this.width, this.height);
        copy.data.set(this.data);
        return copy;
    }
}

/** Calibration where one image pixel is `VACUUM_UNITS_PER_PIXEL` vacuum units on both axes. */
export function syntheticMapCalibration(width: number, height: number): CalibrationPoint[] {
    const scale = VACUUM_UNITS_PER_PIXEL;
    return [
        { map: { x: 0, y: 0 }, vacuum: { x: 0, y: 0 } },
        { map: { x: width, y: 0 }, vacuum: { x: width * scale, y: 0 } },
        { map: { x: 0, y: height }, vacuum: { x: 0, y: height * scale } },
    ];
}

/**
 * Camera `rooms` metadata for a room drawn over an inclusive pixel rectangle: the bounding box in
 * vacuum units, as Xiaomi Cloud Map Extractor and Dreame report it.
 */
export function roomBounds([left, top, right, bottom]: Rect, name?: string): MapExtractorRoom {
    const scale = VACUUM_UNITS_PER_PIXEL;
    return {
        x0: left * scale,
        y0: top * scale,
        x1: (right + 1) * scale,
        y1: (bottom + 1) * scale,
        name,
        outline: undefined,
        icon: undefined,
        x: undefined,
        y: undefined,
    };
}
