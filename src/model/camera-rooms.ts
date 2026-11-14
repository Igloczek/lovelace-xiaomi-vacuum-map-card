import type { OutlineType } from "../types/types";

/** One usable room from a camera's `rooms` attribute, with its geometry checked and numeric. */
export interface CameraRoom {
    /** The id as the integration publishes it, always a string (`"13"`). */
    id: string;
    /** The room's outline in vacuum coordinates; four corners when the room only has bounds. */
    outline: OutlineType;
    /**
     * True when `outline` is the `x0`/`y0`/`x1`/`y1` rectangle rather than the room's own outline:
     * only such rooms are traced from the map colours.
     */
    fromBounds: boolean;
    name?: string;
    icon?: string;
    /** The integration's own label position, when it publishes both coordinates. */
    x?: number;
    y?: number;
}

function toNumber(value: unknown): number | undefined {
    if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
    if (typeof value === "string" && value.trim() !== "") {
        const number = Number(value);
        return Number.isFinite(number) ? number : undefined;
    }
    return undefined;
}

function toOutline(value: unknown): OutlineType | undefined {
    if (!Array.isArray(value) || value.length < 3) return undefined;
    const points = value.map(point =>
        Array.isArray(point) && point.length === 2 ? [toNumber(point[0]), toNumber(point[1])] : undefined,
    );
    if (points.some(point => point === undefined || point.some(c => c === undefined))) return undefined;
    return points as OutlineType;
}

function toRoom(id: string, raw: unknown): CameraRoom | undefined {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const room = raw as Record<string, unknown>;
    // The room's own outline when it is a usable list of points; otherwise its bounds, also when the
    // outline is malformed but the bounds are fine.
    let outline: OutlineType | undefined =
        room.outline !== undefined && room.outline !== null ? toOutline(room.outline) : undefined;
    const fromBounds = outline === undefined;
    if (!outline) {
        const [x0, y0, x1, y1] = [room.x0, room.y0, room.x1, room.y1].map(toNumber);
        if ([x0, y0, x1, y1].every(v => v !== undefined)) {
            outline = [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
            ] as OutlineType;
        }
    }
    if (!outline) return undefined;
    const x = toNumber(room.x);
    const y = toNumber(room.y);
    return {
        id,
        outline,
        fromBounds,
        name: typeof room.name === "string" && room.name.trim() !== "" ? room.name : undefined,
        icon: typeof room.icon === "string" && room.icon !== "" ? room.icon : undefined,
        ...(x !== undefined && y !== undefined ? { x, y } : {}),
    };
}

/**
 * A camera's `rooms` attribute keyed by room id.
 *
 * The usual shape is already a mapping keyed by id (`{"13": {x0, y0, x1, y1, name}}`), and the key
 * is the id even when the room repeats it. A list is accepted too, keyed by each room's own `id`
 * (or `room_id`): its position in the list is not an id, and sending it would clean the wrong
 * room. Anything else has no rooms.
 */
export function cameraRoomsById(raw: unknown): Record<string, unknown> | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    if (!Array.isArray(raw)) return raw as Record<string, unknown>;
    const byId: Record<string, unknown> = {};
    for (const entry of raw) {
        const room = entry as Record<string, unknown> | null;
        const id = room?.id ?? room?.room_id;
        if (typeof id === "string" || typeof id === "number") byId[String(id)] = entry;
    }
    return byId;
}

/**
 * Reads a camera's `rooms` attribute into usable rooms (see `cameraRoomsById` for the shapes).
 *
 * Entries that are not objects, lack geometry, or carry non-numeric coordinates are skipped, so
 * one broken room never hides the others or breaks the card. A malformed outline falls back to the
 * room's bounds when those are usable. Numeric strings are accepted, since
 * some integrations publish coordinates as text.
 */
export function readCameraRooms(raw: unknown): CameraRoom[] {
    const rooms = cameraRoomsById(raw);
    if (!rooms) return [];
    return Object.keys(rooms)
        .map(id => toRoom(id, rooms[id]))
        .filter((room): room is CameraRoom => room !== undefined);
}
