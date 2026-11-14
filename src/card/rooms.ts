import { cameraRoomsById, readCameraRooms } from "../model/camera-rooms";
import type { RoomConfig, RoomConfigEventData } from "../types/types";
import { MapExtractorRoom } from "../types/types";
import { cameraRefreshKey } from "../model/map-refresh-policy";
import { RoomColorDetector } from "../model/room-color-detector";
import { findStaleRoomIds, metadataRoomOutline, roomMetadata } from "../model/room-config";
import { roomIdAtImagePoint } from "../model/room-hit-test";
import { MapMode } from "../model/map_mode/map-mode";
import { SelectionType } from "../model/map_mode/selection-type";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { rebuildSelection } from "./selection";

/** The live `rooms` attribute of the preset's camera, or undefined when it exposes none. */
export function getLiveRooms(card: XiaomiVacuumMapCard): Record<string, MapExtractorRoom> | undefined {
    const camera = card._getCurrentPreset()?.map_source?.camera;
    return camera
        ? (cameraRoomsById(card.hass?.states[camera]?.attributes["rooms"]) as Record<string, MapExtractorRoom> | undefined)
        : undefined;
}

/**
 * The live room ids of the preset's camera, or `undefined` when it reports no rooms metadata.
 * Used as the second, mode-independent guard in `_getSelection`.
 */
export function getLiveRoomIds(card: XiaomiVacuumMapCard): Set<string> | undefined {
    const rooms = getLiveRooms(card);
    const ids = rooms ? Object.keys(rooms) : [];
    return ids.length > 0 ? new Set(ids) : undefined;
}

/**
 * The current ROOM mode's configured ids that the live camera metadata no longer contains.
 * An empty list when the mode is not a ROOM mode or the camera exposes no metadata.
 *
 * The audit is deliberately recomputed from the current `hass` instead of trusting the room
 * objects: camera metadata can shift while a selection made against the old metadata is still
 * held, and that stale id must not reach the service call (issue #928).
 */
export function getStaleRoomIds(card: XiaomiVacuumMapCard, mode: MapMode | undefined): string[] {
    if (mode?.selectionType !== SelectionType.ROOM) return [];
    const configuredIds = (mode.predefinedSelections as RoomConfig[])
        .filter(room => room && room.id !== undefined)
        .map(room => room.id);
    return findStaleRoomIds(configuredIds, getLiveRooms(card));
}

export function getRoomsConfig(card: XiaomiVacuumMapCard, requestId?: string): RoomConfigEventData | undefined {
    const config = card._getCurrentPreset();
    const rawRooms = card.hass.states[config.map_source?.camera ?? ""]?.attributes["rooms"];
    const roomsConfig = new Array<RoomConfig>();
    if (rawRooms) {
        const mode = card.modes.filter(m => m.selectionType === SelectionType.ROOM).reverse()[0];
        const modeIndex = mode ? card.modes.indexOf(mode) : -1;
        for (const room of readCameraRooms(rawRooms)) {
            const outline = room.outline;
            const keepFloat = outline.toString().includes(".");
            const formatCoord = (v: number, divide = 1): number =>
                keepFloat ? v / divide : Math.round(v / divide);
            const x = outline.reduce((a, v) => a + v[0], 0);
            const y = outline.reduce((a, v) => a + v[1], 0);
            const region = card.roomColorDetection?.regions.find(candidate => candidate.id === room.id);
            const detectedCenter = region && card.coordinatesConverter
                ? card.coordinatesConverter.mapToVacuum(region.center[0], region.center[1])
                : undefined;
            const centerX = room.x ?? detectedCenter?.[0] ?? formatCoord(x, outline.length);
            const centerY = room.y ?? detectedCenter?.[1] ?? formatCoord(y, outline.length);

            roomsConfig.push({
                id: room.id,
                icon: {
                    name: room.icon ?? "mdi:broom",
                    x: centerX,
                    y: centerY,
                },
                label: {
                    text: room.name ?? `Room ${room.id}`,
                    x: centerX,
                    y: centerY,
                    offset_y: 35,
                },
                outline: outline,
            } as RoomConfig);
        }
        return {
            modeIndex: modeIndex,
            rooms: roomsConfig,
            entity: config.entity,
            camera: config.map_source?.camera,
            requestId: requestId,
        };
    }
    return undefined;
}

export function adjustRoomId(roomId: string | number, config: MapMode): string | number {
    return config.toServiceRoomId(roomId);
}

/** How long a complete room detection is reused for newer snapshots of the same room geometry. */
const ROOM_DETECTION_REUSE_MS = 10 * 60 * 1000;

export function detectRoomColors(card: XiaomiVacuumMapCard): void {
    const preset = card._getCurrentPreset();
    const camera = preset?.map_source?.camera;
    const entity = camera ? card.hass.states[camera] : undefined;
    const rooms = getLiveRooms(card);
    const image = card._getMapCanvas();
    if (!camera || !entity || !rooms || !image?.width || !image.height) {
        const hadDetection = card.roomColorDetection !== undefined;
        card.roomColorDetection = undefined;
        card.lastRoomColorDetectionKey = undefined;
        if (hadDetection) card._refreshRoomsAfterColorDetection();
        return;
    }

    const detectionKey = cameraRefreshKey({
        cameraId: camera,
        lastUpdated: entity.last_updated ?? entity.last_changed,
        entityPicture: entity.attributes.entity_picture as string | undefined,
    });
    if (detectionKey === card.lastRoomColorDetectionKey) return;
    // The canvas shows the snapshot the refresh policy last fetched, which lags the live entity
    // while a camera change is held for a loading snapshot or frozen in a hidden tab. Pairing the
    // live `rooms` with older pixels would record this state as detected and skip the real one;
    // the load of the newest snapshot runs detection instead.
    if (card.mapRefreshState && card.mapRefreshState.cameraKey !== detectionKey) return;
    card.lastRoomColorDetectionKey = detectionKey;

    const previousDetection = card.roomColorDetection;
    const converter = card.coordinatesConverter;
    // While the vacuum cleans the camera publishes a snapshot every few seconds in which only the
    // robot and the path moved. Tracing every room again each time costs hundreds of milliseconds
    // on a large map, so a complete detection of the same room geometry is kept; its label map
    // still covers the old robot spot as floor, and tap reach covers the new one. The rooms are
    // rebuilt below either way, so a renamed room shows its new name. A changed shape, size or
    // calibration, an incomplete detection, or ten minutes passing traces the rooms again.
    const reusable =
        previousDetection?.complete === true &&
        converter !== undefined &&
        card.roomColorDetectionAt !== undefined &&
        Date.now() - card.roomColorDetectionAt < ROOM_DETECTION_REUSE_MS &&
        previousDetection.geometryKey === RoomColorDetector.geometryKey(image.width, image.height, rooms, converter);
    if (!reusable) {
        card.roomColorDetection = converter ? RoomColorDetector.detect(image, rooms, converter) : undefined;
        card.roomColorDetectionAt = card.roomColorDetection ? Date.now() : undefined;
    }
    if (!card.roomColorDetection && !previousDetection) return;

    card._refreshRoomsAfterColorDetection();
}

export function refreshRoomsAfterColorDetection(card: XiaomiVacuumMapCard): void {
    if (card._getCurrentMode()?.selectionType === SelectionType.ROOM) {
        rebuildSelection(card);
    }
}

export function handleRoomColorClick(card: XiaomiVacuumMapCard, event: MouseEvent): void {
    if (card._getCurrentMode()?.selectionType !== SelectionType.ROOM || !card.roomColorDetection || !card.realScale) {
        return;
    }
    if (event.target instanceof Element && event.target.closest(".clickable")) return;

    const point = card._getMousePosition(event);
    const x = Math.floor(point.x / card.realScale);
    const y = Math.floor(point.y / card.realScale);
    // The label map, not the pixel's colour: a tap on a cleaning path or the robot drawn over a
    // room still selects that room. While a detection exists, rooms it did not find are hit-tested
    // here too, after it, so their (often bounding-box) outlines cannot take a tap from a detected
    // room they overlap. Stale rooms are never targets.
    const fallbacks = card.selectableRooms
        .filter(room => !room.stale && !room.hasImageOutline)
        .map(room => ({ id: String(room.toVacuum()), outline: room.outline }));
    const roomId = roomIdAtImagePoint(card.roomColorDetection, fallbacks, card.coordinatesConverter, x, y);
    if (roomId === undefined) return;
    const room = card.selectableRooms.find(candidate => String(candidate.toVacuum()) === roomId);
    if (room) void room.click();
}
