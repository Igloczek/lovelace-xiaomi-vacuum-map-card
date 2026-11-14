import { describe, expect, it } from "vitest";

import { Tile } from "../../src/components/tile";
import { resolveTileMultiplier } from "../../src/model/generators/tiles-generator";
import { PlatformGenerator } from "../../src/model/generators/platform-generator";
import { isConditionMet } from "../../src/utils";
import type { HomeAssistantFixed } from "../../src/types/fixes";
import type { TileConfig } from "../../src/types/types";
import { NumberFormat } from "../../src/localize/hass/translation";
import { fixtureHass, loadSyntheticFixture, withState, type MockHass } from "../harness";

void Tile;

const VACUUM = "vacuum.roborock_s7";
const SENSOR = "sensor.roborock_s7_cleaning_time";

async function renderTile(config: TileConfig, hass: HomeAssistantFixed): Promise<{ label: string; value: string }> {
    const tile = document.createElement("xvmc-tile") as Tile;
    Object.assign(tile, {
        config,
        hass,
        isInEditor: false,
        onAction: () => () => undefined,
        internalVariables: {},
    });
    document.body.appendChild(tile);
    await tile.updateComplete;
    const rendered = {
        label: tile.querySelector(".tile-title")?.textContent?.trim() ?? "",
        value: tile.querySelector(".tile-value")?.textContent?.trim() ?? "",
    };
    tile.remove();
    return rendered;
}

function hassWithSensor(state: string, unit = "min", locale?: Partial<MockHass["locale"]>): MockHass {
    const hass = fixtureHass(loadSyntheticFixture(), locale ? { locale } : {});
    return withState(hass, SENSOR, {
        state,
        attributes: { friendly_name: "Cleaning time", unit_of_measurement: unit },
    }).hass;
}

const NUMERIC_TILE: TileConfig = { entity: SENSOR, unit: "h", multiplier: 1 / 60, precision: 1 };

describe("numeric tiles with a non-numeric value", () => {
    it.each(["unavailable", "unknown"])("a %s sensor shows the state without a unit", async state => {
        const rendered = await renderTile(NUMERIC_TILE, hassWithSensor(state));
        expect(rendered.value).not.toMatch(/ h$/);
        expect(rendered.value.toLowerCase()).toContain(state);
    });

    it("a missing attribute shows unknown, not 'undefined h'", async () => {
        const rendered = await renderTile(
            { entity: VACUUM, attribute: "filter_left", unit: "h", multiplier: 1 / 3600, precision: 0 },
            fixtureHass(loadSyntheticFixture()),
        );
        expect(rendered.value).not.toMatch(/undefined|NaN/);
        expect(rendered.value).not.toMatch(/ h$/);
    });

    it("a null attribute shows unknown", async () => {
        const hass = fixtureHass(loadSyntheticFixture());
        const vacuum = hass.states[VACUUM];
        const next = withState(hass, VACUUM, { attributes: { ...vacuum.attributes, filter_left: null } }).hass;
        const rendered = await renderTile(
            { entity: VACUUM, attribute: "filter_left", unit: "h", multiplier: 1 / 3600, precision: 0 },
            next,
        );
        expect(rendered.value).not.toMatch(/null|NaN|0 h/);
    });

    it("a numeric value keeps the unit", async () => {
        const rendered = await renderTile(NUMERIC_TILE, hassWithSensor("90"));
        expect(rendered.value).toBe("1.5 h");
    });

    it("a numeric value follows the user's number format", async () => {
        const rendered = await renderTile(
            NUMERIC_TILE,
            hassWithSensor("90", "min", { language: "pl", number_format: NumberFormat.language }),
        );
        expect(rendered.value).toBe("1,5 h");
    });

    it("a missing entity shows the tile id and no crash", async () => {
        const rendered = await renderTile(
            { tile_id: "ghost", entity: "sensor.removed", unit: "h", multiplier: 1, precision: 0 },
            fixtureHass(loadSyntheticFixture()),
        );
        expect(rendered.label).toBe("ghost");
        expect(rendered.value).not.toMatch(/undefined|NaN/);
    });
});

describe("tile icons", () => {
    it("an icon_source pointing at a missing entity does not break the tile", async () => {
        const rendered = await renderTile(
            { entity: VACUUM, attribute: "battery_level", icon_source: "sensor.removed.attributes.icon", label: "Battery" },
            fixtureHass(loadSyntheticFixture()),
        );
        expect(rendered.label).toBe("Battery");
    });
});

describe("conditions on a removed entity", () => {
    it("are not met and do not throw", () => {
        const hass = fixtureHass(loadSyntheticFixture());
        expect(() => isConditionMet({ entity: "select.removed", value: "on" }, {}, hass)).not.toThrow();
        expect(isConditionMet({ entity: "select.removed", value: "on" }, {}, hass)).toBe(false);
        expect(isConditionMet({ entity: "select.removed", attribute: "x", value: "on" }, {}, hass)).toBe(false);
    });
});

describe("duration multipliers follow the sensor's unit on every platform", () => {
    // Templates that convert a duration by a hard-coded factor assumed one sensor unit. Home
    // Assistant lets a user change a duration sensor's display unit, and integrations change their
    // native unit across versions, so the factor must come from the reported unit when there is one.
    const durationTemplates = PlatformGenerator.getPlatforms().flatMap(platform =>
        PlatformGenerator.getTilesFromSensorsTemplates(platform)
            .filter(t => t.unit === "unit.hour_shortcut" || t.unit === "unit.minute_shortcut")
            .map(t => [platform, t.tile_id, t] as const),
    );

    it.each(durationTemplates)("%s %s: a sensor reporting hours shows hours", (_platform, _id, template) => {
        const target = template.unit === "unit.hour_shortcut" ? "h" : "min";
        const multiplier = resolveTileMultiplier(template, target) ?? 1;
        expect(multiplier).toBeCloseTo(1, 6);
    });

    it.each(durationTemplates)("%s %s: a unit-less sensor keeps the template factor", (_platform, _id, template) => {
        const legacy = template.multiplier;
        if (legacy === undefined) return;
        expect(resolveTileMultiplier(template, undefined)).toBe(legacy);
    });
});
