import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { RoomColorDetector } from "../src/model/room-color-detector";
import { roomIdAtImagePoint } from "../src/model/room-hit-test";
import { SyntheticMap, roomBounds, syntheticMapCalibration, VACUUM_UNITS_PER_PIXEL } from "./harness/synthetic-map";

/**
 * Room taps when only some rooms were detected from the map colours. A room the detector could not
 * find (a grey fill, a colour it shares with a touching room) keeps its metadata outline as a tap
 * target, but that outline is often just a bounding box that overlaps detected neighbours. The
 * detected room drawn under the tap must win there.
 */
describe("roomIdAtImagePoint", () => {
    const scale = VACUUM_UNITS_PER_PIXEL;
    const converter = new CoordinatesConverter(syntheticMapCalibration(120, 80));
    // Room 1 is detected. Room 2 is an undetected grey room whose bounding box covers half of room 1.
    const map = new SyntheticMap(120, 80).rect([10, 10, 59, 69], [230, 25, 75]).rect([62, 10, 109, 69], [128, 128, 128]);
    const detection = RoomColorDetector.detectFromImageData(map, { "1": roomBounds([10, 10, 59, 69]) }, converter);
    const box = (left: number, top: number, right: number, bottom: number): Array<[number, number]> => [
        [left * scale, top * scale],
        [right * scale, top * scale],
        [right * scale, bottom * scale],
        [left * scale, bottom * scale],
    ];
    const fallbacks = [
        { id: "2", outline: box(35, 10, 110, 70) },
        { id: "3", outline: box(80, 20, 100, 40) },
    ];

    it("prefers the detected room drawn under the tap over an overlapping fallback outline", () => {
        expect(roomIdAtImagePoint(detection, fallbacks, converter, 45, 30)).toBe("1");
    });

    it("falls back to the outline that contains the tap, the smallest one first", () => {
        expect(roomIdAtImagePoint(detection, fallbacks, converter, 70, 60)).toBe("2");
        expect(roomIdAtImagePoint(detection, fallbacks, converter, 90, 30)).toBe("3");
    });

    it("works without a detection and selects nothing outside every room", () => {
        expect(roomIdAtImagePoint(undefined, fallbacks, converter, 90, 30)).toBe("3");
        expect(roomIdAtImagePoint(detection, fallbacks, converter, 5, 75)).toBeUndefined();
        expect(roomIdAtImagePoint(detection, [], converter, 115, 75)).toBeUndefined();
    });

    it("ignores a fallback outline it cannot use", () => {
        const broken = [{ id: "4", outline: [[0, 0]] as Array<[number, number]> }];
        expect(roomIdAtImagePoint(undefined, broken, converter, 0, 0)).toBeUndefined();
    });
});
