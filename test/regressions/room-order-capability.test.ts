import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import { MapMode } from "../../src/model/map_mode/map-mode";
import type { MapModeConfig, PlatformTemplate, XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock, withState } from "../harness";

/**
 * The numbered badges claim a cleaning order. A number is drawn only where the platform's service
 * call makes the vacuum follow it; elsewhere the rooms are highlighted without numbers.
 *
 * Evidence per template (integration sources, read 2026-11-14):
 * - rand256/ValetudoRE `segmented_cleanup` sends `clean_order_mode: 1` (lib/miio/Vacuum.js).
 * - Hypfer/Valetudo publishes `customOrder: true`; Valetudo's Roborock and Dreame segmentation
 *   capabilities report `customOrderSupport: true` (Viomi and Midea report false).
 * - johnnyh1975/ha_roomba_plus `clean_room` with `ordered: true` sends iRobot's `ordered: 1`.
 * - Xiaomi Miio (python-miio `segment_clean`), Roborock core and humbertogontijo send
 *   `app_segment_clean` without `clean_order_mode`, so the robot plans its own route.
 * - Tasshack/dreame-vacuum sends a per-room index only on older models; newer ones use the
 *   cleaning sequence stored on the robot.
 * - Viomi (`set_mode_withroom`, `clean_segment`) has no order field and the V8 was observed
 *   cleaning in its own order; simple-wyze-vac re-sorts the rooms into map order; Deebot, Neato and
 *   Roomba core (no `ordered`) give no evidence of order.
 * - Modes that take one room (al-one/hass-xiaomi-miot, ValetudoRE go-to) have no order to show.
 */
const NUMBERED_ROOM_TEMPLATES = new Set([
    "hypfer_valetudo.json:vacuum_clean_segment",
    "johnnyh1975_roomba_plus.json:vacuum_clean_segment",
    "johnnyh1975_roomba_plus.json:vacuum_clean_segment_two_pass",
    "rand256_valetudo_re.json:vacuum_clean_segment",
]);

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

describe("which platform templates number the rooms", () => {
    const templates = roomTemplates();

    it("covers every ROOM template", () => {
        expect(templates.length).toBeGreaterThan(15);
        for (const key of NUMBERED_ROOM_TEMPLATES) expect(templates.map(t => t.key)).toContain(key);
    });

    for (const { key, config } of templates) {
        const numbered = NUMBERED_ROOM_TEMPLATES.has(key);
        it(`${key} ${numbered ? "numbers" : "does not number"} the rooms`, () => {
            expect(new MapMode("default", config, "en").showsRoomOrder()).toBe(numbered);
        });
    }
});

describe("MapMode.showsRoomOrder", () => {
    const roomMode = (config: Partial<MapModeConfig>, platform = "Xiaomi Miio"): MapMode =>
        new MapMode(platform, { selection_type: "ROOM", ...config } as MapModeConfig, "en");

    it("is off for a custom service call unless the mode declares it", () => {
        const service_call_schema = { service: "script.turn_on", service_data: {} };
        expect(roomMode({ service_call_schema }).showsRoomOrder()).toBe(false);
        expect(roomMode({ service_call_schema, cleaning_order: true }).showsRoomOrder()).toBe(true);
    });

    it("follows the template, and a mode can override it either way", () => {
        expect(roomMode({ template: "vacuum_clean_segment" }, "Hypfer/Valetudo").showsRoomOrder()).toBe(true);
        expect(roomMode({ template: "vacuum_clean_segment", cleaning_order: false }, "Hypfer/Valetudo").showsRoomOrder()).toBe(false);
        expect(roomMode({ template: "vacuum_clean_segment", cleaning_order: true }).showsRoomOrder()).toBe(true);
    });

    it("does not inherit the template's claim when the mode replaces the service call", () => {
        const mode = roomMode(
            { template: "vacuum_clean_segment", service_call_schema: { service: "script.turn_on", service_data: {} } },
            "Hypfer/Valetudo",
        );
        expect(mode.showsRoomOrder()).toBe(false);
    });

    it("has no order to show for one room or for other selection types", () => {
        expect(roomMode({ cleaning_order: true, max_selections: 1 }).showsRoomOrder()).toBe(false);
        expect(
            new MapMode("Xiaomi Miio", { selection_type: "MANUAL_RECTANGLE", cleaning_order: true }, "en").showsRoomOrder(),
        ).toBe(false);
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

describe("rooms on a platform that plans its own route", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    it("highlights the selection and the started run without numbers", async () => {
        useHarnessClock();
        const card = await mountCard(config({ template: "vacuum_clean_segment" }), fixtureHass(loadSyntheticFixture()));
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

    it("numbers the rooms once the mode declares the platform follows the order", async () => {
        useHarnessClock();
        const card = await mountCard(
            config({ template: "vacuum_clean_segment", cleaning_order: true }),
            fixtureHass(loadSyntheticFixture()),
        );
        await card.fireMapLoad();
        await clickRoom(card, "2");
        await clickRoom(card, "0");
        expect(numbers(card)).toBe(2);
    });
});
