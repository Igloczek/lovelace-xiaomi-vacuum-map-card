import { afterEach, describe, expect, it, vi } from "vitest";

import { getRoomsConfig } from "../../src/card/rooms";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import {
    cameraEntity,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mountCard,
    syntheticCalibrationPoints,
    withState,
} from "../harness";

/**
 * Room metadata as integrations really publish it: string ids, rooms without a name or with an
 * empty one, an outline instead of bounds, numeric strings, and the odd broken entry. Generation
 * must keep every usable room with its own id and skip the rest, without breaking the card.
 */

const CAMERA = "camera.vacuum_map";

async function roomsFor(rooms: unknown) {
    const fixture = loadSyntheticFixture();
    const base = fixtureHass(fixture);
    const hass = withState(base, CAMERA, {
        attributes: cameraEntity({ calibration_points: syntheticCalibrationPoints(), attributes: { rooms } }).attributes,
    }).hass;
    const config: XiaomiVacuumMapCardConfig = {
        ...fixtureConfig(fixture),
        map_modes: [{ template: "vacuum_clean_segment" }],
    };
    const card = await mountCard(config, hass);
    const result = getRoomsConfig(card.element);
    return { card, rooms: result?.rooms ?? [] };
}

describe("room config from camera metadata", () => {
    afterEach(() => vi.restoreAllMocks());

    it("keeps string ids and names a room without one", async () => {
        const { rooms } = await roomsFor({
            "13": { x0: 100, y0: 100, x1: 300, y1: 200, name: "Kitchen" },
            "16": { x0: 400, y0: 100, x1: 600, y1: 200 },
            "17": { x0: 400, y0: 300, x1: 600, y1: 400, name: "" },
        });
        expect(rooms.map(r => r.id)).toEqual(["13", "16", "17"]);
        expect(rooms.map(r => r.label?.text)).toEqual(["Kitchen", "Room 16", "Room 17"]);
    });

    it("uses an outline when the room has one and centres the label on it", async () => {
        const { rooms } = await roomsFor({
            "2": { outline: [[0, 0], [200, 0], [200, 100], [0, 100]], name: "Hall" },
        });
        expect(rooms[0].outline).toEqual([[0, 0], [200, 0], [200, 100], [0, 100]]);
        expect([rooms[0].label?.x, rooms[0].label?.y]).toEqual([100, 50]);
    });

    it("accepts numeric strings for bounds", async () => {
        const { rooms } = await roomsFor({ "5": { x0: "100", y0: "100", x1: "300", y1: "200", name: "Office" } });
        expect(rooms).toHaveLength(1);
        expect(rooms[0].outline?.[2]).toEqual([300, 200]);
    });

    it("skips broken entries and keeps the rest", async () => {
        const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const { rooms, card } = await roomsFor({
            "1": null,
            "2": "Kitchen",
            "3": { outline: [], name: "Empty" },
            "4": { outline: "0,0,1,1", name: "Text" },
            "5": { outline: [[0, 0], [10]], name: "Short" },
            "6": { x0: 0, y0: 0, x1: Number.NaN, y1: 10, name: "NaN" },
            "7": { x0: 100, y0: 100, x1: 300, y1: 200, name: "Good" },
        });
        expect(rooms.map(r => r.id)).toEqual(["7"]);
        for (const room of rooms) {
            expect([room.label?.x, room.label?.y, room.icon?.x, room.icon?.y].every(Number.isFinite)).toBe(true);
        }
        expect(card.shadowRoot.querySelector("hui-error-card")).toBeNull();
        expect(errors.mock.calls.filter(args => args.some(a => a instanceof TypeError))).toEqual([]);
    });

    it("a rooms list uses each room's own id, not its position", async () => {
        const { rooms } = await roomsFor([
            { id: 13, x0: 100, y0: 100, x1: 300, y1: 200, name: "Kitchen" },
            { id: "16", x0: 400, y0: 100, x1: 600, y1: 200, name: "Bedroom" },
        ]);
        expect(rooms.map(r => r.id)).toEqual(["13", "16"]);
    });

    it("rooms that are not a collection give no rooms", async () => {
        const { rooms } = await roomsFor("13,16");
        expect(rooms).toEqual([]);
    });
});
