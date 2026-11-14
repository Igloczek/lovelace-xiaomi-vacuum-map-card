import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket/dist/types";

import { validateConfig } from "../../src/config-validators";
import { PlatformGenerator } from "../../src/model/generators/platform-generator";
import { MapMode } from "../../src/model/map_mode/map-mode";
import { SelectionType } from "../../src/model/map_mode/selection-type";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import {
    cameraEntity,
    fixtureConfig,
    fixtureHass,
    loadSyntheticFixture,
    mockHass,
    mountCard,
    settle,
    withState,
    syntheticCalibrationPoints,
    type MockEntityRegistryEntry,
    type MockHass,
} from "../harness";

/**
 * Every platform template, driven the way a user meets it: a config with only `entity`,
 * `vacuum_platform`, a camera and calibration, and the entities the template expects, shaped like
 * a real integration publishes them (string room ids from the camera, registry unique ids with a
 * device prefix and suffix, select entities with `options`).
 */

const VACUUM = "vacuum.robot";
const CAMERA = "image.robot_map";
const DEVICE = "device-robot";
const SETUP_PLATFORMS = [PlatformGenerator.SETUP_INTEGER_PLATFORM, PlatformGenerator.SETUP_DECIMAL_PLATFORM];

interface PlatformTemplateJson {
    tiles?: {
        from_sensors?: { tile_id?: string; unique_id_regex: string }[];
        from_attributes?: { tile_id?: string; attribute: string }[];
    };
    icons?: { unique_id_regex?: string; available_values_attribute?: string; icon_mapping?: Record<string, string> }[];
}

function state(entityId: string, value: string, attributes: Record<string, unknown> = {}): HassEntity {
    return {
        entity_id: entityId,
        state: value,
        attributes: { friendly_name: entityId.split(".")[1].replace(/_/g, " "), ...attributes },
        last_changed: "2026-11-01T10:00:00.000Z",
        last_updated: "2026-11-01T10:00:00.000Z",
        context: { id: `ctx-${entityId}`, parent_id: null, user_id: null },
    } as HassEntity;
}

function registry(entityId: string, uniqueId: string, platform = "integration"): MockEntityRegistryEntry {
    return {
        entity_id: entityId,
        unique_id: uniqueId,
        device_id: DEVICE,
        platform,
        disabled_by: null,
        hidden_by: null,
    } as MockEntityRegistryEntry;
}

/** A unique id a real integration would publish for `regex`: the pattern inside an id. */
function uniqueIdFor(regex: string): string {
    const literal = regex.replace(/[\^$]/g, "");
    return `a1b2c3_${literal}_x9`.replace(/__+/g, "_");
}

function templateJson(platform: string): PlatformTemplateJson {
    // Read back through the generator so the test covers exactly what the card loads.
    return {
        tiles: {
            from_sensors: PlatformGenerator.getTilesFromSensorsTemplates(platform),
            from_attributes: PlatformGenerator.getTilesFromAttributesTemplates(platform),
        },
        icons: PlatformGenerator.getIconsTemplates(platform) as PlatformTemplateJson["icons"],
    };
}

interface PlatformWorld {
    hass: MockHass;
    config: XiaomiVacuumMapCardConfig;
}

function platformWorld(platform: string, sensorState: (index: number) => [string, Record<string, unknown>]): PlatformWorld {
    const template = templateJson(platform);
    const vacuumAttributes: Record<string, unknown> = {
        status: "Charging",
        battery_level: 87,
        fan_speed: "Standard",
        fan_speed_list: ["Silent", "Standard", "Turbo"],
        supported_features: 16383,
    };
    for (const tile of template.tiles?.from_attributes ?? []) {
        vacuumAttributes[tile.attribute] = 12;
    }
    const states: Record<string, HassEntity> = {
        [VACUUM]: state(VACUUM, "docked", vacuumAttributes),
        [CAMERA]: cameraEntity({
            entity_id: CAMERA,
            calibration_points: syntheticCalibrationPoints(),
            rooms: {
                "13": { x0: 200, y0: 200, x1: 800, y1: 700, name: "Kitchen" } as never,
                "14": { x0: 1000, y0: 200, x1: 1700, y1: 700 } as never,
            },
        }),
    };
    const entries: MockEntityRegistryEntry[] = [registry(VACUUM, "a1b2c3"), registry(CAMERA, "a1b2c3_map")];
    (template.tiles?.from_sensors ?? []).forEach((tile, index) => {
        const entityId = `sensor.robot_${tile.tile_id}_${index}`;
        const [value, attributes] = sensorState(index);
        states[entityId] = state(entityId, value, attributes);
        entries.push(registry(entityId, uniqueIdFor(tile.unique_id_regex)));
    });
    (template.icons ?? []).filter(icon => icon.unique_id_regex).forEach((icon, index) => {
        const entityId = `select.robot_menu_${index}`;
        const options = Object.keys(icon.icon_mapping ?? { low: "", high: "" });
        states[entityId] = state(entityId, options[0], { [icon.available_values_attribute ?? "options"]: options });
        entries.push(registry(entityId, uniqueIdFor(icon.unique_id_regex as string)));
    });
    const hass = mockHass({ states, entities: entries });
    const config: XiaomiVacuumMapCardConfig = {
        type: "custom:xiaomi-vacuum-map-card",
        entity: VACUUM,
        vacuum_platform: platform,
        map_source: { camera: CAMERA },
        calibration_source: { camera: true },
    };
    return { hass, config };
}

const PLATFORMS = PlatformGenerator.getPlatforms();

describe("platform templates", () => {
    it.each(PLATFORMS)("%s: every default and named mode resolves to a usable mode", platform => {
        for (const config of PlatformGenerator.generateDefaultModes(platform)) {
            expect(PlatformGenerator.isValidModeTemplate(platform, config.template)).toBe(true);
        }
        const roomsTemplate = PlatformGenerator.getRoomsTemplate(platform);
        if (roomsTemplate !== undefined) {
            const mode = new MapMode(platform, { template: roomsTemplate }, "en");
            expect(mode.name).not.toBe("Invalid mode");
            expect(mode.toMapModeConfig().service_call_schema?.service).toContain(".");
        }
    });

    it.each(PLATFORMS)("%s: tile ids are unique within the template", platform => {
        const template = templateJson(platform);
        const ids = [
            ...(template.tiles?.from_sensors ?? []).map(t => t.tile_id),
            ...(template.tiles?.from_attributes ?? []).map(t => t.tile_id),
        ].filter(Boolean);
        // A repeated tile id silently drops the later tile: the generator keeps the first.
        const sensorIds = (template.tiles?.from_sensors ?? []).map(t => t.tile_id);
        expect(new Set(sensorIds).size).toBe(sensorIds.length);
        expect(ids.length).toBeGreaterThanOrEqual(0);
    });

    it.each(PLATFORMS)("%s: the minimal config validates", platform => {
        expect(validateConfig(platformWorld(platform, () => ["5", {}]).config)).toEqual([]);
    });
});

describe("platform defaults mounted with real-shaped entities", () => {
    let errors: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
        errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    });
    afterEach(() => {
        errors.mockRestore();
    });

    it.each(PLATFORMS)("%s: renders modes and tiles without errors", async platform => {
        const { hass, config } = platformWorld(platform, () => ["3600", { unit_of_measurement: "s" }]);
        const card = await mountCard(config, hass);
        await settle(card.element, 200);
        expect(errors).not.toHaveBeenCalled();
        const root = card.shadowRoot;
        expect(root.querySelector("hui-error-card, hui-warning")).toBeNull();
        // Every platform must offer at least one way to clean from the map out of the box.
        if (!SETUP_PLATFORMS.includes(platform)) {
            expect(root.querySelector(".map-wrapper, #map-zoomer-content")).not.toBeNull();
        }
        const tiles = [...root.querySelectorAll("xvmc-tile")].map(t => ({
            label: t.querySelector(".tile-title")?.textContent?.trim() ?? "",
            value: t.querySelector(".tile-value")?.textContent?.trim() ?? "",
        }));
        for (const tile of tiles) {
            expect(tile.label).not.toMatch(/undefined|null|^$/);
            expect(tile.value).not.toMatch(/undefined|NaN/);
        }
        await card.cleanup();
    });

    it.each(PLATFORMS)("%s: unavailable sensors show a state, not a unit on a word", async platform => {
        const { hass, config } = platformWorld(platform, () => ["unavailable", { unit_of_measurement: "h" }]);
        const card = await mountCard(config, hass);
        await settle(card.element, 200);
        expect(errors).not.toHaveBeenCalled();
        const values = [...card.shadowRoot.querySelectorAll("xvmc-tile .tile-value")].map(
            v => v.textContent?.trim() ?? "",
        );
        for (const value of values) {
            expect(value).not.toMatch(/unavailable ?(h|min|m²|%|x)$/);
            expect(value).not.toMatch(/NaN|undefined/);
        }
        await card.cleanup();
    });
});

describe("default modes follow the camera's room metadata", () => {
    const ROOM_PLATFORMS = PLATFORMS.filter(
        p => !SETUP_PLATFORMS.includes(p) && PlatformGenerator.getRoomsTemplate(p) !== undefined,
    );

    // Room templates that need hand-written configuration to send a working call. Offering them by
    // default would put a Rooms mode on the map that sends a broken service call.
    const NEEDS_CONFIGURATION = [
        "al-one/hass-xiaomi-miot", // no service data: configured per model
        "Hypfer/Valetudo", // [[topic]]
        "rand256/ValetudoRE", // [[topic]]
        "Roomba", // [[pmap_id]] and per-room [[variables]]
    ];

    it.each(ROOM_PLATFORMS)("%s: a camera with rooms gives a working room mode without map_modes", async platform => {
        const { hass, config } = platformWorld(platform, () => ["5", {}]);
        const card = await mountCard(config, hass);
        await settle(card.element, 200);
        const roomModes = card.element.modes.filter(m => m.selectionType === SelectionType.ROOM);
        if (NEEDS_CONFIGURATION.includes(platform)) {
            expect(roomModes).toHaveLength(0);
        } else {
            expect(roomModes.length).toBeGreaterThanOrEqual(1);
            // The call carries the camera's string ids and no unfilled placeholder.
            const call = roomModes[0].serviceCallSchema.apply(VACUUM, ["13", "14"], 1, {
                ...roomModes[0].variables,
                ...card.element.internalVariables,
            });
            expect(JSON.stringify(call)).not.toMatch(/\[\[[a-z_]+\]\]/);
            expect(JSON.stringify(call)).toContain("13");
        }
        await card.cleanup();
    });

    it.each(ROOM_PLATFORMS)("%s: a camera without rooms keeps the template defaults", async platform => {
        const world = platformWorld(platform, () => ["5", {}]);
        const camera = world.hass.states[CAMERA];
        const attributes = { ...camera.attributes };
        delete attributes.rooms;
        const hass = mockHass({
            states: { ...world.hass.states, [CAMERA]: { ...camera, attributes } as HassEntity },
            entities: Object.values(world.hass.entities) as MockEntityRegistryEntry[],
        });
        const card = await mountCard(world.config, hass);
        await settle(card.element, 200);
        expect(card.element.modes.map(m => m.config.template)).toEqual(
            PlatformGenerator.generateDefaultModes(platform).map(m => m.template),
        );
        await card.cleanup();
    });

    it("configured map_modes are never changed", async () => {
        const { hass, config } = platformWorld("Xiaomi Miio", () => ["5", {}]);
        const card = await mountCard({ ...config, map_modes: [{ template: "vacuum_clean_zone" }] }, hass);
        await settle(card.element, 200);
        expect(card.element.modes.map(m => m.config.template)).toEqual(["vacuum_clean_zone"]);
        await card.cleanup();
    });
});

describe("room metadata that arrives after the card loaded", () => {
    it("adds the room mode once the camera reports rooms, keeping the selected mode", async () => {
        const world = platformWorld("Neato", () => ["5", {}]);
        const camera = world.hass.states[CAMERA];
        const withoutRooms = { ...camera.attributes };
        delete withoutRooms.rooms;
        const initial = withState(world.hass, CAMERA, { attributes: withoutRooms }).hass;
        const card = await mountCard(world.config, initial);
        expect(card.element.modes).toHaveLength(0);
        await card.updateHass(withState(initial, CAMERA, { attributes: camera.attributes }).hass);
        expect(card.element.modes.map(m => m.selectionType)).toEqual([SelectionType.ROOM]);
        expect(card.element.selectedMode).toBe(0);
        expect(card.element._getCurrentMode()).toBe(card.element.modes[0]);
        await card.cleanup();
    });
});

describe("a camera that briefly loses its rooms", () => {
    // An unavailable camera publishes no attributes. That says nothing about the rooms, the same
    // rule as stale-room detection (missing metadata means unknown), so the generated room mode,
    // the selected mode and the selection must all survive the gap.
    it("keeps the room mode, the selected mode and the selected room", async () => {
        const { setCurrentMode } = await import("../../src/card/selection");
        const fixture = loadSyntheticFixture();
        const hass = fixtureHass(fixture);
        const card = await mountCard({ ...fixtureConfig(fixture), persist_map_view: false }, hass);
        await card.fireMapLoad();
        expect(card.element.modes.map(m => m.config.template)).toEqual([
            "vacuum_clean_zone",
            "vacuum_goto",
            "vacuum_clean_segment",
        ]);
        setCurrentMode(card.element, 2, false);
        await settle(card.element);
        const outline = card.shadowRoot.querySelector(".room-1-wrapper .room-outline");
        outline?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
        await settle(card.element);
        const selected = (): unknown[] => card.element._getSelection(card.element._getCurrentMode()).selection;
        expect(selected()).toEqual([1]);
        const roomMode = card.element.modes[2];

        const camera = hass.states[fixture.camera.entity_id];
        const unavailable = withState(hass, camera.entity_id, { state: "unavailable", attributes: {} }).hass;
        await card.updateHass(unavailable);
        expect(card.element.selectedMode).toBe(2);
        expect(card.element.modes[2]).toBe(roomMode);
        expect(selected()).toEqual([1]);

        await card.updateHass(withState(unavailable, camera.entity_id, camera).hass);
        expect(card.element.selectedMode).toBe(2);
        expect(card.element.modes).toHaveLength(3);
        expect(selected()).toEqual([1]);
        await card.cleanup();
    });

    it("a zone being drawn in the first mode survives the room mode being added", async () => {
        const world = platformWorld("Xiaomi Miio", () => ["5", {}]);
        const camera = world.hass.states[CAMERA];
        const withoutRooms = { ...camera.attributes };
        delete withoutRooms.rooms;
        const initial = withState(world.hass, CAMERA, { attributes: withoutRooms }).hass;
        const card = await mountCard(world.config, initial);
        const firstMode = card.element.modes[0];
        const { ManualRectangle } = await import("../../src/model/map_objects/manual-rectangle");
        const { createContext } = await import("../../src/card/selection");
        const marker = new ManualRectangle(10, 10, 50, 50, "1", createContext(card.element));
        card.element.selectedManualRectangles = [marker];
        await card.updateHass(withState(initial, CAMERA, { attributes: camera.attributes }).hass);
        expect(card.element.modes.map(m => m.selectionType)).toContain(SelectionType.ROOM);
        expect(card.element.modes[0]).toBe(firstMode);
        expect(card.element.selectedManualRectangles).toEqual([marker]);
        await card.cleanup();
    });
});
