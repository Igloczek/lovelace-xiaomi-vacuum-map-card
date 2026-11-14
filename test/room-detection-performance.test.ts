import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { RoomColorDetector } from "../src/model/room-color-detector";
import type { MapExtractorRoom } from "../src/types/types";
import { Rect, Rgb, SyntheticMap, roomBounds, syntheticMapCalibration } from "./harness/synthetic-map";

/**
 * A budget for tracing a large map, so a slow change to the detector fails here rather than as a
 * frozen wall tablet. The map is 1024 x 1024 with 20 walled rooms covered in cleaning lanes and a
 * six-colour palette that repeats. On a developer machine this takes a few hundred milliseconds;
 * the budget is several times that so a loaded CI runner does not flake, and the card reuses a
 * complete detection for newer snapshots of the same rooms (see room-detection-reuse.test.ts).
 */
const BUDGET_MS = 2500;

function largeMap(): { map: SyntheticMap; rooms: Record<string, MapExtractorRoom> } {
    const size = 1024;
    const map = new SyntheticMap(size, size, [19, 87, 148, 255]);
    const palette: Rgb[] = [[240, 178, 122], [133, 193, 233], [217, 136, 128], [88, 214, 141], [187, 143, 206], [247, 220, 111]];
    const rooms: Record<string, MapExtractorRoom> = {};
    const columns = 5;
    const rows = 4;
    const cellWidth = Math.floor((size - 40) / columns);
    const cellHeight = Math.floor((size - 40) / rows);
    let index = 0;
    for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++, index++) {
            const rect: Rect = [
                20 + column * cellWidth + 3,
                20 + row * cellHeight + 3,
                20 + (column + 1) * cellWidth - 3,
                20 + (row + 1) * cellHeight - 3,
            ];
            map.frame([rect[0] - 3, rect[1] - 3, rect[2] + 3, rect[3] + 3], [93, 109, 126], 3);
            map.rect(rect, palette[index % palette.length]);
            map.lanes([rect[0] + 4, rect[1] + 4, rect[2] - 4, rect[3] - 4], 6, [147, 194, 238], 1);
            rooms[String(index + 1)] = roomBounds(rect);
        }
    }
    return { map, rooms };
}

describe("room detection performance", () => {
    it(`traces 20 rooms on a 1024 x 1024 map within ${BUDGET_MS} ms`, () => {
        const { map, rooms } = largeMap();
        const converter = new CoordinatesConverter(syntheticMapCalibration(map.width, map.height));
        RoomColorDetector.detectFromImageData(map, rooms, converter);
        const start = performance.now();
        const detection = RoomColorDetector.detectFromImageData(map, rooms, converter);
        const elapsed = performance.now() - start;
        expect(detection?.regions).toHaveLength(20);
        expect(detection?.complete).toBe(true);
        expect(elapsed).toBeLessThan(BUDGET_MS);
    }, 30_000);
});
