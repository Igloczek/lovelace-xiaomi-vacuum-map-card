import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import { MapMode } from "../../src/model/map_mode/map-mode";
import type { MapModeConfig, PlatformTemplate, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock, withState } from "../harness";

/**
 * The numbers show the order the rooms were tapped, which is the order sent to the vacuum. They are
 * on by default on every platform, including those whose integration lets the robot plan its own
 * route (the maintainer's decision on PR #36); `cleaning_order: false` turns them off.
 */

const TEMPLATES_DIR = path.join(__dirname, "../../src/model/generators/platform_templates");

function roomTemplates(): Array<{ key: string; config: MapModeConfig }> {
    return fs
        .readdirSync(TEMPLATES_DIR)
        .filter(file => file.endsWith(".json"))
        .flatMap(file => {
            const template = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), "utf8")) as PlatformTemplate;
            return Object.entries(template.map_modes?.templates ?? {})
                .filter(([, config]) => config.selection_type === "ROOM")
                .map(([name, config]) => ({ key: `${file}:${name}`, config }));
        });
}

describe("order numbers on every platform", () => {
    const templates = roomTemplates();

    it("covers every ROOM template", () => {
        expect(templates.length).toBeGreaterThan(15);
    });

    for (const { key, config } of templates) {
        it(`${key} numbers the rooms`, () => {
            expect(new MapMode("default", config, "en").showsRoomOrder()).toBe(true);
        });
    }
});

describe("MapMode.showsRoomOrder", () => {
    const roomMode = (config: Partial<MapModeConfig>, platform = "Xiaomi Miio"): MapMode =>
        new MapMode(platform, { selection_type: "ROOM", ...config } as MapModeConfig, "en");

    it("is on for templates and custom service calls, and off with cleaning_order: false", () => {
        const service_call_schema = { service: "script.turn_on", service_data: {} };
        expect(roomMode({ service_call_schema }).showsRoomOrder()).toBe(true);
        expect(roomMode({ template: "vacuum_clean_segment" }).showsRoomOrder()).toBe(true);
        expect(roomMode({ service_call_schema, cleaning_order: false }).showsRoomOrder()).toBe(false);
        expect(roomMode({ template: "vacuum_clean_segment", cleaning_order: false }).showsRoomOrder()).toBe(false);
    });

    it("is off for other selection types", () => {
        expect(
            new MapMode("Xiaomi Miio", { selection_type: "MANUAL_RECTANGLE" }, "en").showsRoomOrder(),
        ).toBe(false);
    });

    it("writes cleaning_order back only when the numbers are off", () => {
        expect(roomMode({ template: "vacuum_clean_segment" }).toMapModeConfig().cleaning_order).toBeUndefined();
        expect(roomMode({ template: "vacuum_clean_segment", cleaning_order: false }).toMapModeConfig().cleaning_order).toBe(false);
    });
});

const VACUUM = "vacuum.roborock_s7";

function config(mode: MapModeConfig): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        map_modes: [mode],
        tiles: [],
        icons: [],
        persist_map_view: false,
    };
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = card.shadowRoot.querySelector(`.room-${id}-wrapper .room-outline`);
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

function highlighted(card: CardHandle): string[] {
    return ["0", "1", "2"].filter(id => card.shadowRoot.querySelector(`.room-${id}-wrapper`)?.classList.contains("selected"));
}

function numbers(card: CardHandle): number {
    return card.shadowRoot.querySelectorAll(".room-order").length;
}

describe("rooms with the order numbers turned off", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    it("highlights the selection and the started run without numbers", async () => {
        useHarnessClock();
        const card = await mountCard(
            config({ template: "vacuum_clean_segment", cleaning_order: false }),
            fixtureHass(loadSyntheticFixture()),
        );
        await card.fireMapLoad();
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        expect(highlighted(card)).toEqual(["0", "2"]);
        expect(numbers(card)).toBe(0);

        const button = card.shadowRoot.querySelector(".map-actions-item.main");
        button?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element, 400);
        await card.updateHass(withState(card.hass, VACUUM, { state: "cleaning" }).hass);
        await settle(card.element);
        expect(highlighted(card)).toEqual(["0", "2"]);
        expect(numbers(card)).toBe(0);
    });

    it("numbers the rooms by default, on the default Xiaomi Miio template", async () => {
        useHarnessClock();
        const card = await mountCard(config({ template: "vacuum_clean_segment" }), fixtureHass(loadSyntheticFixture()));
        await card.fireMapLoad();
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        expect(numbers(card)).toBe(2);
    });
});
