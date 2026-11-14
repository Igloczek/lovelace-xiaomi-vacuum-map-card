import { describe, expect, it } from "vitest";

import type { RoomConfig, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
import { extractorRoom, fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, useHarnessClock, withState } from "../harness";

/**
 * Camera `rooms` metadata is integration data the card does not control. An entry that is not a
 * room (null, a string, an outline that is not a list of points, bounds that are not numbers) must
 * be skipped, and a `rooms` attribute that is not an object at all means "no metadata": the card
 * must not throw while rendering, and it must not invent live ids from a string's characters.
 */

const FIXTURE = loadSyntheticFixture();

function configuredRoom(id: string): RoomConfig {
    return {
        id,
        label: { text: `Configured ${id}`, x: 500, y: 450 },
        outline: [
            [200, 200],
            [800, 200],
            [800, 700],
            [200, 700],
        ],
    };
}

function roomsConfig(configuredId: string): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(FIXTURE),
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [configuredRoom(configuredId)] }],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

async function mountWithRooms(rooms: unknown, configuredId = "0"): Promise<CardHandle> {
    useHarnessClock();
    const camera = FIXTURE.camera;
    const hass = withState(fixtureHass(FIXTURE), camera.entity_id, {
        attributes: { ...camera.attributes, rooms },
    }).hass;
    const card = await mountCard(roomsConfig(configuredId), hass);
    await card.fireMapLoad();
    return card;
}

function roomIds(card: CardHandle): string[] {
    return Array.from(card.shadowRoot.querySelectorAll(".room-wrapper"))
        .map(element => /room-([^\s]+)-wrapper/.exec(element.getAttribute("class") ?? "")?.[1])
        .filter((id): id is string => id !== undefined)
        .sort();
}

describe("garbage camera rooms metadata", () => {
    it("skips entries that are not rooms and keeps the valid ones", async () => {
        const card = await mountWithRooms({
            "0": extractorRoom(200, 200, 800, 700, "Kitchen"),
            "1": null,
            "2": "bedroom",
            "3": { outline: "not a list", name: "Broken outline" },
            "4": { outline: [[1, 2], ["a", 3], [5]], name: "Broken points" },
            "5": { x0: "100", y0: 100, x1: 300, y1: 300, name: "String bound" },
            "6": { x0: Number.NaN, y0: 0, x1: 10, y1: 10 },
            "7": extractorRoom(1000, 200, 1700, 700, "Living room"),
        });
        expect(roomIds(card)).toEqual(["0", "7"]);
        expect(card.shadowRoot.querySelector("hui-warning")).toBeNull();
    });

    it.each([
        ["a string", "kitchen,bedroom,hall"],
        ["a list", Array.from({ length: 13 }, () => extractorRoom(200, 200, 800, 700, "Kitchen"))],
        ["a number", 42],
    ])("treats rooms given as %s as no metadata", async (_kind, rooms) => {
        // Id 12 is a character index of the string and an index of the list: reading those as
        // live ids would hide or invent a stale warning. The configured room is the fallback.
        const card = await mountWithRooms(rooms, "12");
        expect(roomIds(card)).toEqual(["12"]);
        expect(card.shadowRoot.querySelector(".room-stale")).toBeNull();
    });
});
