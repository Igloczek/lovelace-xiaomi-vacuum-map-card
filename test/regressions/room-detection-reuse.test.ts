import { afterEach, describe, expect, it, vi } from "vitest";

import type { MapExtractorRoom, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { RoomColorDetector, type RoomColorDetection } from "../../src/model/room-color-detector";
import type { CardHandle } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, useHarnessClock, withState } from "../harness";

/**
 * While the vacuum cleans, the camera publishes a new snapshot every few seconds: the robot moved
 * and the path grew, the rooms did not. Tracing every room again each time froze the main thread
 * (hundreds of milliseconds on a large map), so a snapshot with the same room geometry, calibration
 * and size keeps the previous detection: for ten minutes when that one found every room, for one
 * minute when a room could not be found (a map with one room drawn without colour would otherwise
 * be traced on every snapshot). The room list is still rebuilt, so a renamed room shows its new
 * name; changed geometry is detected again.
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

/** A detection of the camera's rooms, keyed on the geometry the card passes in. */
function stubDetect(complete = true) {
    return vi
        .spyOn(RoomColorDetector, "detect")
        .mockImplementation((image, rooms, converter): RoomColorDetection => {
            const ids = Object.keys(rooms);
            const width = (image as HTMLCanvasElement).width;
            const height = (image as HTMLCanvasElement).height;
            return {
                imageData: { width, height, data: new Uint8ClampedArray(width * height * 4) },
                regions: ids.map(id => ({ id, colorKey: 1, center: [10, 10], outline: [[0, 0], [20, 0], [20, 20], [0, 20]] })),
                roomIdByColor: new Map(),
                labels: new Int16Array(width * height).fill(-1),
                labelRoomIds: ids,
                geometryKey: RoomColorDetector.geometryKey(width, height, rooms, converter),
                complete,
            };
        });
}

async function newSnapshot(card: CardHandle, rooms: Record<string, MapExtractorRoom>, stamp: string): Promise<void> {
    const camera = card.hass.states[FIXTURE.camera.entity_id];
    const next = withState(card.hass, FIXTURE.camera.entity_id, {
        attributes: { ...camera.attributes, rooms, entity_picture: `${String(camera.attributes.entity_picture)}&t=${stamp}` },
        last_updated: stamp,
        last_changed: stamp,
    }).hass;
    await card.updateHass(next);
    await card.fireMapLoad();
}

function roomLabel(card: CardHandle, id: string): string | undefined {
    return card.shadowRoot.querySelector(`.room-${id}-wrapper .room-label`)?.textContent?.trim() || undefined;
}

describe("room detection across camera refreshes", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps a complete detection for a newer snapshot of the same rooms, and still applies renames", async () => {
        useHarnessClock();
        const detect = stubDetect();
        const card = await mountCard(roomsConfig(), fixtureHass(FIXTURE));
        await card.fireMapLoad();
        expect(detect).toHaveBeenCalledTimes(1);

        const rooms = FIXTURE.camera.attributes.rooms as Record<string, MapExtractorRoom>;
        await newSnapshot(card, rooms, "2026-11-01T10:00:05.000Z");
        await newSnapshot(card, { ...rooms, "0": { ...rooms["0"], name: "Pantry" } }, "2026-11-01T10:00:10.000Z");

        expect(detect).toHaveBeenCalledTimes(1);
        expect(roomLabel(card, "0")).toBe("Pantry");
    });

    it("keeps an incomplete detection for a minute, then traces the rooms again", async () => {
        useHarnessClock("2026-11-01T10:00:00.000Z");
        const detect = stubDetect(false);
        const card = await mountCard(roomsConfig(), fixtureHass(FIXTURE));
        await card.fireMapLoad();
        const rooms = FIXTURE.camera.attributes.rooms as Record<string, MapExtractorRoom>;

        vi.setSystemTime(new Date("2026-11-01T10:00:30.000Z"));
        await newSnapshot(card, rooms, "2026-11-01T10:00:30.000Z");
        expect(detect).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-11-01T10:01:05.000Z"));
        await newSnapshot(card, rooms, "2026-11-01T10:01:05.000Z");
        expect(detect).toHaveBeenCalledTimes(2);
    });

    it("traces a complete detection again after ten minutes", async () => {
        useHarnessClock("2026-11-01T10:00:00.000Z");
        const detect = stubDetect();
        const card = await mountCard(roomsConfig(), fixtureHass(FIXTURE));
        await card.fireMapLoad();
        const rooms = FIXTURE.camera.attributes.rooms as Record<string, MapExtractorRoom>;

        vi.setSystemTime(new Date("2026-11-01T10:09:00.000Z"));
        await newSnapshot(card, rooms, "2026-11-01T10:09:00.000Z");
        expect(detect).toHaveBeenCalledTimes(1);

        vi.setSystemTime(new Date("2026-11-01T10:10:30.000Z"));
        await newSnapshot(card, rooms, "2026-11-01T10:10:30.000Z");
        expect(detect).toHaveBeenCalledTimes(2);
    });

    it("detects again when a room's geometry changes", async () => {
        useHarnessClock();
        const detect = stubDetect();
        const card = await mountCard(roomsConfig(), fixtureHass(FIXTURE));
        await card.fireMapLoad();

        const rooms = FIXTURE.camera.attributes.rooms as Record<string, MapExtractorRoom>;
        await newSnapshot(card, { ...rooms, "0": { ...rooms["0"], x1: 900 } }, "2026-11-01T10:00:05.000Z");

        expect(detect).toHaveBeenCalledTimes(2);
    });
});
