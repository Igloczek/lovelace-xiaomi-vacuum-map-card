import { describe, expect, it } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket";

import { isCameraRoomsKnown, isEntitySourceKnown, isEntityUnavailable } from "../src/model/source-availability";

const entity = (state: string, attributes: Record<string, unknown> = {}): HassEntity =>
    ({ entity_id: "x.y", state, attributes }) as HassEntity;

describe("source availability", () => {
    it("treats a missing, unavailable or unknown entity as unavailable", () => {
        expect(isEntityUnavailable(undefined)).toBe(true);
        expect(isEntityUnavailable(entity("unavailable"))).toBe(true);
        expect(isEntityUnavailable(entity("unknown"))).toBe(true);
        expect(isEntityUnavailable(entity("idle"))).toBe(false);
    });

    it("knows camera rooms when reported, and treats their absence as unknown once seen or while unavailable", () => {
        const rooms = { "1": { name: "Kitchen" } };
        expect(isCameraRoomsKnown(entity("idle", { rooms }), true)).toBe(true);
        expect(isCameraRoomsKnown(entity("idle"), true)).toBe(false);
        expect(isCameraRoomsKnown(entity("unavailable"), false)).toBe(false);
        expect(isCameraRoomsKnown(undefined, false)).toBe(false);
        // A camera that never reported rooms is known to have none (configured rooms).
        expect(isCameraRoomsKnown(entity("idle"), false)).toBe(true);
    });

    it("knows an entity-backed list only when the entity reports it", () => {
        const states = {
            "sensor.zones": entity("unknown", { zones: [] }),
            "sensor.down": entity("unavailable", { zones: [] }),
            "sensor.points": entity("[[1,2]]"),
            "sensor.none": entity("unknown"),
        };
        expect(isEntitySourceKnown(states, "sensor.zones.attributes.zones")).toBe(true);
        expect(isEntitySourceKnown(states, "sensor.zones.attributes.other")).toBe(false);
        expect(isEntitySourceKnown(states, "sensor.down.attributes.zones")).toBe(false);
        expect(isEntitySourceKnown(states, "sensor.points")).toBe(true);
        expect(isEntitySourceKnown(states, "sensor.none")).toBe(false);
        expect(isEntitySourceKnown(states, "sensor.missing")).toBe(false);
    });
});
