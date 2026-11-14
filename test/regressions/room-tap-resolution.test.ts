import { afterEach, describe, expect, it, vi } from "vitest";

import type { RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { handleRoomColorClick } from "../../src/card/rooms";
import { RoomColorDetector, type RoomColorDetection } from "../../src/model/room-color-detector";
import type { CardHandle } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, useHarnessClock } from "../harness";

/**
 * Room taps through the card's own handler while a colour detection exists. The synthetic camera
 * reports rooms 0, 1 and 2; the stubbed detection found only room 0, so rooms 1 and 2 are tapped
 * through their metadata outlines. A stale configured room 9 lies inside room 1 (an id shift after a
 * re-map) and is the smaller outline, so only the stale filter keeps it from taking the tap.
 */

const FIXTURE = loadSyntheticFixture();
const WIDTH = 200;
const HEIGHT = 150;

const STALE_OVER_ROOM_1: RoomConfig = {
    id: "9",
    label: { text: "Old living room", x: 1350, y: 450 },
    outline: [
        [1050, 250],
        [1650, 250],
        [1650, 650],
        [1050, 650],
    ],
};

function roomsConfig(): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(FIXTURE),
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [STALE_OVER_ROOM_1] }],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

/** Room 0 (image 20..80 x 20..70) is detected; nothing else is. */
function detectionOfRoom0(): RoomColorDetection {
    const labels = new Int16Array(WIDTH * HEIGHT).fill(-1);
    for (let y = 20; y < 70; y++) for (let x = 20; x < 80; x++) labels[y * WIDTH + x] = 0;
    return {
        imageData: { width: WIDTH, height: HEIGHT, data: new Uint8ClampedArray(WIDTH * HEIGHT * 4) },
        regions: [{ id: "0", colorKey: 1, center: [50, 45], outline: [[20, 20], [80, 20], [80, 70], [20, 70]] }],
        roomIdByColor: new Map([[1, "0"]]),
        labels,
        labelRoomIds: ["0"],
    };
}

async function mount(): Promise<CardHandle> {
    useHarnessClock();
    vi.spyOn(RoomColorDetector, "detect").mockReturnValue(detectionOfRoom0());
    const card = await mountCard(roomsConfig(), fixtureHass(FIXTURE));
    await card.fireMapLoad();
    // happy-dom lays nothing out: one CSS pixel per image pixel, and the tap lands where asked.
    card.element.realScale = 1;
    return card;
}

function tapImagePixel(card: CardHandle, x: number, y: number): void {
    vi.spyOn(card.element, "_getMousePosition").mockReturnValue({ x: x + 0.5, y: y + 0.5 } as never);
    handleRoomColorClick(card.element, new MouseEvent("click"));
}

function selectedIds(card: CardHandle): string[] {
    return card.element.selectedRooms.map(room => String(room.toVacuum()));
}

describe("room taps while a colour detection exists", () => {
    afterEach(() => vi.restoreAllMocks());

    it("selects the detected room from the label map", async () => {
        const card = await mount();
        tapImagePixel(card, 40, 40);
        expect(selectedIds(card)).toEqual(["0"]);
    });

    it("selects an undetected room through its metadata outline, never the stale room over it", async () => {
        const card = await mount();
        tapImagePixel(card, 130, 40);
        expect(selectedIds(card)).toEqual(["1"]);
        tapImagePixel(card, 50, 110);
        expect(selectedIds(card)).toEqual(["1", "2"]);
    });

    it("selects nothing on the background", async () => {
        const card = await mount();
        tapImagePixel(card, 5, 5);
        tapImagePixel(card, 190, 140);
        expect(selectedIds(card)).toEqual([]);
    });
});
