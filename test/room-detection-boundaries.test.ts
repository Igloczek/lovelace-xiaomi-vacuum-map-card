/**
 * Room boundaries when rooms share a colour, sit inside each other's bounding boxes, or are not
 * detected at all.
 *
 * Detection must never give a tap to the wrong room: on a vacuum that means cleaning the wrong
 * room, which is worse than selecting nothing. Each scenario here came from a review of the
 * shared-colour detection: a closing that bridged a thin wall into a same-coloured neighbour, a
 * secondary patch that swallowed a same-coloured closet, and enclosed-area filling and tap reach that
 * handed an undetected room's floor to its detected neighbour.
 */
import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { RoomColorDetection, RoomColorDetector } from "../src/model/room-color-detector";
import { roomIdAtImagePoint } from "../src/model/room-hit-test";
import type { MapExtractorRoom } from "../src/types/types";
import { Rect, Rgb, SyntheticMap, roomBounds, syntheticMapCalibration, VACUUM_UNITS_PER_PIXEL } from "./harness/synthetic-map";

const WALL: Rgb = [93, 109, 126];
const OUTSIDE: [number, number, number, number] = [19, 87, 148, 255];
const BLUE: Rgb = [133, 193, 233];
const ORANGE: Rgb = [240, 178, 122];
const GREY: Rgb = [180, 180, 180];

function converterFor(map: SyntheticMap): CoordinatesConverter {
    return new CoordinatesConverter(syntheticMapCalibration(map.width, map.height));
}

function detect(map: SyntheticMap, rooms: Record<string, Rect>): RoomColorDetection | undefined {
    const metadata = Object.fromEntries(Object.entries(rooms).map(([id, rect]) => [id, roomBounds(rect)]));
    return RoomColorDetector.detectFromImageData(map, metadata, converterFor(map));
}

function detectedIds(detection: RoomColorDetection | undefined): string[] {
    return (detection?.regions ?? []).map(region => region.id).sort();
}

function tap(detection: RoomColorDetection | undefined, x: number, y: number): string | undefined {
    return detection ? RoomColorDetector.roomIdAt(detection, x, y) : undefined;
}

/** A fallback tap target for an undetected room: its metadata bounds, in vacuum units. */
function boundsOutline([left, top, right, bottom]: Rect): Array<[number, number]> {
    const scale = VACUUM_UNITS_PER_PIXEL;
    return [
        [left * scale, top * scale],
        [(right + 1) * scale, top * scale],
        [(right + 1) * scale, (bottom + 1) * scale],
        [left * scale, (bottom + 1) * scale],
    ];
}

describe("same-coloured rooms separated by a thin wall", () => {
    it.each([12, 20, 30, 60])("keeps a %i px wide room apart from its same-coloured neighbour", width => {
        const map = new SyntheticMap(200, 80, OUTSIDE);
        const second: Rect = [92, 10, 91 + width, 69];
        map.rect([10, 10, 89, 69], BLUE).rect([90, 10, 91, 69], WALL).rect(second, BLUE);
        const detection = detect(map, { "1": [10, 10, 89, 69], "2": second });
        expect(detectedIds(detection)).toEqual(["1", "2"]);
        expect(tap(detection, 50, 40)).toBe("1");
        expect(tap(detection, 92 + (width >> 1), 40)).toBe("2");
        expect(tap(detection, 93, 40)).toBe("2");
    });

    it("keeps a same-coloured closet apart from the room around it", () => {
        const map = new SyntheticMap(160, 120, OUTSIDE);
        map.rect([10, 10, 149, 109], BLUE).frame([60, 40, 91, 71], WALL, 2).rect([62, 42, 89, 69], BLUE);
        const detection = detect(map, { "1": [10, 10, 149, 109], "2": [62, 42, 89, 69] });
        expect(detectedIds(detection)).toEqual(["1", "2"]);
        expect(tap(detection, 75, 55)).toBe("2");
        expect(tap(detection, 30, 30)).toBe("1");
    });
});

describe("a same-coloured room inside a larger room's bounding box", () => {
    // Room A is colour C and spans the whole map; room X (another colour) fills A's bottom-right
    // corner, and closet Y, colour C again, sits inside X. Y touches only X.
    const TEAL: Rgb = [25, 161, 161];
    const RUST: Rgb = [223, 86, 24];

    function nestedMap(obstacle: "none" | "robot" | "furniture"): SyntheticMap {
        const map = new SyntheticMap(160, 120, [0, 0, 0, 0]);
        map.rect([10, 10, 149, 109], TEAL).rect([88, 58, 149, 109], [0, 0, 0]).rect([90, 60, 149, 109], RUST);
        map.rect([103, 73, 136, 102], [0, 0, 0]).rect([105, 75, 134, 100], TEAL);
        if (obstacle === "robot") map.disc(119, 87, 9, [255, 255, 255]);
        if (obstacle === "furniture") map.rect([112, 80, 126, 94], [0, 0, 0, 0]);
        return map;
    }

    it.each(["none", "robot", "furniture"] as const)("keeps the closet its own room with %s in it", obstacle => {
        const detection = detect(nestedMap(obstacle), {
            A: [10, 10, 149, 109],
            X: [90, 60, 149, 109],
            Y: [105, 75, 134, 100],
        });
        expect(detectedIds(detection)).toEqual(["A", "X", "Y"]);
        expect(tap(detection, 130, 95)).toBe("Y");
        expect(tap(detection, 95, 105)).toBe("X");
        expect(tap(detection, 30, 30)).toBe("A");
        // The robot or the furniture itself belongs to the closet it stands in, never to A.
        expect(tap(detection, 119, 87)).not.toBe("A");
    });
});

describe("rooms the colours do not reveal", () => {
    it("keeps an undetected closet inside a detected room for the closet", () => {
        const map = new SyntheticMap(160, 120, OUTSIDE);
        map.rect([10, 10, 149, 109], BLUE).frame([60, 40, 91, 71], WALL, 2).rect([62, 42, 89, 69], GREY);
        const closet: Rect = [62, 42, 89, 69];
        const detection = detect(map, { "1": [10, 10, 149, 109], "2": closet });
        expect(detectedIds(detection)).toEqual(["1"]);
        const fallback = [{ id: "2", outline: boundsOutline(closet) }];
        expect(roomIdAtImagePoint(detection, fallback, converterFor(map), 75, 55)).toBe("2");
        expect(roomIdAtImagePoint(detection, fallback, converterFor(map), 63, 43)).toBe("2");
        expect(roomIdAtImagePoint(detection, fallback, converterFor(map), 30, 30)).toBe("1");
    });

    it("does not let tap reach take an undetected neighbour's floor", () => {
        const map = new SyntheticMap(200, 80, OUTSIDE);
        const grey: Rect = [92, 10, 150, 69];
        map.rect([10, 10, 89, 69], BLUE).rect([90, 10, 91, 69], WALL).rect(grey, GREY);
        const detection = detect(map, { "1": [10, 10, 89, 69], "2": grey });
        const fallback = [{ id: "2", outline: boundsOutline(grey) }];
        for (const x of [92, 93, 98, 101, 110]) {
            expect(roomIdAtImagePoint(detection, fallback, converterFor(map), x, 40), `x=${x}`).toBe("2");
        }
        expect(roomIdAtImagePoint(detection, fallback, converterFor(map), 85, 40)).toBe("1");
    });
});

describe("floor that belongs to no room", () => {
    it("is not handed to the rooms around it, even when they enclose it", () => {
        const map = new SyntheticMap(200, 120, [255, 255, 255, 255]);
        map.rect([10, 10, 189, 109], [200, 200, 200]);
        map.rect([10, 10, 59, 109], BLUE).rect([110, 10, 189, 109], ORANGE);
        map.rect([60, 10, 109, 40], BLUE).rect([60, 81, 109, 109], ORANGE);
        const detection = detect(map, { "1": [10, 10, 109, 40], "2": [110, 10, 189, 109] });
        expect(tap(detection, 85, 60)).toBeUndefined();
        expect(tap(detection, 62, 45)).toBeUndefined();
    });

    it("is not reached from a room across a noisy background", () => {
        // A lossy grey background spreads over dozens of colour keys, none of them a tenth of the
        // border: exact-key background matching misses it.
        const map = new SyntheticMap(120, 80, [200, 200, 200, 255]);
        map.noise(10, 3);
        map.rect([20, 20, 79, 59], BLUE);
        const detection = detect(map, { "1": [20, 20, 79, 59] });
        expect(tap(detection, 50, 40)).toBe("1");
        for (const [x, y] of [[85, 40], [15, 40], [50, 64], [50, 15]]) {
            expect(tap(detection, x, y), `${x},${y}`).toBeUndefined();
        }
    });
});

describe("rooms metadata with an unusable outline", () => {
    it("detects a room from its bounds when its outline is not a list of points", () => {
        const map = new SyntheticMap(120, 60).rect([10, 10, 59, 49], [230, 25, 75]);
        const rooms: Record<string, MapExtractorRoom> = {
            "1": { ...roomBounds([10, 10, 59, 49]), outline: "garbage" as unknown as MapExtractorRoom["outline"] },
        };
        const detection = RoomColorDetector.detectFromImageData(map, rooms, converterFor(map));
        expect(detectedIds(detection)).toEqual(["1"]);
    });
});

describe("interlocking L-shaped rooms of different colours", () => {
    // Room A: a top bar and a left column. Room B: a right block and an arm reaching under A's bar,
    // so B's arm lies inside A's (smaller) bounding box. Their colours differ; hallways often look
    // like this. B's arm is B's, whatever the bounding boxes say.
    const A_COLOR: Rgb = [240, 178, 122];
    const B_COLOR: Rgb = BLUE;

    function interlocking(walled: boolean): RoomColorDetection | undefined {
        const map = new SyntheticMap(200, 120, OUTSIDE);
        if (walled) map.rect([8, 8, 191, 111], WALL);
        map.polygon([[10, 10], [110, 10], [110, 40], [40, 40], [40, 110], [10, 110]], A_COLOR);
        map.polygon([[112, 10], [190, 10], [190, 110], [42, 110], [42, 42], [112, 42]], B_COLOR);
        return detect(map, { A: [10, 10, 109, 109], B: [42, 10, 189, 109] });
    }

    it.each([false, true])("keeps B's arm in B (grey wall around: %s)", walled => {
        const detection = interlocking(walled);
        expect(detectedIds(detection)).toEqual(["A", "B"]);
        const outline = detection!.regions.find(region => region.id === "B")!.outline;
        expect(Math.min(...outline.map(point => point[0]))).toBeLessThanOrEqual(43);
        for (const y of [43, 45, 48, 51, 55, 70, 100]) expect(tap(detection, 80, y), `80,${y}`).toBe("B");
        expect(tap(detection, 45, 80)).toBe("B");
        expect(tap(detection, 80, 20)).toBe("A");
        expect(tap(detection, 20, 80)).toBe("A");
    });
});

describe("a neighbour's bounds that overlap the room", () => {
    it.each([3, 6, 10])("does not trim the room when a differently coloured neighbour's bounds reach %i px into it", overlap => {
        const map = new SyntheticMap(200, 80, OUTSIDE);
        map.rect([10, 10, 119, 69], ORANGE).rect([120, 10, 121, 69], WALL).rect([122, 10, 179, 69], BLUE);
        const detection = detect(map, { A: [10, 10, 119, 69], B: [122 - overlap, 10, 179, 69] });
        const outline = detection!.regions.find(region => region.id === "A")!.outline;
        expect(Math.max(...outline.map(point => point[0]))).toBeGreaterThanOrEqual(119);
        expect(tap(detection, 118, 40)).toBe("A");
    });
});

describe("growing a room over what is drawn on it", () => {
    it("never gives a room pixels of another detected room's colour", () => {
        // A fragment of B's colour enclosed by A: it may be part of B cut off by a re-map, or an
        // icon; either way it is not A, and a tap there must not select A.
        const map = new SyntheticMap(200, 80, OUTSIDE);
        map.rect([10, 10, 109, 69], ORANGE).rect([112, 10, 189, 69], BLUE).rect([60, 30, 69, 39], BLUE);
        const detection = detect(map, { A: [10, 10, 109, 69], B: [112, 10, 189, 69] });
        expect(tap(detection, 64, 34)).not.toBe("A");
        expect(tap(detection, 30, 30)).toBe("A");
    });
});
