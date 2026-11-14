import { MapExtractorRoom, PointType } from "../types/types";
import { CoordinatesConverter } from "./map_objects/coordinates-converter";
import { metadataRoomGeometry } from "./room-config";

interface PixelBounds {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

/** A metadata room with usable geometry, in image pixels. */
interface RoomEntry {
    readonly id: string;
    readonly bounds: PixelBounds;
    /** The room's metadata shape: its own outline, or its bounds rectangle. */
    readonly polygon: PointType[];
    /** Only rooms described by bounds are traced from the colours; an own outline is kept as is. */
    readonly detectable: boolean;
}

interface RoomCandidate {
    readonly id: string;
    readonly bounds: PixelBounds;
    /** Colours that cover enough of the room's bounds to be its fill, most frequent first. */
    readonly colorKeys: number[];
    /** Every other room's bounds: a room's closing never reaches into them. */
    readonly otherBounds: PixelBounds[];
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
    /**
     * What the detection depends on besides the pixels: image size, calibration and every room's
     * metadata shape (`RoomColorDetector.geometryKey`). A newer snapshot of the same map with the
     * same key only moved the robot or extended a path.
     */
    readonly geometryKey?: string;
    /** Every room described by bounds was found. */
    readonly complete?: boolean;
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

/**
 * A colour patch that fits a room's bounds this well (inside share x coverage) is taken without
 * scoring the room's other candidate colours (a path colour, a neighbour seen through the bounding
 * box). Those are scored only if the room ends up without a patch.
 */
const GOOD_FIT = 0.5;

/** The least share of its own bounds a room's fill covers. */
const MIN_COVERAGE = 0.15;

/** Border colours within this per-channel distance of the dominant border colour are background. */
const BACKGROUND_TOLERANCE = 24;

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
    /** The patch holds a solid 5 x 5 block: a fill, not a wall or a path line. */
    readonly solid: boolean;
}

interface RoomArea {
    /** The window the area covers: the room's camera bounds plus the margin. */
    readonly bounds: PixelBounds;
    readonly width: number;
    readonly height: number;
    /** 1 where the pixel belongs to the room's colour after closing. */
    readonly mask: Uint8Array;
    /**
     * What the solidity test reads: the closing as if no colour were a barrier, plus pixels within
     * one quantisation step of the room's colour. Lanes of a candidate path colour and a lossy
     * image's noise across neighbouring colour bins still form a solid fill; a wall stays a line.
     */
    readonly near: Uint8Array;
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

/** What enclosed-area filling and tap reach may grow into. */
interface GrowLimits {
    /** Each label's room bounds: a room never grows outside them. */
    readonly labelBounds: PixelBounds[];
    /** 1 inside an undetected room's metadata shape. */
    readonly reserved: Uint8Array;
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

    /**
     * The inputs a detection depends on besides the pixels: image size, calibration and each room's
     * metadata shape. Two snapshots with the same key show the same rooms in the same places.
     */
    public static geometryKey(
        width: number,
        height: number,
        rooms: Record<string, MapExtractorRoom> | undefined,
        converter: CoordinatesConverter,
    ): string {
        const shapes =
            rooms && typeof rooms === "object" && !Array.isArray(rooms)
                ? Object.keys(rooms)
                      .sort()
                      .map(id => [id, metadataRoomGeometry(rooms[id])?.outline ?? null])
                : [];
        const origin = converter.vacuumToMap(0, 0);
        const unitX = converter.vacuumToMap(1000, 0);
        const unitY = converter.vacuumToMap(0, 1000);
        return JSON.stringify([width, height, origin, unitX, unitY, shapes]);
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
        if (!rooms || typeof rooms !== "object" || Array.isArray(rooms)) return undefined;
        const entries = Object.keys(rooms)
            .map(id => this._getEntry(id, rooms[id], imageData, converter))
            .filter((entry): entry is RoomEntry => entry !== undefined);
        const candidates = entries
            .filter(entry => entry.detectable)
            .map(entry => this._getCandidate(entry, entries, imageData))
            .filter((candidate): candidate is RoomCandidate => candidate !== undefined);
        const allKeys = new Set(candidates.flatMap(candidate => candidate.colorKeys));

        const imageWidth = imageData.width;
        const claimed = new Uint8Array(imageWidth * imageData.height);
        const chosen: RoomOption[] = [];
        const assignedRooms = new Set<string>();
        /** Takes the best options first; a patch mostly claimed by an earlier room is skipped. */
        const assign = (options: RoomOption[]): void => {
            options.sort((left, right) => right.score - left.score);
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
        };
        const optionsFor = (candidate: RoomCandidate, colorKey: number): RoomOption[] => {
            const foreign = new Set(allKeys);
            foreign.delete(colorKey);
            const area = this._closeRoomArea(colorKey, foreign, candidate, imageData);
            const components = this._components(area, candidate.bounds);
            return components
                .map(component => ({ candidate, colorKey, area, components, component, score: this._score(component, candidate.bounds) }))
                .filter(option => option.score > 0);
        };

        // First round: each room's colours in order of frequency, stopping at a good fit.
        const firstRound: RoomOption[] = [];
        const nextKey = new Map<string, number>();
        candidates.forEach(candidate => {
            let index = 0;
            while (index < candidate.colorKeys.length) {
                const options = optionsFor(candidate, candidate.colorKeys[index++]);
                firstRound.push(...options);
                if (options.some(option => option.score >= GOOD_FIT)) break;
            }
            nextKey.set(candidate.id, index);
        });
        assign(firstRound);
        // Second round: rooms left without a patch score the colours the first round skipped.
        const secondRound: RoomOption[] = [];
        candidates.forEach(candidate => {
            if (assignedRooms.has(candidate.id)) return;
            candidate.colorKeys.slice(nextKey.get(candidate.id)).forEach(colorKey => secondRound.push(...optionsFor(candidate, colorKey)));
        });
        if (secondRound.length > 0) assign(secondRound);
        if (chosen.length === 0) return undefined;

        // Label with the colours rooms actually use, so the closing may claim anything else that is
        // drawn over a room (a translucent no-go zone, an icon), and never another room's fill.
        const usedKeys = new Set(chosen.map(option => option.colorKey));
        const labels = new Int16Array(imageWidth * imageData.height).fill(-1);
        const priority = new Uint8Array(labels.length).fill(255);
        const labelRoomIds: string[] = [];
        const labelBounds: PixelBounds[] = [];
        const finalAreas: RoomArea[] = [];
        const finalComponents: ColorComponent[][] = [];
        // When every candidate colour is some room's fill (the usual case) the barriers are the same
        // as in the first pass, so its areas are reused.
        const sameBarriers = [...allKeys].every(key => usedKeys.has(key));
        chosen.forEach(option => {
            const foreign = new Set(usedKeys);
            foreign.delete(option.colorKey);
            const area = sameBarriers ? option.area : this._closeRoomArea(option.colorKey, foreign, option.candidate, imageData);
            const components = sameBarriers ? option.components : this._components(area, option.candidate.bounds);
            const label = labelRoomIds.push(option.candidate.id) - 1;
            labelBounds.push(option.candidate.bounds);
            finalAreas.push(area);
            finalComponents.push(components);
            this._labelChosen(area, components, option, label, labels, priority, imageWidth);
        });

        // Rooms the colours did not reveal keep their own metadata shape: nothing below may give
        // their floor to a detected neighbour.
        const detectedIds = new Set(labelRoomIds);
        const reserved = this._reserve(
            entries.filter(entry => !detectedIds.has(entry.id)),
            imageData.width,
            imageData.height,
        );
        chosen.forEach((option, label) =>
            this._labelSecondary(finalAreas[label], finalComponents[label], option, label, labels, reserved, imageWidth),
        );

        const grow = { labelBounds, reserved };
        this._fillEnclosedAreas(labels, imageData.width, imageData.height, grow);
        const outlineLabels = labels.slice();
        this._extendTapReach(labels, imageData, grow);

        const regions: DetectedRoomColor[] = [];
        const roomIdByColor = new Map<number, string>();
        chosen.forEach((option, label) => {
            const region = this._extractRegion(option.candidate.id, option.colorKey, label, finalAreas[label], outlineLabels, imageWidth);
            if (!region) return;
            regions.push(region);
            if (!roomIdByColor.has(option.colorKey)) roomIdByColor.set(option.colorKey, option.candidate.id);
        });

        if (regions.length === 0) return undefined;
        const detectable = entries.filter(entry => entry.detectable).length;
        return {
            imageData,
            regions,
            roomIdByColor,
            labels,
            labelRoomIds,
            geometryKey: this.geometryKey(imageData.width, imageData.height, rooms, converter),
            complete: regions.length === detectable,
        };
    }

    private static _toImageIndex(area: RoomArea, index: number, imageWidth: number): number {
        const x = index % area.width;
        const y = (index - x) / area.width;
        return (area.bounds.top + y) * imageWidth + area.bounds.left + x;
    }

    private static _getEntry(
        id: string,
        room: unknown,
        imageData: ImageDataLike,
        converter: CoordinatesConverter,
    ): RoomEntry | undefined {
        // Camera metadata is integration data: skip an entry that is not a room with usable geometry.
        const geometry = metadataRoomGeometry(room);
        if (!geometry) return undefined;
        const polygon = geometry.outline.map(point => converter.vacuumToMap(point[0], point[1]));
        if (polygon.some(point => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return undefined;
        const bounds = this._getBounds(polygon, imageData.width, imageData.height);
        if (!bounds) return undefined;
        return { id, bounds, polygon, detectable: geometry.fromBounds };
    }

    private static _getCandidate(entry: RoomEntry, entries: RoomEntry[], imageData: ImageDataLike): RoomCandidate | undefined {
        const { bounds } = entry;
        const counts = new Uint32Array(32768);
        const seen: number[] = [];
        let coloredPixels = 0;
        for (let y = bounds.top; y <= bounds.bottom; y++) {
            for (let x = bounds.left; x <= bounds.right; x++) {
                const key = this._roomColorKey(imageData, (y * imageData.width + x) * 4);
                if (key === undefined) continue;
                if (counts[key]++ === 0) seen.push(key);
                coloredPixels++;
            }
        }

        if (coloredPixels < 8) return undefined;
        const colorKeys = seen
            .filter(key => counts[key] >= 8 && counts[key] >= coloredPixels * 0.08)
            .sort((left, right) => counts[right] - counts[left]);
        if (colorKeys.length === 0) return undefined;
        const otherBounds = entries.filter(other => other !== entry).map(other => other.bounds);
        return { id: entry.id, bounds, colorKeys, otherBounds };
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
        if (component.inside < 8 || !component.solid) return 0;
        const boundsArea = (bounds.right - bounds.left + 1) * (bounds.bottom - bounds.top + 1);
        const precision = component.inside / component.pixels.length;
        const coverage = Math.min(1, component.inside / boundsArea);
        // A room's fill covers a fair share of its own bounding box; a wall or a path running
        // through the bounds of a room drawn without colour does not.
        if (precision < 0.5 || coverage < MIN_COVERAGE) return 0;
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
        candidate: RoomCandidate,
        imageData: ImageDataLike,
    ): RoomArea {
        const roomBounds = candidate.bounds;
        const radius = GAP_CLOSING_RADIUS;
        const bounds: PixelBounds = {
            left: Math.max(0, roomBounds.left - BOUNDS_MARGIN),
            top: Math.max(0, roomBounds.top - BOUNDS_MARGIN),
            right: Math.min(imageData.width - 1, roomBounds.right + BOUNDS_MARGIN),
            bottom: Math.min(imageData.height - 1, roomBounds.bottom + BOUNDS_MARGIN),
        };
        const width = bounds.right - bounds.left + 1;
        const height = bounds.bottom - bounds.top + 1;
        // Another room's bounds, outside this room's own (or inside it, for a smaller room): map
        // sources reuse a colour for rooms that do not touch, often only a thin wall apart. The closing would bridge that wall and run
        // into the same-coloured neighbour, so the neighbour's area is a barrier, never own colour.
        const otherOwned = new Uint8Array(width * height);
        const area = (box: PixelBounds): number => (box.right - box.left + 1) * (box.bottom - box.top + 1);
        candidate.otherBounds.forEach(other => {
            // Where the bounds overlap, the smaller room owns the overlap: a closet inside a room's
            // bounding box is the closet's, even when it has the room's colour.
            const ownsOverlap = area(other) < area(roomBounds);
            const left = Math.max(other.left, bounds.left);
            const right = Math.min(other.right, bounds.right);
            const top = Math.max(other.top, bounds.top);
            const bottom = Math.min(other.bottom, bounds.bottom);
            for (let y = top; y <= bottom; y++) {
                for (let x = left; x <= right; x++) {
                    const inOwn = x >= roomBounds.left && x <= roomBounds.right && y >= roomBounds.top && y <= roomBounds.bottom;
                    if (!inOwn || ownsOverlap) otherOwned[(y - bounds.top) * width + x - bounds.left] = 1;
                }
            }
        });
        const own = new Uint8Array(width * height);
        const near = new Uint8Array(width * height);
        const foreignRoom = new Uint8Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                if (otherOwned[index]) {
                    foreignRoom[index] = 1;
                    continue;
                }
                const imageOffset = ((bounds.top + y) * imageData.width + bounds.left + x) * 4;
                if (imageData.data[imageOffset + 3] < 128) continue;
                const key = this.getColorKey(
                    imageData.data[imageOffset],
                    imageData.data[imageOffset + 1],
                    imageData.data[imageOffset + 2],
                );
                if (key === colorKey) own[index] = 1;
                else if (foreignColors.has(key)) foreignRoom[index] = 1;
                if (this._nearKey(key, colorKey)) near[index] = 1;
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
                if (!grown[index]) continue;
                const toEdge = Math.min(x + 1, y + 1, width - x, height - y);
                if (Math.min(toOutside[index], toEdge) <= radius) continue;
                // Solidity ignores colour barriers: lanes of a path colour that is a candidate
                // colour still close into a solid fill there.
                near[index] = 1;
                if (!foreignRoom[index]) mask[index] = 1;
            }
        }
        for (let index = 0; index < near.length; index++) if (mask[index]) near[index] = 1;
        return { bounds, width, height, mask, near, distance };
    }

    /** 8-connected patches of an area's mask, with how much of each lies inside `roomBounds`. */
    private static _components(area: RoomArea, roomBounds: PixelBounds): ColorComponent[] {
        const { width, height, mask, bounds } = area;
        const visited = new Uint8Array(mask.length);
        const queue = new Int32Array(mask.length);
        const solidAt = this._solidBlocks(area.near, width, height);
        const components: ColorComponent[] = [];
        // A window side that is not the image's own edge: a patch touching it runs past the margin.
        const clipLeft = bounds.left < roomBounds.left - (BOUNDS_MARGIN - 1);
        const clipTop = bounds.top < roomBounds.top - (BOUNDS_MARGIN - 1);
        const clipRight = bounds.right > roomBounds.right + (BOUNDS_MARGIN - 1);
        const clipBottom = bounds.bottom > roomBounds.bottom + (BOUNDS_MARGIN - 1);
        for (let start = 0; start < mask.length; start++) {
            if (!mask[start] || visited[start]) continue;
            const tail = this._floodFill8(mask, visited, width, height, start, queue);
            let inside = 0;
            let clipped = false;
            let solid = false;
            for (let position = 0; position < tail; position++) {
                const index = queue[position];
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
                if (solidAt[index]) solid = true;
                if ((clipLeft && x === 0) || (clipTop && y === 0) || (clipRight && x === width - 1) || (clipBottom && y === height - 1)) {
                    clipped = true;
                }
            }
            components.push({ pixels: queue.slice(0, tail), inside, clipped, solid });
        }
        return components;
    }

    /** Colour keys at most one quantisation step apart on every channel. */
    private static _nearKey(key: number, other: number): boolean {
        return (
            Math.abs((key >> 10) - (other >> 10)) <= 1 &&
            Math.abs(((key >> 5) & 31) - ((other >> 5) & 31)) <= 1 &&
            Math.abs((key & 31) - (other & 31)) <= 1
        );
    }

    /** 1 at the centre of every 5 x 5 block that lies wholly in the mask. */
    private static _solidBlocks(mask: Uint8Array, width: number, height: number): Uint8Array {
        const horizontal = new Uint8Array(mask.length);
        for (let y = 0; y < height; y++) {
            let run = 0;
            for (let x = 0; x < width; x++) {
                run = mask[y * width + x] ? run + 1 : 0;
                if (run >= 5) horizontal[y * width + x - 2] = 1;
            }
        }
        const solid = new Uint8Array(mask.length);
        for (let x = 0; x < width; x++) {
            let run = 0;
            for (let y = 0; y < height; y++) {
                run = horizontal[y * width + x] ? run + 1 : 0;
                if (run >= 5) solid[(y - 2) * width + x] = 1;
            }
        }
        return solid;
    }

    /**
     * Writes a room's chosen patch into the image-wide label map. A pixel two rooms claim goes to the
     * one whose own colour is nearer, then to the one whose bounds contain it.
     */
    private static _labelChosen(
        area: RoomArea,
        components: ColorComponent[],
        option: RoomOption,
        label: number,
        labels: Int16Array,
        priority: Uint8Array,
        imageWidth: number,
    ): void {
        const roomBounds = option.candidate.bounds;
        const chosen = this._findChosen(components, option);
        if (!chosen) return;
        chosen.pixels.forEach(index => {
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
    }

    /**
     * Adds the other patches of a room's colour that lie almost wholly inside its bounds (a room split
     * by a wide obstacle). Written after every room's chosen patch, and only where nothing is
     * labelled: a patch that touches another room's pixels or an undetected room's shape is that
     * room's, not this one's (a same-coloured closet inside the room's bounding box).
     */
    private static _labelSecondary(
        area: RoomArea,
        components: ColorComponent[],
        option: RoomOption,
        label: number,
        labels: Int16Array,
        reserved: Uint8Array,
        imageWidth: number,
    ): void {
        const chosen = this._findChosen(components, option);
        components.forEach(component => {
            if (component === chosen || component.clipped || component.inside * 10 < component.pixels.length * 9) return;
            const imageIndexes = component.pixels.map(index => this._toImageIndex(area, index, imageWidth));
            if (imageIndexes.some(index => reserved[index] || (labels[index] >= 0 && labels[index] !== label))) return;
            imageIndexes.forEach(index => {
                if (labels[index] < 0) labels[index] = label;
            });
        });
    }

    /**
     * The chosen patch in an area's components. The final area can differ from the one the patch was
     * scored in (fewer colours are barriers once rooms are assigned); there it is the patch that
     * contains the same seed pixel.
     */
    private static _findChosen(components: ColorComponent[], option: RoomOption): ColorComponent | undefined {
        if (components.includes(option.component)) return option.component;
        const seed = option.component.pixels[0];
        return components.find(component => component.pixels.includes(seed));
    }

    /** Marks the metadata shapes of rooms that were not detected. */
    private static _reserve(entries: RoomEntry[], width: number, height: number): Uint8Array {
        const reserved = new Uint8Array(width * height);
        entries.forEach(entry => {
            const { bounds, polygon } = entry;
            for (let y = bounds.top; y <= bounds.bottom; y++) {
                for (let x = bounds.left; x <= bounds.right; x++) {
                    if (this._contains(polygon, x + 0.5, y + 0.5)) reserved[y * width + x] = 1;
                }
            }
        });
        return reserved;
    }

    private static _contains(polygon: PointType[], x: number, y: number): boolean {
        let inside = false;
        for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
            const [xi, yi] = polygon[index];
            const [xj, yj] = polygon[previous];
            if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
    }

    /**
     * Gives an unlabelled area that rooms enclose on every side (it does not reach the image edge)
     * to the nearest enclosing room whose bounds contain it: the robot, a room icon or name,
     * furniture, a no-go zone. Floor outside every room's bounds (an unsegmented hallway) stays
     * unlabelled, and so does an undetected room's shape. The robot on a threshold is split between
     * the two rooms it covers.
     */
    private static _fillEnclosedAreas(labels: Int16Array, width: number, height: number, grow: GrowLimits): void {
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
                if (x > 0 && !visited[index - 1] && labels[index - 1] < 0) {
                    visited[index - 1] = 1;
                    queue[tail++] = index - 1;
                }
                if (x < width - 1 && !visited[index + 1] && labels[index + 1] < 0) {
                    visited[index + 1] = 1;
                    queue[tail++] = index + 1;
                }
                if (y > 0 && !visited[index - width] && labels[index - width] < 0) {
                    visited[index - width] = 1;
                    queue[tail++] = index - width;
                }
                if (y < height - 1 && !visited[index + width] && labels[index + width] < 0) {
                    visited[index + width] = 1;
                    queue[tail++] = index + width;
                }
            }
            if (open || tail > limit) continue;
            this._growLabels(labels, width, height, queue.subarray(0, tail), Number.MAX_SAFE_INTEGER, grow);
        }
    }

    /**
     * Lets a tap on something drawn at a room's edge reach the room: unlabelled pixels that are not
     * the image background take the nearest room label within `TAP_REACH` pixels, inside that room's
     * bounds. The background is the colour that dominates the image border (or transparency),
     * matched with a tolerance so a lossy image's noise is still background.
     */
    private static _extendTapReach(labels: Int16Array, imageData: ImageDataLike, grow: GrowLimits): void {
        const { width, height } = imageData;
        const isBackground = this._backgroundTest(imageData);
        const targets: number[] = [];
        for (let index = 0; index < labels.length; index++) {
            if (labels[index] < 0 && !isBackground(index * 4)) targets.push(index);
        }
        this._growLabels(labels, width, height, Int32Array.from(targets), TAP_REACH, grow);
    }

    /**
     * Whether a pixel is the image background: transparent, or within `BACKGROUND_TOLERANCE` per
     * channel of a colour that covers at least a tenth of the image border. Border colours are
     * grouped coarsely (16 levels per channel) so noise does not split them below that share.
     */
    private static _backgroundTest(imageData: ImageDataLike): (offset: number) => boolean {
        const { width, height, data } = imageData;
        const groups = new Map<number, { count: number; red: number; green: number; blue: number }>();
        let total = 0;
        const count = (x: number, y: number): void => {
            const offset = (y * width + x) * 4;
            total++;
            if (data[offset + 3] < 128) return;
            const key = ((data[offset] >> 4) << 8) | ((data[offset + 1] >> 4) << 4) | (data[offset + 2] >> 4);
            const group = groups.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
            group.count++;
            group.red += data[offset];
            group.green += data[offset + 1];
            group.blue += data[offset + 2];
            groups.set(key, group);
        };
        for (let x = 0; x < width; x++) {
            count(x, 0);
            count(x, height - 1);
        }
        for (let y = 1; y < height - 1; y++) {
            count(0, y);
            count(width - 1, y);
        }
        const colors: Array<[number, number, number]> = [];
        groups.forEach(group => {
            if (group.count * 10 >= total) colors.push([group.red / group.count, group.green / group.count, group.blue / group.count]);
        });
        return (offset: number): boolean =>
            data[offset + 3] < 128 ||
            colors.some(
                color =>
                    Math.abs(data[offset] - color[0]) <= BACKGROUND_TOLERANCE &&
                    Math.abs(data[offset + 1] - color[1]) <= BACKGROUND_TOLERANCE &&
                    Math.abs(data[offset + 2] - color[2]) <= BACKGROUND_TOLERANCE,
            );
    }

    /**
     * Multi-source breadth-first growth of room labels into `targets` (unlabelled pixels), up to
     * `reach` steps (8-connected). Each target takes the label of the nearest room whose bounds
     * contain it; reserved pixels (an undetected room's shape) are never taken.
     */
    private static _growLabels(
        labels: Int16Array,
        width: number,
        height: number,
        targets: Int32Array,
        reach: number,
        grow: GrowLimits,
    ): void {
        if (targets.length === 0) return;
        const isTarget = new Uint8Array(labels.length);
        targets.forEach(index => {
            if (!grow.reserved[index]) isTarget[index] = 1;
        });
        const canTake = (label: number, index: number): boolean => {
            const bounds = grow.labelBounds[label];
            const x = index % width;
            const y = (index - x) / width;
            return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
        };
        let frontier: number[] = [];
        const seen = new Uint8Array(labels.length);
        // Seed with labelled pixels that touch a target.
        targets.forEach(index => {
            if (!isTarget[index]) return;
            const x = index % width;
            const y = (index - x) / width;
            for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                    const neighbor = ny * width + nx;
                    if (labels[neighbor] >= 0 && !isTarget[neighbor] && !seen[neighbor]) {
                        seen[neighbor] = 1;
                        frontier.push(neighbor);
                    }
                }
            }
        });
        for (let step = 0; step < reach && frontier.length > 0; step++) {
            const next: number[] = [];
            frontier.forEach(index => {
                const label = labels[index];
                const x = index % width;
                const y = (index - x) / width;
                for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
                    for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
                        const neighbor = ny * width + nx;
                        if (!isTarget[neighbor] || labels[neighbor] >= 0 || !canTake(label, neighbor)) continue;
                        labels[neighbor] = label;
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
            const tail = this._floodFill8(mask, visited, width, height, start, queue);
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

    /**
     * Chebyshev (8-neighbour) distance to the nearest set pixel, capped at `cap` (at most 255). Two
     * raster passes (a chamfer transform), which is exact for the chessboard metric.
     */
    private static _chebyshevDistance(source: Uint8Array, width: number, height: number, cap: number): Uint8Array {
        const distance = new Uint8Array(source.length);
        for (let y = 0; y < height; y++) {
            const row = y * width;
            for (let x = 0; x < width; x++) {
                const index = row + x;
                if (source[index]) continue;
                let best = cap;
                if (x > 0 && distance[index - 1] + 1 < best) best = distance[index - 1] + 1;
                if (y > 0) {
                    const above = index - width;
                    if (distance[above] + 1 < best) best = distance[above] + 1;
                    if (x > 0 && distance[above - 1] + 1 < best) best = distance[above - 1] + 1;
                    if (x < width - 1 && distance[above + 1] + 1 < best) best = distance[above + 1] + 1;
                }
                distance[index] = best;
            }
        }
        for (let y = height - 1; y >= 0; y--) {
            const row = y * width;
            for (let x = width - 1; x >= 0; x--) {
                const index = row + x;
                let best = distance[index];
                if (best === 0) continue;
                if (x < width - 1 && distance[index + 1] + 1 < best) best = distance[index + 1] + 1;
                if (y < height - 1) {
                    const below = index + width;
                    if (distance[below] + 1 < best) best = distance[below] + 1;
                    if (x > 0 && distance[below - 1] + 1 < best) best = distance[below - 1] + 1;
                    if (x < width - 1 && distance[below + 1] + 1 < best) best = distance[below + 1] + 1;
                }
                distance[index] = best;
            }
        }
        return distance;
    }

    /**
     * Flood-fills the 8-connected patch of `mask` that contains `start` into `queue` and marks it in
     * `visited`. Returns the patch's size; its pixels are `queue[0..size)`.
     */
    private static _floodFill8(
        mask: Uint8Array,
        visited: Uint8Array,
        width: number,
        height: number,
        start: number,
        queue: Int32Array,
    ): number {
        const length = width * height;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        visited[start] = 1;
        while (head < tail) {
            const index = queue[head++];
            const x = index % width;
            const hasLeft = x > 0;
            const hasRight = x < width - 1;
            for (let row = -1; row <= 1; row++) {
                const centre = index + row * width;
                if (centre < 0 || centre >= length) continue;
                if (hasLeft && mask[centre - 1] && !visited[centre - 1]) {
                    visited[centre - 1] = 1;
                    queue[tail++] = centre - 1;
                }
                if (row !== 0 && mask[centre] && !visited[centre]) {
                    visited[centre] = 1;
                    queue[tail++] = centre;
                }
                if (hasRight && mask[centre + 1] && !visited[centre + 1]) {
                    visited[centre + 1] = 1;
                    queue[tail++] = centre + 1;
                }
            }
        }
        return tail;
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
