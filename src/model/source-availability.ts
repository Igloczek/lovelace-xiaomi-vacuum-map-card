import type { HassEntity } from "home-assistant-js-websocket";

/**
 * One rule for every source the card builds selectable things from (the camera's `rooms`
 * metadata, an entity that lists zones or points): a source that is missing, unavailable or does
 * not report its value carries no information. The card keeps what it has (modes, rooms, the
 * selection) until the source reports again. Only a source that is available and no longer
 * reports an item drops that item.
 */

const UNAVAILABLE_STATES = ["unavailable", "unknown"];

/** The entity is missing, or Home Assistant reports it as `unavailable` or `unknown`. */
export function isEntityUnavailable(entity: HassEntity | undefined): boolean {
    return !entity || UNAVAILABLE_STATES.includes(entity.state);
}

/**
 * Whether the camera's `rooms` metadata is known. Missing metadata is unknown, not "no rooms",
 * when the camera is unavailable or has reported rooms before (`seenBefore`): a restart or an
 * integration reload drops the attribute for a while. A camera that never reported rooms is
 * known to have none, so configured rooms work without it.
 */
export function isCameraRoomsKnown(camera: HassEntity | undefined, seenBefore: boolean): boolean {
    const rooms = camera?.attributes?.rooms;
    if (rooms && typeof rooms === "object" && Object.keys(rooms).length > 0) return true;
    return !seenBefore && !isEntityUnavailable(camera);
}

/**
 * Whether an entity-backed list source (`sensor.x.attributes.zones` or `sensor.x`) is known.
 * With an attribute, the entity's own state does not matter (a sensor may be `unknown` and still
 * list zones); without one, the state is the value.
 */
export function isEntitySourceKnown(states: Record<string, HassEntity> | undefined, source: string): boolean {
    const [entityId, attribute] = source.split(".attributes.");
    const entity = states?.[entityId];
    if (!entity || entity.state === "unavailable") return false;
    return attribute ? entity.attributes[attribute] !== undefined : entity.state !== "unknown";
}
