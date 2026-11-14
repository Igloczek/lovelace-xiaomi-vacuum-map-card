import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateConfig } from "../../src/config-validators";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard } from "../harness";

/**
 * YAML a user can actually type into the card editor. Each one is wrong in a way the YAML parser
 * accepts (a scalar where a list belongs, a null list item, an object where a string belongs), so
 * Home Assistant hands it to `setConfig` unchanged. The card must answer with a message, never a
 * TypeError from inside the validator or the first render.
 */
const BASE = fixtureConfig(loadSyntheticFixture());

const MALFORMED: [string, Record<string, unknown>][] = [
    ["map_source is a string", { map_source: "camera.vacuum_map" }],
    ["map_source is null", { map_source: null }],
    ["calibration_source is a string", { calibration_source: "camera" }],
    ["calibration_source is null", { calibration_source: null }],
    ["calibration_points is a string", { calibration_source: { calibration_points: "abc" } }],
    ["calibration_points has a null point", { calibration_source: { calibration_points: [null, null, null] } }],
    ["map_modes is an object", { map_modes: { template: "vacuum_clean_zone" } }],
    ["map_modes is a string", { map_modes: "vacuum_clean_zone" }],
    ["map_modes has a null item", { map_modes: [null] }],
    ["map_modes item is a string", { map_modes: ["vacuum_clean_zone"] }],
    ["predefined_selections is an object", {
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: { id: 1 } }],
    }],
    ["predefined_selections has a null room", {
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [null] }],
    }],
    ["room id is null", {
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [{ id: null }] }],
    }],
    ["room outline is a string", {
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [{ id: 1, outline: "1,2" }] }],
    }],
    ["room outline has a null point", {
        map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [{ id: 1, outline: [null] }] }],
    }],
    ["zones is a number", {
        map_modes: [{ template: "vacuum_clean_zone_predefined", predefined_selections: [{ zones: 5 }] }],
    }],
    ["zone is a string", {
        map_modes: [{ template: "vacuum_clean_zone_predefined", predefined_selections: [{ zones: ["1,2,3,4"] }] }],
    }],
    ["icons is an object", { icons: { icon: "mdi:play" } }],
    ["tiles is a string", { tiles: "battery" }],
    ["icon conditions is an object", { icons: [{ icon: "mdi:play", conditions: { entity: "x" } }] }],
    ["additional_presets is an object", { additional_presets: { entity: "vacuum.x" } }],
    ["additional_presets has a null item", { additional_presets: [null] }],
    ["vacuum_platform is a number", { vacuum_platform: 5 }],
    ["service_call_schema is a string", {
        map_modes: [{ name: "x", icon: "mdi:x", selection_type: "MANUAL_RECTANGLE", service_call_schema: "vacuum.start" }],
    }],
    ["selection_type is unknown", {
        map_modes: [{ name: "x", icon: "mdi:x", selection_type: "ZONE", service_call_schema: { service: "vacuum.start" } }],
    }],
    ["conditions is an object", { conditions: { entity: "vacuum.x" } }],
];

function config(patch: Record<string, unknown>): XiaomiVacuumMapCardConfig {
    return { ...BASE, ...patch } as unknown as XiaomiVacuumMapCardConfig;
}

describe("malformed YAML produces messages, not crashes", () => {
    it.each(MALFORMED)("%s: validateConfig reports it", (_name, patch) => {
        let errors: string[] = [];
        expect(() => {
            errors = validateConfig(config(patch));
        }).not.toThrow();
        expect(errors.length).toBeGreaterThan(0);
        for (const error of errors) {
            expect(error).not.toMatch(/undefined|\[object Object\]/);
        }
    });

    describe("mounted", () => {
        let uncaught: unknown[];
        const onError = (event: ErrorEvent): void => {
            uncaught.push(event.error);
        };
        let consoleError: ReturnType<typeof vi.spyOn>;
        beforeEach(() => {
            uncaught = [];
            window.addEventListener("error", onError);
            consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        });
        afterEach(() => {
            window.removeEventListener("error", onError);
            consoleError.mockRestore();
        });

        it.each(MALFORMED)("%s: the card shows the error card", async (_name, patch) => {
            const hass = fixtureHass(loadSyntheticFixture());
            const card = await mountCard(config(patch), hass);
            expect(uncaught).toEqual([]);
            const shown = card.shadowRoot.querySelector("hui-error-card, pre");
            expect(shown).not.toBeNull();
            const typeErrors = consoleError.mock.calls.filter(args => args.some(a => a instanceof TypeError));
            expect(typeErrors).toEqual([]);
            await card.cleanup();
        });
    });

    it("a valid config after an old-style one renders the new config", async () => {
        const hass = fixtureHass(loadSyntheticFixture());
        const card = await mountCard({ ...BASE, map_camera: "camera.vacuum_map" } as never, hass);
        expect(card.shadowRoot.textContent).toMatch(/old configuration/i);
        card.element.setConfig(BASE);
        await card.updateHass(hass);
        expect(card.shadowRoot.textContent ?? "").not.toMatch(/old configuration/i);
        await card.cleanup();
    });

    it("a valid config after an invalid one clears the errors", async () => {
        const hass = fixtureHass(loadSyntheticFixture());
        const card = await mountCard(config({ map_source: null }), hass);
        card.element.setConfig(BASE);
        await card.updateHass(hass);
        expect(card.shadowRoot.querySelector("hui-error-card")).toBeNull();
        await card.cleanup();
    });
});
