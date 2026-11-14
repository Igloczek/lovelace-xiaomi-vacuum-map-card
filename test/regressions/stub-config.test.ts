import { describe, expect, it } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket/dist/types";

import { validateConfig } from "../../src/config-validators";
import { XiaomiVacuumMapCard } from "../../src/xiaomi-vacuum-map-card";
import { cameraEntity, mockHass, syntheticCalibrationPoints, type MockEntityRegistryEntry } from "../harness";

/**
 * `getStubConfig` is what a user gets from the card picker. It used to take the first vacuum, the
 * first camera with calibration anywhere in the instance, and always the Xiaomi Miio platform, so a
 * Roborock or Dreame user got service calls for another integration and, with two vacuums, the
 * other vacuum's map.
 */

function vacuum(entityId: string): HassEntity {
    return {
        entity_id: entityId,
        state: "docked",
        attributes: { friendly_name: entityId, supported_features: 16383 },
        last_changed: "2026-11-01T10:00:00.000Z",
        last_updated: "2026-11-01T10:00:00.000Z",
        context: { id: entityId, parent_id: null, user_id: null },
    } as HassEntity;
}

function entry(entityId: string, deviceId: string, platform: string): MockEntityRegistryEntry {
    return { entity_id: entityId, device_id: deviceId, platform, unique_id: entityId } as MockEntityRegistryEntry;
}

const CALIBRATED = { calibration_points: syntheticCalibrationPoints() };

describe("generateConfig", () => {
    it.each([
        ["xiaomi_miio", "Xiaomi Miio"],
        ["roborock", "Roborock"],
        ["dreame_vacuum", "Tasshack/dreame-vacuum"],
        ["xiaomi_miot", "al-one/hass-xiaomi-miot"],
        ["deebot", "DeebotUniverse/Deebot-4-Home-Assistant"],
    ])("picks the platform from the vacuum's %s integration", (integration, platform) => {
        const hass = mockHass({
            states: {
                "vacuum.robot": vacuum("vacuum.robot"),
                "image.robot_map": cameraEntity({ entity_id: "image.robot_map", ...CALIBRATED }),
            },
            entities: [entry("vacuum.robot", "d1", integration), entry("image.robot_map", "d1", integration)],
        });
        const config = XiaomiVacuumMapCard.generateConfig(hass, "vacuum.robot");
        expect(config?.vacuum_platform).toBe(platform);
        expect(validateConfig(config!)).toEqual([]);
    });

    it("keeps Xiaomi Miio for an integration without a template", () => {
        const hass = mockHass({
            states: {
                "vacuum.robot": vacuum("vacuum.robot"),
                "camera.robot_map": cameraEntity({ entity_id: "camera.robot_map", ...CALIBRATED }),
            },
            entities: [entry("vacuum.robot", "d1", "mqtt")],
        });
        expect(XiaomiVacuumMapCard.generateConfig(hass, "vacuum.robot")?.vacuum_platform).toBe("Xiaomi Miio");
    });

    it("works without a display registry (older frontends)", () => {
        const hass = mockHass({
            states: {
                "vacuum.robot": vacuum("vacuum.robot"),
                "camera.robot_map": cameraEntity({ entity_id: "camera.robot_map", ...CALIBRATED }),
            },
        });
        delete (hass as unknown as Record<string, unknown>).entities;
        const config = XiaomiVacuumMapCard.generateConfig(hass, "vacuum.robot");
        expect(config?.map_source).toEqual({ camera: "camera.robot_map" });
    });

    it("prefers the map of the vacuum's own device", () => {
        const hass = mockHass({
            states: {
                "vacuum.upstairs": vacuum("vacuum.upstairs"),
                "vacuum.downstairs": vacuum("vacuum.downstairs"),
                "camera.upstairs_map": cameraEntity({ entity_id: "camera.upstairs_map", ...CALIBRATED }),
                "camera.downstairs_map": cameraEntity({ entity_id: "camera.downstairs_map", ...CALIBRATED }),
            },
            entities: [
                entry("vacuum.upstairs", "up", "roborock"),
                entry("vacuum.downstairs", "down", "roborock"),
                entry("camera.upstairs_map", "up", "roborock"),
                entry("camera.downstairs_map", "down", "roborock"),
            ],
        });
        expect(XiaomiVacuumMapCard.generateConfig(hass, "vacuum.downstairs")?.map_source).toEqual({
            camera: "camera.downstairs_map",
        });
    });

    it("uses the platform's own calibration for a camera without calibration points", () => {
        const hass = mockHass({
            states: {
                "vacuum.robot": vacuum("vacuum.robot"),
                "camera.robot_map": cameraEntity({ entity_id: "camera.robot_map" }),
            },
            entities: [entry("vacuum.robot", "d1", "roomba"), entry("camera.robot_map", "d1", "roomba")],
        });
        const config = XiaomiVacuumMapCard.generateConfig(hass, "vacuum.robot");
        expect(config?.vacuum_platform).toBe("Roomba");
        expect(config?.calibration_source).toBeUndefined();
        expect(validateConfig(config!)).toEqual([]);
    });

    it("returns nothing when no camera can be calibrated", () => {
        const hass = mockHass({
            states: {
                "vacuum.robot": vacuum("vacuum.robot"),
                "camera.door": cameraEntity({ entity_id: "camera.door" }),
            },
            entities: [entry("vacuum.robot", "d1", "roborock")],
        });
        expect(XiaomiVacuumMapCard.generateConfig(hass, "vacuum.robot")).toBeUndefined();
    });
});

describe("getStubConfig", () => {
    it("chooses a vacuum that has a map", () => {
        const hass = mockHass({
            states: {
                "vacuum.no_map": vacuum("vacuum.no_map"),
                "vacuum.robot": vacuum("vacuum.robot"),
                "image.robot_map": cameraEntity({ entity_id: "image.robot_map", ...CALIBRATED }),
            },
            entities: [
                entry("vacuum.no_map", "other", "roomba"),
                entry("vacuum.robot", "d1", "dreame_vacuum"),
                entry("image.robot_map", "d1", "dreame_vacuum"),
            ],
        });
        const config = XiaomiVacuumMapCard.getStubConfig(hass);
        expect(config?.entity).toBe("vacuum.robot");
        expect(config?.vacuum_platform).toBe("Tasshack/dreame-vacuum");
    });
});
