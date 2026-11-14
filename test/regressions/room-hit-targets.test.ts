import { afterEach, describe, expect, it, vi } from "vitest";

import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { RoomColorDetector, type RoomColorDetection } from "../../src/model/room-color-detector";
import type { CardHandle } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, useHarnessClock } from "../harness";

/**
 * A room the colour detector did not find keeps its outline, often a bounding box from the camera
 * metadata. As its own click target that box took taps meant for a detected room it overlaps (an
 * L-shaped room's box covers its neighbour). Once a detection exists the card resolves every room
 * tap itself, detected rooms first (`roomIdAtImagePoint`), so such outlines must not be clickable.
 */

const FIXTURE = loadSyntheticFixture();

function roomsConfig(): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(FIXTURE),
        map_modes: [{ template: "vacuum_clean_segment" }],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

function detectionOfRoom(id: string): RoomColorDetection {
    return {
        imageData: { width: 200, height: 150, data: new Uint8ClampedArray(200 * 150 * 4) },
        regions: [{ id, colorKey: 1, center: [50, 45], outline: [[20, 20], [80, 20], [80, 70], [20, 70]] }],
        roomIdByColor: new Map([[1, id]]),
        labels: new Int16Array(200 * 150).fill(-1),
        labelRoomIds: [id],
    };
}

function clickableOutlines(card: CardHandle): string[] {
    return Array.from(card.shadowRoot.querySelectorAll(".room-outline.clickable"))
        .map(outline => /room-([^\s]+)-wrapper/.exec(outline.parentElement?.getAttribute("class") ?? "")?.[1])
        .filter((id): id is string => id !== undefined)
        .sort();
}

async function mount(): Promise<CardHandle> {
    useHarnessClock();
    const card = await mountCard(roomsConfig(), fixtureHass(FIXTURE));
    await card.fireMapLoad();
    return card;
}

describe("room hit targets", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps metadata outlines clickable when there is no colour detection", async () => {
        vi.spyOn(RoomColorDetector, "detect").mockReturnValue(undefined);
        const card = await mount();
        expect(clickableOutlines(card)).toEqual(["0", "1", "2"]);
    });

    it("leaves room taps to the card once a detection exists, even for rooms it did not find", async () => {
        vi.spyOn(RoomColorDetector, "detect").mockReturnValue(detectionOfRoom("0"));
        const card = await mount();
        expect(card.shadowRoot.querySelectorAll(".room-wrapper")).toHaveLength(3);
        expect(clickableOutlines(card)).toEqual([]);
    });
});

