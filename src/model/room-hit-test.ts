import { CoordinatesConverter } from "./map_objects/coordinates-converter";
import { RoomColorDetection, RoomColorDetector } from "./room-color-detector";

/** A room that has no detected region: its tap target is its configured or metadata outline. */
export interface FallbackRoomTarget {
    readonly id: string;
    /** Vacuum coordinates. */
    readonly outline: ReadonlyArray<readonly [number, number]>;
}

/**
 * The room a tap at an image pixel selects. The detection's per-pixel room map wins: it is drawn
 * from the map itself. Rooms the detector did not find keep their outline as a target, but such an
 * outline is often only a bounding box that overlaps detected neighbours, so it is consulted only
 * where no detected room is drawn. Among overlapping outlines the smallest one wins, so a room
 * nested in another's bounding box stays reachable.
 */
export function roomIdAtImagePoint(
    detection: RoomColorDetection | undefined,
    fallbacks: readonly FallbackRoomTarget[],
    converter: CoordinatesConverter | undefined,
    x: number,
    y: number,
): string | undefined {
    const detected = detection ? RoomColorDetector.roomIdAt(detection, x, y) : undefined;
    if (detected !== undefined) return detected;
    if (!converter || fallbacks.length === 0) return undefined;
    // Pixel centre, in vacuum coordinates: containment survives the calibration's affine transform.
    const [vacuumX, vacuumY] = converter.mapToVacuum(Math.floor(x) + 0.5, Math.floor(y) + 0.5);
    let best: string | undefined;
    let bestArea = Number.POSITIVE_INFINITY;
    fallbacks.forEach(target => {
        if (target.outline.length < 3 || !contains(target.outline, vacuumX, vacuumY)) return;
        const area = Math.abs(polygonArea(target.outline));
        if (area < bestArea) {
            bestArea = area;
            best = target.id;
        }
    });
    return best;
}

function contains(polygon: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const [xi, yi] = polygon[index];
        const [xj, yj] = polygon[previous];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function polygonArea(polygon: ReadonlyArray<readonly [number, number]>): number {
    let area = 0;
    polygon.forEach((point, index) => {
        const next = polygon[(index + 1) % polygon.length];
        area += point[0] * next[1] - next[0] * point[1];
    });
    return area / 2;
}
