import { MapExtractorRoom, PointType } from "../types/types";
import { CoordinatesConverter } from "./map_objects/coordinates-converter";

interface PixelBounds {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

interface RoomCandidate {
    readonly id: string;
    readonly bounds: PixelBounds;
    /** Colours that cover enough of the room's bounds to be its fill. */
    readonly colorKeys: number[];
}

export interface DetectedRoomColor {
    readonly id: string;
    readonly colorKey: number;
    readonly center: PointType;
    readonly outline: PointType[];
}

/**
 * The part of `ImageData` room detection reads. Declaring it lets PNG fixtures and other pure
 * pixel buffers go through `detectFromImageData` without a browser canvas, while a real
 * `ImageData` still satisfies it.
 */
export interface ImageDataLike {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

export interface RoomColorDetection {
    readonly imageData: ImageDataLike;
    readonly regions: DetectedRoomColor[];
    /**
     * The first room detected for each fill colour. Map sources reuse colours (Valetudo and Dreame
     * colour segments from a four-colour palette), so this is not a tap lookup: use `roomIdAt`.
     */
    readonly roomIdByColor: Map<number, string>;
    /**
     * The room under each image pixel, as an index into `labelRoomIds` (-1 for none). Unlike the
     * colour lookup it covers what the map draws over a room (cleaning paths, the robot, icons,
     * furniture) and tells apart rooms that share a colour. Use `RoomColorDetector.roomIdAt`.
     */
    readonly labels: Int16Array;
    readonly labelRoomIds: string[];
}

/**
 * Gaps up to twice this many pixels wide inside a room are closed: a cleaning path or the robot
 * drawn over the room's fill splits the colour mask, which made the room shrink to its largest
 * piece and left the path unclickable. Another room's colour is never claimed.
 */
const GAP_CLOSING_RADIUS = 4;

/**
 * How far past a room's camera bounds its colour is examined. A patch of the colour that reaches
 * this margin continues beyond the room, so it belongs to a larger neighbour that merely overlaps
 * the room's bounding box (an L-shaped room around another room).
 */
const BOUNDS_MARGIN = GAP_CLOSING_RADIUS + 4;

/**
 * An area no room colour covers but rooms enclose on every side (the robot, a room icon, furniture,
 * a no-go zone) belongs to the nearest enclosing room, up to this many pixels. Larger enclosed
 * areas are left alone: they are more likely an unsegmented part of the floor.
 */
const ENCLOSED_AREA_LIMIT = 64 * 64;

/**
 * A tap on something drawn at a room's edge (the docked robot, the charger, a wall) selects the
 * nearest room within this many pixels. The image background never does.
 */
const TAP_REACH = 10;

/** Saturated-colour test shared by the room colour histogram. */
const MIN_SATURATION = 24;
const MIN_BRIGHTNESS = 55;

interface ColorComponent {
    /** Indexes into the room's window. */
    readonly pixels: Int32Array;
    /** Pixels inside the room's camera bounds. */
    readonly inside: number;
    /** The patch reaches the window margin, so it continues outside the room's bounds. */
    readonly clipped: boolean;
}

interface RoomArea {
    /** The window the area covers: the room's camera bounds plus the margin. */
    readonly bounds: PixelBounds;
    readonly width: number;
    readonly height: number;
    /** 1 where the pixel belongs to the room's colour after closing. */
    readonly mask: Uint8Array;
    /** Distance from the room's own colour, for pixels the closing claimed. */
    readonly distance: Uint8Array;
}

interface RoomOption {
    readonly candidate: RoomCandidate;
    readonly colorKey: number;
    readonly area: RoomArea;
    /** Every patch of the colour in the room's window. */
    readonly components: ColorComponent[];
    readonly component: ColorComponent;
    readonly score: number;
}

interface BoundaryEdge {
    readonly startX: number;
    readonly startY: number;
    readonly endX: number;
    readonly endY: number;
    readonly direction: number;
}

export class RoomColorDetector {
    public static getColorKey(red: number, green: number, blue: number): number {
        return ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
    }

    /** The id of the room drawn at an image pixel, including what is drawn over its fill. */
    public static roomIdAt(detection: RoomColorDetection, x: number, y: number): string | undefined {
        const { width, height } = detection.imageData;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
        x = Math.floor(x);
        y = Math.floor(y);
        if (x < 0 || y < 0 || x >= width || y >= height) return undefined;
        const label = detection.labels[y * width + x];
        return label >= 0 ? detection.labelRoomIds[label] : undefined;
    }

    public static detect(
        image: HTMLImageElement | HTMLCanvasElement,
        rooms: Record<string, MapExtractorRoom>,
        converter: CoordinatesConverter,
    ): RoomColorDetection | undefined {
        const isCanvas = image instanceof HTMLCanvasElement;
        const imageWidth = isCanvas ? image.width : image.naturalWidth;
        const imageHeight = isCanvas ? image.height : image.naturalHeight;
        if ((!isCanvas && !image.complete) || !imageWidth || !imageHeight || !converter.calibrated) {
            return undefined;
        }

        const canvas = isCanvas ? image : document.createElement("canvas");
        if (!isCanvas) {
            canvas.width = imageWidth;
            canvas.height = imageHeight;
        }
        const context = canvas.getContext("2d");
        if (!context) return undefined;

        try {
            if (!isCanvas) context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, imageWidth, imageHeight);
            return this.detectFromImageData(imageData, rooms, converter);
        } catch (_error) {
            // A remote image without canvas access cannot be segmented; callers keep their normal room config.
            return undefined;
        }
    }

    /**
     * Pure room detection over raw RGBA pixels. `detect` is the browser/canvas wrapper; callers
     * that already have pixel data (PNG fixtures in tests, or a future non-canvas source) use
     * this directly. `converter` must be calibrated, which `detect` checks.
     *
     * 1. Each room with camera bounds lists the colours that fill a good share of its bounds.
     * 2. For every room and colour, the colour is closed over small gaps (paths, the robot) and
     *    split into connected patches. A patch scores by how much of it lies inside the bounds and
     *    how much of the bounds it covers; a patch that runs out of the bounds belongs to a larger
     *    neighbour and scores low. Rooms take their best patch, best first, and a patch is taken
     *    once. Colours are not exclusive: map sources reuse them for rooms that do not touch.
     * 3. Room patches are written to a per-pixel label map; an area enclosed by rooms goes to the
     *    nearest one. Outlines and label points come from that map.
     * 4. Taps reach a room across what is drawn at its edge (the robot, the charger, walls), up to
     *    `TAP_REACH` pixels, never across the image background.
     */
    public static detectFromImageData(
        imageData: ImageDataLike,
        rooms: Record<string, MapExtractorRoom>,
        converter: CoordinatesConverter,
    ): RoomColorDetection | undefined {
        if (!rooms || typeof rooms !== "object") return undefined;
        const candidates = Object.keys(rooms)
            .map(id => this._getCandidate(id, rooms[id], imageData, converter))
            .filter((candidate): candidate is RoomCandidate => candidate !== undefined);
        const allKeys = new Set(candidates.flatMap(candidate => candidate.colorKeys));

        const options: RoomOption[] = [];
        candidates.forEach(candidate => {
            candidate.colorKeys.forEach(colorKey => {
                const foreign = new Set(allKeys);
                foreign.delete(colorKey);
                const area = this._closeRoomArea(colorKey, foreign, candidate.bounds, imageData);
                const components = this._components(area, candidate.bounds);
                components.forEach(component => {
                    const score = this._score(component, candidate.bounds);
                    if (score > 0) options.push({ candidate, colorKey, area, components, component, score });
                });
            });
        });
        options.sort((left, right) => right.score - left.score);

        const imageWidth = imageData.width;
        const claimed = new Uint8Array(imageWidth * imageData.height);
        const chosen: RoomOption[] = [];
        const assignedRooms = new Set<string>();
        options.forEach(option => {
            if (assignedRooms.has(option.candidate.id)) return;
            const { area, component } = option;
            let overlap = 0;
            component.pixels.forEach(index => {
                if (claimed[this._toImageIndex(area, index, imageWidth)]) overlap++;
            });
            if (overlap * 2 > component.pixels.length) return;
            component.pixels.forEach(index => (claimed[this._toImageIndex(area, index, imageWidth)] = 1));
            assignedRooms.add(option.candidate.id);
            chosen.push(option);
        });
        if (chosen.length === 0) return undefined;

        // Label with the colours rooms actually use, so the closing may claim anything else that is
        // drawn over a room (a translucent no-go zone, an icon), and never another room's fill.
        const usedKeys = new Set(chosen.map(option => option.colorKey));
        const labels = new Int16Array(imageWidth * imageData.height).fill(-1);
        const priority = new Uint8Array(labels.length).fill(255);
        const labelRoomIds: string[] = [];
        const finalAreas: RoomArea[] = [];
        // When every candidate colour is some room's fill (the usual case) the barriers are the same
        // as in the first pass, so its areas are reused.
        const sameBarriers = usedKeys.size === allKeys.size;
        chosen.forEach(option => {
            const foreign = new Set(usedKeys);
            foreign.delete(option.colorKey);
            const area = sameBarriers
                ? option.area
                : this._closeRoomArea(option.colorKey, foreign, option.candidate.bounds, imageData);
            const components = sameBarriers ? option.components : this._components(area, option.candidate.bounds);
            const label = labelRoomIds.push(option.candidate.id) - 1;
            finalAreas.push(area);
            this._label(area, components, option, label, labels, priority, imageWidth);
        });

        this._fillEnclosedAreas(labels, imageData.width, imageData.height);
        const outlineLabels = labels.slice();
        this._extendTapReach(labels, imageData);

        const regions: DetectedRoomColor[] = [];
        const roomIdByColor = new Map<number, string>();
        chosen.forEach((option, label) => {
            const region = this._extractRegion(option.candidate.id, option.colorKey, label, finalAreas[label], outlineLabels, imageWidth);
            if (!region) return;
            regions.push(region);
            if (!roomIdByColor.has(option.colorKey)) roomIdByColor.set(option.colorKey, option.candidate.id);
        });

        return regions.length > 0 ? { imageData, regions, roomIdByColor, labels, labelRoomIds } : undefined;
    }

    private static _toImageIndex(area: RoomArea, index: number, imageWidth: number): number {
        const x = index % area.width;
        const y = (index - x) / area.width;
        return (area.bounds.top + y) * imageWidth + area.bounds.left + x;
    }

    private static _getCandidate(
        id: string,
        room: MapExtractorRoom | null | undefined,
        imageData: ImageDataLike,
        converter: CoordinatesConverter,
    ): RoomCandidate | undefined {
        // Camera metadata is integration data: skip an entry that is not a room with numeric bounds.
        if (!room || typeof room !== "object" || room.outline) return undefined;
        const corners = [room.x0, room.y0, room.x1, room.y1];
        if (!corners.every(value => typeof value === "number" && Number.isFinite(value))) return undefined;
        const [x0, y0, x1, y1] = corners as number[];
        const mapped = [
            converter.vacuumToMap(x0, y0),
            converter.vacuumToMap(x1, y0),
            converter.vacuumToMap(x1, y1),
            converter.vacuumToMap(x0, y1),
        ];
        if (mapped.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return undefined;
        const bounds = this._getBounds(mapped, imageData.width, imageData.height);
        if (!bounds) return undefined;

        const colors = new Map<number, number>();
        let coloredPixels = 0;
        for (let y = bounds.top; y <= bounds.bottom; y++) {
            for (let x = bounds.left; x <= bounds.right; x++) {
                const key = this._roomColorKey(imageData, (y * imageData.width + x) * 4);
                if (key === undefined) continue;
                colors.set(key, (colors.get(key) ?? 0) + 1);
                coloredPixels++;
            }
        }

        if (coloredPixels < 8) return undefined;
        const colorKeys = [...colors.entries()]
            .filter(([, count]) => count >= 8 && count >= coloredPixels * 0.08)
            .sort((left, right) => right[1] - left[1])
            .map(([key]) => key);
        return colorKeys.length > 0 ? { id, bounds, colorKeys } : undefined;
    }

    /** The colour key of a pixel that can be a room fill: opaque, saturated and not too dark. */
    private static _roomColorKey(imageData: ImageDataLike, offset: number): number | undefined {
        if (imageData.data[offset + 3] < 128) return undefined;
        const red = imageData.data[offset];
        const green = imageData.data[offset + 1];
        const blue = imageData.data[offset + 2];
        const maximum = Math.max(red, green, blue);
        const minimum = Math.min(red, green, blue);
        if (maximum - minimum < MIN_SATURATION || maximum < MIN_BRIGHTNESS) return undefined;
        return this.getColorKey(red, green, blue);
    }

    private static _getBounds(points: PointType[], imageWidth: number, imageHeight: number): PixelBounds | undefined {
        const left = Math.max(0, Math.floor(Math.min(...points.map(point => point[0]))));
        const top = Math.max(0, Math.floor(Math.min(...points.map(point => point[1]))));
        const right = Math.min(imageWidth - 1, Math.ceil(Math.max(...points.map(point => point[0]))));
        const bottom = Math.min(imageHeight - 1, Math.ceil(Math.max(...points.map(point => point[1]))));
        if (!(right >= left) || !(bottom >= top)) return undefined;
        return { left, top, right, bottom };
    }

    /**
     * How well a colour patch matches a room's camera bounds: the share of the patch inside the
     * bounds times the share of the bounds it fills. A patch that continues past the margin is a
     * neighbour seen through the room's bounding box.
     */
    private static _score(component: ColorComponent, bounds: PixelBounds): number {
        if (component.inside < 8) return 0;
        const boundsArea = (bounds.right - bounds.left + 1) * (bounds.bottom - bounds.top + 1);
        const precision = component.inside / component.pixels.length;
        const coverage = Math.min(1, component.inside / boundsArea);
        if (precision < 0.5) return 0;
        return precision * coverage * (component.clipped ? 0.25 : 1);
    }

    /**
     * The room's pixels after closing small gaps: its own colour, plus pixels of anything drawn over
     * it (a path, the robot) in gaps up to 2 * GAP_CLOSING_RADIUS wide. This is a morphological
     * closing with a square element: grow the colour mask by the radius, then shrink it back, so the
     * outer border does not grow. A foreign room colour is never claimed. `distance` is how far a
     * claimed pixel is from the room's own colour (0 for its own pixels).
     */
    private static _closeRoomArea(
        colorKey: number,
        foreignColors: Set<number>,
        roomBounds: PixelBounds,
        imageData: ImageDataLike,
    ): RoomArea {
        const radius = GAP_CLOSING_RADIUS;
        const bounds: PixelBounds = {
            left: Math.max(0, roomBounds.left - BOUNDS_MARGIN),
            top: Math.max(0, roomBounds.top - BOUNDS_MARGIN),
            right: Math.min(imageData.width - 1, roomBounds.right + BOUNDS_MARGIN),
            bottom: Math.min(imageData.height - 1, roomBounds.bottom + BOUNDS_MARGIN),
        };
        const width = bounds.right - bounds.left + 1;
        const height = bounds.bottom - bounds.top + 1;
        const own = new Uint8Array(width * height);
        const foreignRoom = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const imageOffset = ((bounds.top + y) * imageData.width + bounds.left + x) * 4;
                if (imageData.data[imageOffset + 3] < 128) continue;
                const key = this.getColorKey(
                    imageData.data[imageOffset],
                    imageData.data[imageOffset + 1],
                    imageData.data[imageOffset + 2],
                );
                if (key === colorKey) own[y * width + x] = 1;
                else if (foreignColors.has(key)) foreignRoom[y * width + x] = 1;
            }
        }

        // Grow: Chebyshev distance to the room's own colour, up to the radius.
        const distance = this._chebyshevDistance(own, width, height, radius + 1);
        const grown = new Uint8Array(width * height);
        for (let index = 0; index < grown.length; index++) grown[index] = distance[index] <= radius ? 1 : 0;

        // Shrink back: keep a grown pixel only when no pixel outside the grown area (or outside the
        // window) is within the radius.
        const outside = new Uint8Array(width * height);
        for (let index = 0; index < outside.length; index++) outside[index] = grown[index] ? 0 : 1;
        const toOutside = this._chebyshevDistance(outside, width, height, radius + 1);
        const mask = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                if (own[index]) {
                    mask[index] = 1;
                    continue;
                }
                if (!grown[index] || foreignRoom[index]) continue;
                const toEdge = Math.min(x + 1, y + 1, width - x, height - y);
                if (Math.min(toOutside[index], toEdge) > radius) mask[index] = 1;
            }
        }
        return { bounds, width, height, mask, distance };
    }

    /** 8-connected patches of an area's mask, with how much of each lies inside `roomBounds`. */
    private static _components(area: RoomArea, roomBounds: PixelBounds): ColorComponent[] {
        const { width, height, mask, bounds } = area;
        const visited = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        const components: ColorComponent[] = [];
        // A window side that is not the image's own edge: a patch touching it runs past the margin.
        const clipLeft = bounds.left < roomBounds.left - (BOUNDS_MARGIN - 1);
        const clipTop = bounds.top < roomBounds.top - (BOUNDS_MARGIN - 1);
        const clipRight = bounds.right > roomBounds.right + (BOUNDS_MARGIN - 1);
        const clipBottom = bounds.bottom > roomBounds.bottom + (BOUNDS_MARGIN - 1);
        for (let start = 0; start < mask.length; start++) {
            if (!mask[start] || visited[start]) continue;
            let head = 0;
            let tail = 0;
            let inside = 0;
            let clipped = false;
            queue[tail++] = start;
            visited[start] = 1;
            while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = (index - x) / width;
                const imageX = bounds.left + x;
                const imageY = bounds.top + y;
                if (
                    imageX >= roomBounds.left &&
                    imageX <= roomBounds.right &&
                    imageY >= roomBounds.top &&
                    imageY <= roomBounds.bottom
                ) {
                    inside++;
                }
                if ((clipLeft && x === 0) || (clipTop && y === 0) || (clipRight && x === width - 1) || (clipBottom && y === height - 1)) {
                    clipped = true;
                }
                for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1); neighborY++) {
                    for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX++) {
                        const neighbor = neighborY * width + neighborX;
                        if (!mask[neighbor] || visited[neighbor]) continue;
                        visited[neighbor] = 1;
                        queue[tail++] = neighbor;
                    }
                }
            }
            components.push({ pixels: queue.slice(0, tail), inside, clipped });
        }
        return components;
    }

    /**
     * Writes a room into the image-wide label map: its chosen patch, plus any other patch of its
     * colour that lies mostly inside its bounds (a room split by a wide obstacle). A pixel two rooms
     * claim goes to the one whose own colour is nearer, then to the one whose bounds contain it,
     * so rooms that share a colour split at their bounds.
     */
    private static _label(
        area: RoomArea,
        components: ColorComponent[],
        option: RoomOption,
        label: number,
        labels: Int16Array,
        priority: Uint8Array,
        imageWidth: number,
    ): void {
        const roomBounds = option.candidate.bounds;
        const seed = option.component.pixels[0];
        // The chosen patch was found with every candidate colour as a barrier; in the final area it
        // is the patch that contains the same seed pixel.
        components.forEach(component => {
            const isChosen = component === option.component || component.pixels.includes(seed);
            if (!isChosen && (component.clipped || component.inside * 10 < component.pixels.length * 9)) return;
            component.pixels.forEach(index => {
                const x = index % area.width;
                const y = (index - x) / area.width;
                const imageX = area.bounds.left + x;
                const imageY = area.bounds.top + y;
                const imageIndex = imageY * imageWidth + imageX;
                const inside =
                    imageX >= roomBounds.left && imageX <= roomBounds.right && imageY >= roomBounds.top && imageY <= roomBounds.bottom;
                const rank = area.distance[index] * 2 + (inside ? 0 : 1);
                if (rank < priority[imageIndex]) {
                    labels[imageIndex] = label;
                    priority[imageIndex] = rank;
                }
            });
        });
    }

    /**
     * Gives an unlabelled area that rooms enclose on every side (it does not reach the image edge)
     * to the nearest enclosing room: the robot, a room icon or name, furniture, a no-go zone. The
     * robot on a threshold is split between the two rooms it covers.
     */
    private static _fillEnclosedAreas(labels: Int16Array, width: number, height: number): void {
        const visited = new Uint8Array(labels.length);
        const queue = new Int32Array(labels.length);
        const limit = Math.max(ENCLOSED_AREA_LIMIT, Math.floor(labels.length * 0.002));
        for (let start = 0; start < labels.length; start++) {
            if (labels[start] >= 0 || visited[start]) continue;
            let head = 0;
            let tail = 0;
            let open = false;
            queue[tail++] = start;
            visited[start] = 1;
            while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = (index - x) / width;
                if (x === 0 || y === 0 || x === width - 1 || y === height - 1) open = true;
                const neighbors = [index - 1, index + 1, index - width, index + width];
                const valid = [x > 0, x < width - 1, y > 0, y < height - 1];
                neighbors.forEach((neighbor, direction) => {
                    if (!valid[direction] || visited[neighbor] || labels[neighbor] >= 0) return;
                    visited[neighbor] = 1;
                    queue[tail++] = neighbor;
                });
            }
            if (open || tail > limit) continue;
            this._growLabels(labels, width, height, queue.subarray(0, tail), Number.MAX_SAFE_INTEGER);
        }
    }

    /**
     * Lets a tap on something drawn at a room's edge reach the room: unlabelled pixels that are not
     * the image background take the nearest room label within `TAP_REACH` pixels. The background is
     * whatever covers the image border (a transparent or flat outside colour).
     */
    private static _extendTapReach(labels: Int16Array, imageData: ImageDataLike): void {
        const { width, height, data } = imageData;
        const backgroundKeys = this._backgroundKeys(imageData);
        const pixelKey = (index: number): number =>
            data[index * 4 + 3] < 128 ? -1 : this.getColorKey(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]);
        const targets: number[] = [];
        for (let index = 0; index < labels.length; index++) {
            if (labels[index] < 0 && !backgroundKeys.has(pixelKey(index))) targets.push(index);
        }
        this._growLabels(labels, width, height, Int32Array.from(targets), TAP_REACH);
    }

    /** Colour keys (-1 for transparent) that make up at least a tenth of the image border. */
    private static _backgroundKeys(imageData: ImageDataLike): Set<number> {
        const { width, height, data } = imageData;
        const counts = new Map<number, number>();
        let total = 0;
        const count = (x: number, y: number): void => {
            const offset = (y * width + x) * 4;
            const key = data[offset + 3] < 128 ? -1 : this.getColorKey(data[offset], data[offset + 1], data[offset + 2]);
            counts.set(key, (counts.get(key) ?? 0) + 1);
            total++;
        };
        for (let x = 0; x < width; x++) {
            count(x, 0);
            count(x, height - 1);
        }
        for (let y = 1; y < height - 1; y++) {
            count(0, y);
            count(width - 1, y);
        }
        const keys = new Set<number>([-1]);
        counts.forEach((value, key) => {
            if (value * 10 >= total) keys.add(key);
        });
        return keys;
    }

    /**
     * Multi-source breadth-first growth of room labels into `targets` (unlabelled pixels), up to
     * `reach` steps (8-connected). Each target takes the label of the nearest room.
     */
    private static _growLabels(labels: Int16Array, width: number, height: number, targets: Int32Array, reach: number): void {
        if (targets.length === 0) return;
        const isTarget = new Uint8Array(labels.length);
        targets.forEach(index => (isTarget[index] = 1));
        let frontier: number[] = [];
        // Seed with labelled pixels that touch a target.
        targets.forEach(index => {
            const x = index % width;
            const y = (index - x) / width;
            for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                    const neighbor = ny * width + nx;
                    if (labels[neighbor] >= 0 && !isTarget[neighbor]) frontier.push(neighbor);
                }
            }
        });
        const seen = new Uint8Array(labels.length);
        frontier = frontier.filter(index => (seen[index] ? false : (seen[index] = 1)));
        for (let step = 0; step < reach && frontier.length > 0; step++) {
            const next: number[] = [];
            frontier.forEach(index => {
                const x = index % width;
                const y = (index - x) / width;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                        const neighbor = ny * width + nx;
                        if (!isTarget[neighbor] || labels[neighbor] >= 0) continue;
                        labels[neighbor] = labels[index];
                        next.push(neighbor);
                    }
                }
            });
            frontier = next;
        }
    }

    /**
     * The room's outline and label point from the label map. The outline is the outer border of the
     * room's largest connected piece. The label point is that piece's centroid when it lies well
     * inside the room; for an L- or U-shaped room, where the centroid falls on a neighbour or
     * outside, it is the point deepest inside the room nearest to the centroid.
     */
    private static _extractRegion(
        id: string,
        colorKey: number,
        label: number,
        area: RoomArea,
        labels: Int16Array,
        imageWidth: number,
    ): DetectedRoomColor | undefined {
        const { bounds, width, height } = area;
        const mask = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (labels[(bounds.top + y) * imageWidth + bounds.left + x] === label) mask[y * width + x] = 1;
            }
        }

        const visited = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        let largestComponent = new Int32Array(0);
        for (let start = 0; start < mask.length; start++) {
            if (!mask[start] || visited[start]) continue;
            let head = 0;
            let tail = 0;
            queue[tail++] = start;
            visited[start] = 1;
            while (head < tail) {
                const index = queue[head++];
                const x = index % width;
                const y = (index - x) / width;
                for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1); neighborY++) {
                    for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX++) {
                        const neighbor = neighborY * width + neighborX;
                        if (!mask[neighbor] || visited[neighbor]) continue;
                        visited[neighbor] = 1;
                        queue[tail++] = neighbor;
                    }
                }
            }
            if (tail > largestComponent.length) largestComponent = queue.slice(0, tail);
        }

        if (largestComponent.length < 8) return undefined;
        const componentMask = new Uint8Array(mask.length);
        largestComponent.forEach(index => (componentMask[index] = 1));
        this._fillHoles(componentMask, width, height);
        const outline = this._getOutline(componentMask, width, height, bounds.left, bounds.top);
        if (outline.length < 3) return undefined;
        const center = this._labelPoint(componentMask, width, height);
        return {
            id,
            colorKey,
            center: [bounds.left + center[0], bounds.top + center[1]],
            outline,
        };
    }

    /**
     * The Chebyshev depth of a pixel inside the mask (0 when it is outside), counted up to `limit`:
     * how many square rings around it lie fully in the mask, plus one.
     */
    private static _squareDepth(mask: Uint8Array, width: number, height: number, x: number, y: number, limit: number): number {
        if (x < 0 || y < 0 || x >= width || y >= height || !mask[y * width + x]) return 0;
        for (let ring = 1; ring <= limit; ring++) {
            if (x - ring < 0 || y - ring < 0 || x + ring >= width || y + ring >= height) return ring;
            for (let offset = -ring; offset <= ring; offset++) {
                if (
                    !mask[(y - ring) * width + x + offset] ||
                    !mask[(y + ring) * width + x + offset] ||
                    !mask[(y + offset) * width + x - ring] ||
                    !mask[(y + offset) * width + x + ring]
                ) {
                    return ring;
                }
            }
        }
        return limit + 1;
    }

    /** Sets every pixel the mask encloses (4-connected background not reaching the window edge). */
    private static _fillHoles(mask: Uint8Array, width: number, height: number): void {
        const outside = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        let tail = 0;
        const push = (index: number): void => {
            if (mask[index] || outside[index]) return;
            outside[index] = 1;
            queue[tail++] = index;
        };
        for (let x = 0; x < width; x++) {
            push(x);
            push((height - 1) * width + x);
        }
        for (let y = 0; y < height; y++) {
            push(y * width);
            push(y * width + width - 1);
        }
        for (let head = 0; head < tail; head++) {
            const index = queue[head];
            const x = index % width;
            const y = (index - x) / width;
            if (x > 0) push(index - 1);
            if (x < width - 1) push(index + 1);
            if (y > 0) push(index - width);
            if (y < height - 1) push(index + width);
        }
        for (let index = 0; index < mask.length; index++) if (!outside[index]) mask[index] = 1;
    }

    /** The centroid, or the deepest point nearest to it when the centroid is near an edge. */
    private static _labelPoint(mask: Uint8Array, width: number, height: number): PointType {
        let sumX = 0;
        let sumY = 0;
        let count = 0;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index]) continue;
            const x = index % width;
            sumX += x + 0.5;
            sumY += (index - x) / width + 0.5;
            count++;
        }
        const centroid: PointType = [sumX / count, sumY / count];
        const centroidX = Math.floor(centroid[0]);
        const centroidY = Math.floor(centroid[1]);
        // Fast path: the deepest point of any shape is at most half its bounding box's shorter side
        // from the edge, so a centroid at least a quarter of that side deep is deep enough.
        let minX = width;
        let maxX = 0;
        let minY = height;
        let maxY = 0;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index]) continue;
            const x = index % width;
            const y = (index - x) / width;
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
        }
        const shorterSide = Math.min(maxX - minX + 1, maxY - minY + 1);
        if (this._squareDepth(mask, width, height, centroidX, centroidY, Math.ceil(shorterSide / 4)) >= shorterSide / 4) {
            return centroid;
        }
        const outside = new Uint8Array(mask.length);
        for (let index = 0; index < mask.length; index++) outside[index] = mask[index] ? 0 : 1;
        const depth = this._chebyshevDistance(outside, width, height, 255);
        // The window edge counts as outside too.
        const depthAt = (index: number): number => {
            const x = index % width;
            const y = (index - x) / width;
            return Math.min(depth[index], x + 1, y + 1, width - x, height - y);
        };
        let maximum = 0;
        for (let index = 0; index < mask.length; index++) if (mask[index]) maximum = Math.max(maximum, depthAt(index));
        const centroidIndex = Math.floor(centroid[1]) * width + Math.floor(centroid[0]);
        if (mask[centroidIndex] && depthAt(centroidIndex) * 2 >= maximum) return centroid;

        let best: PointType = centroid;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < mask.length; index++) {
            if (!mask[index] || depthAt(index) * 4 < maximum * 3) continue;
            const x = index % width;
            const y = (index - x) / width;
            const distance = (x + 0.5 - centroid[0]) ** 2 + (y + 0.5 - centroid[1]) ** 2;
            if (distance < bestDistance) {
                bestDistance = distance;
                best = [x + 0.5, y + 0.5];
            }
        }
        return best;
    }

    /** Chebyshev (8-neighbour) distance to the nearest set pixel, capped at `cap`. */
    private static _chebyshevDistance(source: Uint8Array, width: number, height: number, cap: number): Uint8Array {
        const distance = new Uint8Array(source.length).fill(cap);
        const queue = new Int32Array(source.length);
        let head = 0;
        let tail = 0;
        for (let index = 0; index < source.length; index++) {
            if (!source[index]) continue;
            distance[index] = 0;
            queue[tail++] = index;
        }
        while (head < tail) {
            const index = queue[head++];
            const next = distance[index] + 1;
            if (next >= cap) continue;
            const x = index % width;
            const y = (index - x) / width;
            for (let neighborY = Math.max(0, y - 1); neighborY <= Math.min(height - 1, y + 1); neighborY++) {
                for (let neighborX = Math.max(0, x - 1); neighborX <= Math.min(width - 1, x + 1); neighborX++) {
                    const neighbor = neighborY * width + neighborX;
                    if (distance[neighbor] <= next) continue;
                    distance[neighbor] = next;
                    queue[tail++] = neighbor;
                }
            }
        }
        return distance;
    }

    private static _getOutline(
        mask: Uint8Array,
        width: number,
        height: number,
        offsetX: number,
        offsetY: number,
    ): PointType[] {
        const edges: BoundaryEdge[] = [];
        const outgoing = new Map<number, number[]>();
        const vertexKey = (x: number, y: number): number => y * (width + 1) + x;
        const addEdge = (startX: number, startY: number, endX: number, endY: number, direction: number): void => {
            const edgeId = edges.length;
            edges.push({ startX, startY, endX, endY, direction });
            const key = vertexKey(startX, startY);
            outgoing.set(key, [...(outgoing.get(key) ?? []), edgeId]);
        };
        const filled = (x: number, y: number): boolean =>
            x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x] === 1;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (!filled(x, y)) continue;
                if (!filled(x, y - 1)) addEdge(x, y, x + 1, y, 0);
                if (!filled(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1, 1);
                if (!filled(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1, 2);
                if (!filled(x - 1, y)) addEdge(x, y + 1, x, y, 3);
            }
        }

        const used = new Uint8Array(edges.length);
        let largestLoop: PointType[] = [];
        let largestArea = 0;
        for (let start = 0; start < edges.length; start++) {
            if (used[start]) continue;
            const first = edges[start];
            const loop: PointType[] = [[first.startX, first.startY]];
            let current = start;
            let closed = false;
            let steps = 0;
            while (!used[current] && steps <= edges.length) {
                steps++;
                used[current] = 1;
                const edge = edges[current];
                loop.push([edge.endX, edge.endY]);
                if (edge.endX === first.startX && edge.endY === first.startY) {
                    closed = true;
                    break;
                }
                const nextEdges = (outgoing.get(vertexKey(edge.endX, edge.endY)) ?? []).filter(edgeId => !used[edgeId]);
                if (nextEdges.length === 0) break;
                nextEdges.sort((left, right) => {
                    const leftTurn = (edges[left].direction - edge.direction + 4) % 4;
                    const rightTurn = (edges[right].direction - edge.direction + 4) % 4;
                    const priority = (turn: number): number => (turn === 1 ? 0 : turn === 0 ? 1 : turn === 3 ? 2 : 3);
                    return priority(leftTurn) - priority(rightTurn);
                });
                current = nextEdges[0];
            }
            if (!closed || loop.length < 4) continue;
            const area = Math.abs(this._polygonArea(loop));
            if (area > largestArea) {
                largestArea = area;
                largestLoop = loop;
            }
        }

        return this._simplifyClosed(largestLoop, 2.5).map(point => [point[0] + offsetX, point[1] + offsetY]);
    }

    private static _polygonArea(points: PointType[]): number {
        let area = 0;
        points.forEach((point, index) => {
            const next = points[(index + 1) % points.length];
            area += point[0] * next[1] - next[0] * point[1];
        });
        return area / 2;
    }

    private static _simplifyClosed(points: PointType[], tolerance: number): PointType[] {
        if (points.length < 5) return points.slice(0, -1);
        const ring = points.slice(0, -1);
        let split = 1;
        let distance = 0;
        ring.forEach((point, index) => {
            const dx = point[0] - ring[0][0];
            const dy = point[1] - ring[0][1];
            const currentDistance = dx * dx + dy * dy;
            if (currentDistance > distance) {
                split = index;
                distance = currentDistance;
            }
        });
        const first = this._simplifyOpen(ring.slice(0, split + 1), tolerance);
        const second = this._simplifyOpen([...ring.slice(split), ring[0]], tolerance);
        return [...first.slice(0, -1), ...second.slice(0, -1)];
    }

    private static _simplifyOpen(points: PointType[], tolerance: number): PointType[] {
        if (points.length <= 2) return points;
        const keep = new Uint8Array(points.length);
        const stack: Array<[number, number]> = [[0, points.length - 1]];
        const threshold = tolerance * tolerance;
        keep[0] = 1;
        keep[points.length - 1] = 1;
        while (stack.length > 0) {
            const [start, end] = stack.pop() as [number, number];
            const first = points[start];
            const last = points[end];
            const dx = last[0] - first[0];
            const dy = last[1] - first[1];
            const lengthSquared = dx * dx + dy * dy;
            let farthest = -1;
            let farthestDistance = threshold;
            for (let index = start + 1; index < end; index++) {
                const point = points[index];
                const position = lengthSquared === 0
                    ? 0
                    : Math.max(0, Math.min(1, ((point[0] - first[0]) * dx + (point[1] - first[1]) * dy) / lengthSquared));
                const nearestX = first[0] + position * dx;
                const nearestY = first[1] + position * dy;
                const distanceX = point[0] - nearestX;
                const distanceY = point[1] - nearestY;
                const currentDistance = distanceX * distanceX + distanceY * distanceY;
                if (currentDistance > farthestDistance) {
                    farthestDistance = currentDistance;
                    farthest = index;
                }
            }
            if (farthest >= 0) {
                keep[farthest] = 1;
                stack.push([start, farthest], [farthest, end]);
            }
        }
        return points.filter((_point, index) => keep[index] === 1);
    }
}
