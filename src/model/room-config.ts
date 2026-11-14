/**
 * Stale-room detection for configured ROOM selections (issue #928).
 *
 * Room ids come from the camera's `rooms` metadata. Integrations may re-number segments after a
 * map edit (Dreame documents that deleted segment ids are not reused and new segments get the next
 * highest id), so a `predefined_selections` list copied from an earlier map can point at rooms that
 * no longer exist - or, worse, at different rooms once an old id is reused by another map.
 *
 * The card deliberately does not remap by name: a room that was both renamed and re-numbered would
 * then be cleaned silently under the wrong id. It warns instead and leaves the corrected
 * selection to the user. Keeping the comparison pure makes it testable without a card, a camera
 * or a canvas.
 */

/** The live camera `rooms` attribute. `undefined` means the camera exposes no metadata at all. */
export type LiveRoomMetadata = Record<string, unknown> | undefined | null;

/**
 * Configured ROOM ids the live camera metadata no longer contains, in configured order, once each.
 *
 * - Missing, `null` or empty metadata is "unknown", not "all stale": the card still falls back to
 *   the configured rooms when the integration exposes no metadata, so warning there would be noise.
 *   The result is empty in that case.
 * - Duplicate configured ids are reported once.
 * - Ids are compared in their string form because camera metadata is keyed by strings while a
 *   configuration may spell the same id as a number. Comparing by name is intentionally impossible
 *   here.
 */
export function findStaleRoomIds(
    configuredIds: readonly (string | number)[],
    liveRooms: LiveRoomMetadata,
): string[] {
    const liveRoomIds = liveRooms ? Object.keys(liveRooms) : [];
    if (liveRoomIds.length === 0) return [];
    const liveRoomIdSet = new Set(liveRoomIds);

    const staleIds: string[] = [];
    for (const configuredId of configuredIds) {
        const id = String(configuredId);
        if (!liveRoomIdSet.has(id) && !staleIds.includes(id)) staleIds.push(id);
    }
    return staleIds;
}

/**
 * The camera's `rooms` attribute as room metadata keyed by id, or `undefined` when it is not a
 * plain object. A string, a list or a number is integration garbage, not metadata: its keys
 * (character or list indexes) are not room ids and must not count as live rooms.
 */
export function roomMetadata<T = unknown>(value: unknown): Record<string, T> | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as Record<string, T>;
}

/**
 * A metadata room's outline in vacuum coordinates: its own `outline` when that is a list of at
 * least three numeric points, else its `x0`/`y0`/`x1`/`y1` bounds as a rectangle, else
 * `undefined` for an entry that is not a usable room (null, a string, non-numeric values).
 */
export function metadataRoomOutline(room: unknown): Array<[number, number]> | undefined {
    if (!room || typeof room !== "object") return undefined;
    const entry = room as Record<string, unknown>;
    if (entry.outline !== undefined && entry.outline !== null) {
        const outline = entry.outline;
        if (!Array.isArray(outline) || outline.length < 3) return undefined;
        const points = outline.filter(
            (point): point is [number, number] =>
                Array.isArray(point) && point.length >= 2 && isFiniteNumber(point[0]) && isFiniteNumber(point[1]),
        );
        return points.length === outline.length ? points.map(point => [point[0], point[1]]) : undefined;
    }
    const { x0, y0, x1, y1 } = entry;
    if (!isFiniteNumber(x0) || !isFiniteNumber(y0) || !isFiniteNumber(x1) || !isFiniteNumber(y1)) return undefined;
    return [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
    ];
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}
