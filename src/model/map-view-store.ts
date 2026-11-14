import { MAP_VIEW_STORE_KEY, MAP_VIEW_STORE_LIMIT } from "../const";
import type { MapViewConfig } from "../types/types";

export interface MapView {
    scale: number;
    x: number;
    y: number;
    rotation: number;
    locked?: boolean;
    /**
     * Untransformed width of the map content, in CSS pixels, that `x`/`y` were measured at. The
     * offsets are pixels, so a view reopened at another card width has to be scaled by
     * `currentWidth / width` to frame the same part of the map. Entries saved before this field
     * existed have no width and are applied unscaled.
     */
    width?: number;
}

interface StoredMapView {
    s: number;
    x: number;
    y: number;
    r?: number;
    l?: boolean;
    w?: number;
    ts: number;
}

type MapViewStorage = Record<string, StoredMapView>;

export function hashString(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = (hash << 5) + hash + value.charCodeAt(i);
        hash |= 0;
    }
    return (hash >>> 0).toString(36);
}

function read(): MapViewStorage {
    try {
        const raw = window.localStorage.getItem(MAP_VIEW_STORE_KEY);
        if (!raw) {
            return {};
        }
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as MapViewStorage) : {};
    } catch (e) {
        return {};
    }
}

function write(storage: MapViewStorage): void {
    try {
        const keys = Object.keys(storage);
        if (keys.length > MAP_VIEW_STORE_LIMIT) {
            keys.map(key => [key, storage[key]] as [string, StoredMapView])
                .sort(([, a], [, b]) => (a.ts ?? 0) - (b.ts ?? 0))
                .slice(0, keys.length - MAP_VIEW_STORE_LIMIT)
                .forEach(([key]) => delete storage[key]);
        }
        window.localStorage.setItem(MAP_VIEW_STORE_KEY, JSON.stringify(storage));
    } catch (e) {
        // storage unavailable or full - persisting the map view is best effort
    }
}

export function getMapView(key: string): MapView | undefined {
    const entry = read()[key];
    if (!entry || typeof entry !== "object") {
        return undefined;
    }
    const scale = Number(entry.s);
    const x = Number(entry.x);
    const y = Number(entry.y);
    const rotation = Number(entry.r ?? 0);
    const width = Number(entry.w);
    if (!Number.isFinite(scale) || !Number.isFinite(x) || !Number.isFinite(y) || scale <= 0) {
        return undefined;
    }
    return {
        scale,
        x,
        y,
        rotation: Number.isFinite(rotation) ? normalizeAngle(rotation) : 0,
        locked: typeof entry.l === "boolean" ? entry.l : undefined,
        width: Number.isFinite(width) && width > 0 ? width : undefined,
    };
}

export function setMapView(key: string, view: MapView): void {
    const storage = read();
    storage[key] = {
        s: view.scale,
        x: view.x,
        y: view.y,
        r: normalizeAngle(view.rotation),
        l: view.locked,
        w: view.width !== undefined && Number.isFinite(view.width) && view.width > 0 ? view.width : undefined,
        ts: new Date().getTime(),
    };
    write(storage);
}

/**
 * Scales a view's pixel offsets from the content width it was taken at to `width`.
 *
 * Every dimension of the map content follows the card width — the image is `width: 100%` and its
 * height follows the image's aspect ratio — so one factor keeps the same map point in the middle
 * of the viewport, at any zoom and rotation. Without a recorded width, or without a usable current
 * one, the view is returned unchanged.
 */
export function fitMapViewToWidth(view: MapView, width: number): MapView {
    if (!view.width || !Number.isFinite(width) || width <= 0 || view.width === width) {
        return view;
    }
    const factor = width / view.width;
    return { ...view, x: view.x * factor, y: view.y * factor, width };
}

/** Keeps an angle in [0, 360) so stored values stay comparable however many turns were made. */
export function normalizeAngle(degrees: number): number {
    const normalized = degrees % 360;
    return normalized < 0 ? normalized + 360 : normalized;
}

/**
 * The view to apply for one key, in fallback order: a stored view always wins, then the configured
 * default, and only when neither exists does `undefined` mean "leave the neutral view alone".
 *
 * A configured default is not stored, so it remains the target of the reset action after the user
 * pans away. Missing fields of a partial `map_view` are taken from `neutral` — scale 1, no offset
 * and the preset's `map_rotation` — which keeps a `map_view: {scale: 2.5}` from also moving or
 * rotating the map. The rotation is normalized like a stored one, so a configured 450° compares
 * equal to 90°.
 *
 * The two sources use different offset spaces: a stored `x`/`y` is already the pinch-zoom
 * transform value of a gesture, while a configured `x`/`y` is an offset from the centred view. The
 * card converts a configured view to the transform space only when it applies one — see
 * `_centreConfiguredView` — so this resolver can stay pure.
 */
export function resolveMapView(
    stored: MapView | undefined,
    configured: MapViewConfig | undefined,
    neutral: MapView,
): MapView | undefined {
    if (stored) {
        return stored;
    }
    if (!configured) {
        return undefined;
    }
    return {
        scale: configured.scale ?? neutral.scale,
        x: configured.x ?? neutral.x,
        y: configured.y ?? neutral.y,
        rotation: normalizeAngle(configured.rotation ?? neutral.rotation),
    };
}
