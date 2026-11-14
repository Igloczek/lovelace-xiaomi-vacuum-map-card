/**
 * Room detection against what each map source actually draws.
 *
 * The first detector tests used one clean PNG of three flat rectangles, which is why cleaning paths
 * splitting a room went unnoticed. Every scenario here paints one source's map style with
 * `SyntheticMap` (no real user's map is committed) and checks the three things the card builds from
 * a detection: the outline, the label point and the room under a tap.
 */
import { describe, expect, it } from "vitest";

import { CoordinatesConverter } from "../src/model/map_objects/coordinates-converter";
import { RoomColorDetection, RoomColorDetector } from "../src/model/room-color-detector";
import type { MapExtractorRoom, PointType } from "../src/types/types";
import {
    Rect,
    Rgb,
    SyntheticMap,
    roomBounds,
    syntheticMapCalibration,
    VACUUM_UNITS_PER_PIXEL,
} from "./harness/synthetic-map";

function detect(map: SyntheticMap, rooms: Record<string, MapExtractorRoom>): RoomColorDetection | undefined {
    const converter = new CoordinatesConverter(syntheticMapCalibration(map.width, map.height));
    return RoomColorDetector.detectFromImageData(map, rooms, converter);
}

function boundsOf(points: PointType[]): Rect {
    return [
        Math.min(...points.map(point => point[0])),
        Math.min(...points.map(point => point[1])),
        Math.max(...points.map(point => point[0])) - 1,
        Math.max(...points.map(point => point[1])) - 1,
    ];
}

function region(detection: RoomColorDetection | undefined, id: string) {
    const found = detection?.regions.find(candidate => candidate.id === id);
    if (!found) throw new Error(`room ${id} was not detected (detected: ${detection?.regions.map(r => r.id).join(", ")})`);
    return found;
}

/** The outline covers the room's drawn rectangle, within `tolerance` pixels on every edge. */
function expectOutline(detection: RoomColorDetection | undefined, id: string, rect: Rect, tolerance = 1): void {
    const bounds = boundsOf(region(detection, id).outline);
    rect.forEach((edge, index) => {
        expect(Math.abs(bounds[index] - edge), `room ${id} outline ${bounds} vs drawn ${rect}`).toBeLessThanOrEqual(
            tolerance,
        );
    });
}

/** The label point sits on the room itself, so the name and order badge are drawn over it. */
function expectLabelInside(detection: RoomColorDetection | undefined, id: string): void {
    const [x, y] = region(detection, id).center;
    expect(RoomColorDetector.roomIdAt(detection!, Math.floor(x), Math.floor(y)), `room ${id} label at ${x},${y}`).toBe(id);
}

function expectTap(detection: RoomColorDetection | undefined, x: number, y: number, id: string | undefined): void {
    expect(RoomColorDetector.roomIdAt(detection!, x, y), `tap at ${x},${y}`).toBe(id);
}

function centreOf([left, top, right, bottom]: Rect): [number, number] {
    return [Math.floor((left + right) / 2), Math.floor((top + bottom) / 2)];
}

/** Paints rooms with walls around each one, like every source draws the floor plan. */
function floorPlan(
    width: number,
    height: number,
    background: [number, number, number, number],
    rooms: Array<{ rect: Rect; color: Rgb }>,
    wall: Rgb,
    wallWidth: number,
): SyntheticMap {
    const map = new SyntheticMap(width, height, background);
    rooms.forEach(room => {
        const [left, top, right, bottom] = room.rect;
        map.frame([left - wallWidth, top - wallWidth, right + wallWidth, bottom + wallWidth], wall, wallWidth);
        map.rect(room.rect, room.color);
    });
    return map;
}

describe("Xiaomi Cloud Map Extractor style", () => {
    // The extractor's defaults: a blue outside, grey walls, a light-blue path, a green robot and a
    // turquoise charger. Its default room palette repeats colours (room 2 and room 12 share one).
    const OUTSIDE: [number, number, number, number] = [19, 87, 148, 255];
    const WALL: Rgb = [93, 109, 126];
    const PATH: Rgb = [147, 194, 238];
    const ROBOT: Rgb = [75, 235, 149];
    const CHARGER: Rgb = [102, 254, 218];
    const NO_GO: Rgb = [255, 33, 55];
    const VIRTUAL_WALL: Rgb = [255, 0, 0];
    const ROOMS = {
        "16": { rect: [12, 12, 101, 81] as Rect, color: [240, 178, 122] as Rgb },
        "17": { rect: [108, 12, 187, 81] as Rect, color: [133, 193, 233] as Rgb },
        "18": { rect: [12, 88, 101, 147] as Rect, color: [217, 136, 128] as Rgb },
        // Same colour as 17, not touching it: the extractor's palette repeats.
        "19": { rect: [108, 88, 187, 147] as Rect, color: [88, 214, 141] as Rgb },
        "20": { rect: [194, 88, 247, 147] as Rect, color: [133, 193, 233] as Rgb },
    };

    function extractorMap(): SyntheticMap {
        const map = floorPlan(260, 160, OUTSIDE, Object.values(ROOMS), WALL, 3);
        // A run over three rooms, a long path across the whole floor, a no-go zone, a virtual wall.
        map.lanes([16, 16, 97, 77], 6, PATH, 1);
        map.lanes([112, 92, 183, 143], 5, PATH, 2);
        map.line(20, 40, 240, 120, PATH, 1);
        map.blendRect([30, 100, 60, 130], NO_GO, 0.5).frame([30, 100, 60, 130], NO_GO, 1);
        map.line(150, 20, 150, 75, VIRTUAL_WALL, 2);
        // The robot in the middle of room 17 and the charger against room 16's wall.
        map.disc(148, 46, 7, ROBOT);
        map.disc(148, 46, 3, [255, 255, 255]);
        map.disc(56, 14, 5, CHARGER);
        return map;
    }

    function rooms(): Record<string, MapExtractorRoom> {
        return Object.fromEntries(Object.entries(ROOMS).map(([id, room]) => [id, roomBounds(room.rect, `Room ${id}`)]));
    }

    it("detects every room, including two that share a palette colour", () => {
        const detection = detect(extractorMap(), rooms());
        expect(detection?.regions.map(found => found.id).sort()).toEqual(["16", "17", "18", "19", "20"]);
        Object.entries(ROOMS).forEach(([id, room]) => {
            expectOutline(detection, id, room.rect);
            expectLabelInside(detection, id);
        });
    });

    it("selects the room under the robot, the charger, a path, a virtual wall and a no-go zone", () => {
        const detection = detect(extractorMap(), rooms());
        expectTap(detection, 148, 46, "17"); // robot centre
        expectTap(detection, 142, 46, "17"); // robot body
        expectTap(detection, 56, 15, "16"); // charger against the wall
        expectTap(detection, 150, 30, "17"); // virtual wall
        expectTap(detection, 45, 115, "18"); // middle of the no-go zone
        expectTap(detection, 140, 100, "19"); // path lane
        expectTap(...([detection, ...centreOf(ROOMS["20"].rect)] as const), "20");
    });

    it("leaves the outside and the walls between rooms unselectable from afar", () => {
        const detection = detect(extractorMap(), rooms());
        expectTap(detection, 2, 2, undefined);
        expectTap(detection, 255, 40, undefined);
        expectTap(detection, 230, 30, undefined); // outside, right of room 17
    });
});

describe("Valetudo style", () => {
    // Valetudo colours segments with four colours so that touching segments differ: most maps
    // reuse every colour. The background is transparent, the path white, walls black.
    const PALETTE: Rgb[] = [
        [25, 161, 161],
        [122, 192, 55],
        [223, 86, 24],
        [247, 200, 65],
    ];
    const ROOMS: Record<string, { rect: Rect; color: Rgb }> = {
        "1": { rect: [10, 10, 69, 59], color: PALETTE[0] },
        "2": { rect: [72, 10, 131, 59], color: PALETTE[1] },
        "3": { rect: [134, 10, 193, 59], color: PALETTE[0] },
        "4": { rect: [10, 62, 69, 111], color: PALETTE[2] },
        "5": { rect: [72, 62, 131, 111], color: PALETTE[3] },
        "6": { rect: [134, 62, 193, 111], color: PALETTE[2] },
        "7": { rect: [196, 10, 239, 111], color: PALETTE[3] },
    };

    function valetudoMap(): SyntheticMap {
        const map = floorPlan(250, 122, [0, 0, 0, 0], Object.values(ROOMS), [0, 0, 0], 2);
        map.lanes([12, 12, 128, 108], 4, [255, 255, 255], 2);
        map.disc(101, 86, 8, [255, 255, 255], true);
        map.disc(101, 86, 5, [60, 60, 60], true);
        return map;
    }

    function rooms(): Record<string, MapExtractorRoom> {
        return Object.fromEntries(Object.entries(ROOMS).map(([id, room]) => [id, roomBounds(room.rect)]));
    }

    it("detects every room although the four palette colours repeat", () => {
        const detection = detect(valetudoMap(), rooms());
        expect(detection?.regions.map(found => found.id).sort()).toEqual(Object.keys(ROOMS).sort());
        Object.entries(ROOMS).forEach(([id, room]) => {
            expectOutline(detection, id, room.rect);
            expectLabelInside(detection, id);
        });
    });

    it("maps each tap to the room drawn there, not to another room of the same colour", () => {
        const detection = detect(valetudoMap(), rooms());
        Object.entries(ROOMS).forEach(([id, room]) => expectTap(detection, ...centreOf(room.rect), id));
        expectTap(detection, 101, 86, "5"); // robot centre
        expectTap(detection, 245, 60, undefined); // transparent outside
    });
});

describe("Dreame style", () => {
    // Dreame renders smoothed (anti-aliased) rooms from a four-colour palette and draws each room's
    // icon and name inside it.
    const PALETTE: Rgb[] = [
        [171, 199, 248],
        [249, 224, 125],
        [184, 227, 255],
        [255, 194, 135],
    ];
    const ROOMS: Record<string, { rect: Rect; color: Rgb }> = {
        "1": { rect: [10, 10, 99, 79], color: PALETTE[0] },
        "2": { rect: [103, 10, 179, 79], color: PALETTE[1] },
        "3": { rect: [10, 83, 99, 149], color: PALETTE[3] },
        "4": { rect: [103, 83, 179, 149], color: PALETTE[0] },
    };

    function dreameMap(): SyntheticMap {
        const map = floorPlan(190, 160, [0, 0, 0, 0], Object.values(ROOMS), [80, 80, 80], 2);
        Object.values(ROOMS).forEach(room => {
            const [x, y] = centreOf(room.rect);
            map.disc(x, y, 11, [255, 255, 255], true);
            map.rect([x - 4, y - 5, x + 4, y + 3], [90, 90, 90]);
            map.rect([x - 16, y + 14, x + 16, y + 19], [60, 60, 60]);
        });
        map.disc(140, 30, 8, [255, 255, 255], true);
        return map.antialiasEdges();
    }

    function rooms(): Record<string, MapExtractorRoom> {
        return Object.fromEntries(Object.entries(ROOMS).map(([id, room]) => [id, roomBounds(room.rect)]));
    }

    it("detects rooms with icons, names and smoothed edges", () => {
        const detection = detect(dreameMap(), rooms());
        expect(detection?.regions.map(found => found.id).sort()).toEqual(["1", "2", "3", "4"]);
        Object.entries(ROOMS).forEach(([id, room]) => {
            expectOutline(detection, id, room.rect, 2);
            expectLabelInside(detection, id);
        });
    });

    it("selects the room under its own icon and name", () => {
        const detection = detect(dreameMap(), rooms());
        Object.entries(ROOMS).forEach(([id, room]) => {
            const [x, y] = centreOf(room.rect);
            expectTap(detection, x, y, id);
            expectTap(detection, x, y + 16, id);
        });
        expectTap(detection, 140, 30, "2");
    });
});

describe("room shapes and neighbours", () => {
    it("labels an L-shaped room on itself, not on the room inside its bounding box", () => {
        const map = new SyntheticMap(160, 120);
        // Room 1 is an L around room 2: its bounding box is mostly room 2.
        const lShape: Array<[number, number]> = [[10, 10], [150, 10], [150, 30], [30, 30], [30, 110], [10, 110]];
        map.polygon(lShape, [230, 25, 75]);
        map.rect([32, 32, 150, 110], [60, 180, 75]);
        const detection = detect(map, {
            "1": roomBounds([10, 10, 149, 109]),
            "2": roomBounds([32, 32, 150, 110]),
        });
        expectLabelInside(detection, "1");
        expectLabelInside(detection, "2");
        expectTap(detection, 90, 70, "2");
        expectTap(detection, 20, 70, "1");
    });

    it("labels a U-shaped room on itself", () => {
        const map = new SyntheticMap(120, 100);
        const uShape: Array<[number, number]> = [[10, 10], [30, 10], [30, 70], [90, 70], [90, 10], [110, 10], [110, 90], [10, 90]];
        map.polygon(uShape, [67, 99, 216]);
        const detection = detect(map, { "1": roomBounds([10, 10, 109, 89]) });
        expectLabelInside(detection, "1");
    });

    it("splits touching rooms with no wall between them at their colour boundary", () => {
        const map = new SyntheticMap(120, 60);
        map.rect([10, 10, 59, 49], [230, 25, 75]).rect([60, 10, 109, 49], [60, 180, 75]);
        map.disc(60, 30, 6, [70, 70, 70]); // the robot on the threshold
        const detection = detect(map, { "1": roomBounds([10, 10, 59, 49]), "2": roomBounds([60, 10, 109, 49]) });
        expectOutline(detection, "1", [10, 10, 59, 49]);
        expectOutline(detection, "2", [60, 10, 109, 49]);
        expectTap(detection, 57, 30, "1");
        expectTap(detection, 62, 30, "2");
    });

    it("keeps rooms of nearly the same colour apart", () => {
        const map = new SyntheticMap(120, 60);
        map.rect([10, 10, 59, 49], [230, 25, 75]).rect([60, 10, 109, 49], [226, 29, 82]);
        const detection = detect(map, { "1": roomBounds([10, 10, 59, 49]), "2": roomBounds([60, 10, 109, 49]) });
        expectOutline(detection, "1", [10, 10, 59, 49]);
        expectOutline(detection, "2", [60, 10, 109, 49]);
    });

    it("detects a tiny room next to a large one", () => {
        const map = new SyntheticMap(120, 80);
        map.rect([10, 10, 99, 69], [230, 25, 75]).frame([101, 10, 110, 17], [80, 80, 80]).rect([102, 11, 109, 16], [60, 180, 75]);
        const detection = detect(map, { "1": roomBounds([10, 10, 99, 69]), "2": roomBounds([102, 11, 109, 16]) });
        expectOutline(detection, "2", [102, 11, 109, 16]);
        expectTap(detection, 105, 13, "2");
    });

    it("selects the room through furniture and obstacles drawn inside it", () => {
        const map = new SyntheticMap(120, 90);
        map.rect([10, 10, 109, 79], [230, 25, 75]);
        // A sofa (background colour), a table and an obstacle icon fully inside the room.
        map.rect([20, 20, 49, 34], [255, 255, 255]);
        map.rect([70, 40, 89, 59], [120, 120, 120]);
        map.disc(40, 60, 6, [255, 200, 0]);
        const detection = detect(map, { "1": roomBounds([10, 10, 109, 79]) });
        expectOutline(detection, "1", [10, 10, 109, 79]);
        expectTap(detection, 35, 27, "1");
        expectTap(detection, 80, 50, "1");
        expectTap(detection, 40, 60, "1");
    });

    it("selects the room under a robot that straddles two rooms", () => {
        const map = new SyntheticMap(120, 60);
        map.rect([10, 10, 58, 49], [230, 25, 75]).rect([61, 10, 109, 49], [60, 180, 75]);
        map.rect([59, 10, 60, 49], [80, 80, 80]); // wall
        map.disc(60, 30, 8, [75, 235, 149]);
        const detection = detect(map, { "1": roomBounds([10, 10, 58, 49]), "2": roomBounds([61, 10, 109, 49]) });
        expectTap(detection, 55, 30, "1");
        expectTap(detection, 65, 30, "2");
    });
});

describe("transparent_background", () => {
    it("still selects the room through a near-white path made transparent", () => {
        const map = new SyntheticMap(120, 90);
        map.rect([10, 10, 109, 79], [60, 180, 75]);
        map.lanes([14, 14, 105, 75], 6, [252, 252, 252], 2);
        map.disc(60, 45, 7, [255, 255, 255]);
        map.makeNearWhiteTransparent();
        const detection = detect(map, { "1": roomBounds([10, 10, 109, 79]) });
        expectOutline(detection, "1", [10, 10, 109, 79]);
        expectTap(detection, 60, 45, "1");
        expectTap(detection, 30, 14, "1");
        expectTap(detection, 5, 5, undefined);
    });
});

describe("camera rooms metadata", () => {
    function twoRoomMap(): SyntheticMap {
        return new SyntheticMap(120, 60).rect([10, 10, 59, 49], [230, 25, 75]).rect([62, 10, 109, 49], [60, 180, 75]);
    }

    it("ignores entries it cannot use instead of throwing", () => {
        const garbage = {
            "1": roomBounds([10, 10, 59, 49]),
            "2": roomBounds([62, 10, 109, 49]),
            "3": null,
            "4": "kitchen",
            "5": { x0: "left", y0: 100, x1: 300, y1: 300 },
            "6": { x0: Number.NaN, y0: 0, x1: 10, y1: 10 },
            "7": { outline: "not an outline" },
            "8": { x0: 1e12, y0: 1e12, x1: 2e12, y1: 2e12 },
        } as unknown as Record<string, MapExtractorRoom>;
        const detection = detect(twoRoomMap(), garbage);
        expect(detection?.regions.map(found => found.id).sort()).toEqual(["1", "2"]);
    });

    it("accepts bounds published as numeric text", () => {
        const text = (rect: Rect): MapExtractorRoom => {
            const bounds = roomBounds(rect);
            return { ...bounds, x0: String(bounds.x0), y0: String(bounds.y0), x1: String(bounds.x1), y1: String(bounds.y1) } as unknown as MapExtractorRoom;
        };
        const detection = detect(twoRoomMap(), { "1": text([10, 10, 59, 49]), "2": roomBounds([62, 10, 109, 49]) });
        expectOutline(detection, "1", [10, 10, 59, 49]);
    });

    it("accepts bounds given in either corner order", () => {
        const flipped = (rect: Rect): MapExtractorRoom => {
            const bounds = roomBounds(rect);
            return { ...bounds, x0: bounds.x1, x1: bounds.x0, y0: bounds.y1, y1: bounds.y0 };
        };
        const detection = detect(twoRoomMap(), { "1": flipped([10, 10, 59, 49]), "2": flipped([62, 10, 109, 49]) });
        expectOutline(detection, "1", [10, 10, 59, 49]);
        expectOutline(detection, "2", [62, 10, 109, 49]);
    });

    it("leaves rooms that bring their own outline to that outline", () => {
        const scale = VACUUM_UNITS_PER_PIXEL;
        const outline = [[10 * scale, 10 * scale], [60 * scale, 10 * scale], [60 * scale, 50 * scale], [10 * scale, 50 * scale]];
        const detection = detect(twoRoomMap(), {
            "1": { ...roomBounds([10, 10, 59, 49]), outline } as MapExtractorRoom,
            "2": roomBounds([62, 10, 109, 49]),
        });
        expect(detection?.regions.map(found => found.id)).toEqual(["2"]);
    });

    it("follows a changed map: a re-detection after a re-map reflects the new image", () => {
        const before = twoRoomMap();
        const after = new SyntheticMap(120, 60).rect([10, 10, 39, 49], [230, 25, 75]).rect([42, 10, 109, 49], [60, 180, 75]);
        const rooms = { "1": roomBounds([10, 10, 59, 49]), "2": roomBounds([42, 10, 109, 49]) };
        expectTap(detect(before, rooms), 50, 30, "1");
        const detection = detect(after, { "1": roomBounds([10, 10, 39, 49]), "2": roomBounds([42, 10, 109, 49]) });
        expectTap(detection, 50, 30, "2");
        expectOutline(detection, "2", [42, 10, 109, 49]);
    });
});

describe("lossy camera images", () => {
    it("detects flat rooms through mild JPEG-like noise", () => {
        const map = new SyntheticMap(120, 60).rect([10, 10, 59, 49], [230, 25, 75]).rect([62, 10, 109, 49], [60, 180, 75]);
        map.noise(3, 7);
        const detection = detect(map, { "1": roomBounds([10, 10, 59, 49]), "2": roomBounds([62, 10, 109, 49]) });
        expectOutline(detection, "1", [10, 10, 59, 49]);
        expectOutline(detection, "2", [62, 10, 109, 49]);
        expectTap(detection, 30, 30, "1");
        expectTap(detection, 85, 30, "2");
    });
});
