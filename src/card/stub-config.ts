import { CARD_CUSTOM_ELEMENT_NAME } from "../const";
import { PlatformGenerator } from "../model/generators/platform-generator";
import type { HomeAssistantFixed } from "../types/fixes";
import type { XiaomiVacuumMapCardConfig } from "../types/types";

/**
 * Integration domains (the display registry's `platform`) whose vacuum entity maps to exactly one
 * platform template. Integrations that share a domain across several templates (Valetudo over
 * `mqtt`) are left out: the card keeps the upstream default for them rather than guess.
 */
const INTEGRATION_PLATFORMS: Record<string, string> = {
    xiaomi_miio: PlatformGenerator.XIAOMI_MIIO_PLATFORM,
    roborock: PlatformGenerator.ROBOROCK_PLATFORM,
    dreame_vacuum: PlatformGenerator.TASSHACK_DREAME_VACUUM_PLATFORM,
    xiaomi_miot: PlatformGenerator.ALONE_XIAOMI_MIOT_PLATFORM,
    neato: PlatformGenerator.NEATO_PLATFORM,
    roomba: PlatformGenerator.ROOMBA_PLATFORM,
    deebot: PlatformGenerator.DEEBOTUNIVERSE_DEEBOT_4_HOME_ASSISTANT_PLATFORM,
};

interface Candidate {
    config: XiaomiVacuumMapCardConfig;
    /** The map belongs to the vacuum's own device. */
    sameDevice: boolean;
}

function domainOf(entityId: string): string {
    return entityId.substring(0, entityId.indexOf("."));
}

/** The platform template for a vacuum, from its integration; the upstream default otherwise. */
export function detectVacuumPlatform(hass: HomeAssistantFixed, vacuumEntity: string): string {
    const integration = hass.entities?.[vacuumEntity]?.platform;
    return (integration && INTEGRATION_PLATFORMS[integration]) || PlatformGenerator.XIAOMI_MIIO_PLATFORM;
}

function candidateFor(hass: HomeAssistantFixed, vacuumEntity: string): Candidate | undefined {
    const platform = detectVacuumPlatform(hass, vacuumEntity);
    const deviceId = hass.entities?.[vacuumEntity]?.device_id;
    const platformCalibrates = PlatformGenerator.getPlatformsWithDefaultCalibration().includes(platform);
    const maps = Object.keys(hass.states ?? {})
        .filter(e => ["camera", "image"].includes(domainOf(e)))
        .map(e => ({
            entity: e,
            calibrated: !!hass.states[e]?.attributes?.["calibration_points"],
            sameDevice: deviceId !== undefined && hass.entities?.[e]?.device_id === deviceId,
        }))
        // A map without calibration points works only when the platform calibrates itself, and
        // only a map of the vacuum's own device is a safe guess then: any camera would qualify.
        .filter(m => m.calibrated || (platformCalibrates && m.sameDevice));
    // The vacuum's own map first, then the calibrated ones, keeping the state order otherwise.
    const rank = (m: (typeof maps)[number]): number => (m.sameDevice ? 0 : 2) + (m.calibrated ? 0 : 1);
    const map = [...maps].sort((a, b) => rank(a) - rank(b))[0];
    if (!map) return undefined;
    return {
        sameDevice: map.sameDevice,
        config: {
            type: "custom:" + CARD_CUSTOM_ELEMENT_NAME,
            map_source: { camera: map.entity },
            ...(map.calibrated ? { calibration_source: { camera: true } } : {}),
            entity: vacuumEntity,
            vacuum_platform: platform,
        },
    };
}

/**
 * The configuration a vacuum gets from the card picker or an entity suggestion: its integration's
 * platform template, its own device's map when it has one, and calibration from the camera or,
 * for a platform with built-in calibration, from the template.
 */
export function generateConfig(
    hass: HomeAssistantFixed,
    vacuumEntity: string,
): XiaomiVacuumMapCardConfig | undefined {
    return candidateFor(hass, vacuumEntity)?.config;
}

/** The stub for the card picker: the first vacuum with its own map, else the first with any map. */
export function getStubConfig(hass: HomeAssistantFixed): XiaomiVacuumMapCardConfig | undefined {
    const candidates = Object.keys(hass.states ?? {})
        .filter(e => domainOf(e) === "vacuum")
        .map(vacuum => candidateFor(hass, vacuum))
        .filter((c): c is Candidate => c !== undefined);
    return (candidates.find(c => c.sameDevice) ?? candidates[0])?.config;
}
