import { afterEach, describe, expect, it, vi } from "vitest";

import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountEditor, settle, waitFor } from "../harness";

/**
 * The editor receives Home Assistant's configuration object as is: frozen, possibly half-typed
 * YAML, on whatever frontend version the user runs. Each handler must copy, never mutate, and
 * must survive a selection Home Assistant can send (an empty value when a field is cleared).
 */

type EditorInternals = {
    _cameraChanged: (ev: unknown) => void;
    _vacuumChanged: (ev: unknown) => void;
    _platformChanged: (ev: unknown) => void;
    _valueChanged: (ev: unknown) => void;
};

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

function select(value: string): unknown {
    return { detail: { value }, target: { value } };
}

async function editorWith(config: XiaomiVacuumMapCardConfig) {
    const fixture = loadSyntheticFixture();
    const editor = await mountEditor(config, fixtureHass(fixture));
    const changes: XiaomiVacuumMapCardConfig[] = [];
    editor.element.addEventListener("config-changed", e => changes.push((e as CustomEvent).detail.config));
    return { editor, changes, internals: editor.element as unknown as EditorInternals };
}

describe("editor handlers", () => {
    afterEach(() => vi.restoreAllMocks());

    it("a cleared camera selection does not throw", async () => {
        // Without a calibration source the handler looks the new camera up to offer one.
        const { calibration_source: _unused, ...config } = fixtureConfig(loadSyntheticFixture());
        const { internals, changes } = await editorWith(config as XiaomiVacuumMapCardConfig);
        expect(() => internals._cameraChanged(select(""))).not.toThrow();
        expect(() => internals._cameraChanged(select("camera.removed"))).not.toThrow();
        expect(changes.at(-1)?.map_source).toEqual({ camera: "camera.removed" });
    });

    it("re-selecting the same vacuum does not emit a change", async () => {
        const config = fixtureConfig(loadSyntheticFixture());
        const { internals, changes } = await editorWith(config);
        internals._vacuumChanged(select(config.entity));
        expect(changes).toHaveLength(0);
        internals._vacuumChanged(select("vacuum.other"));
        expect(changes.at(-1)?.entity).toBe("vacuum.other");
    });

    it("every handler works on a deeply frozen configuration", async () => {
        const config = deepFreeze({
            ...fixtureConfig(loadSyntheticFixture()),
            map_modes: [{ template: "vacuum_clean_segment", predefined_selections: [] }],
        } as XiaomiVacuumMapCardConfig);
        const { internals, changes } = await editorWith(config);
        expect(() => internals._platformChanged(select("Roomba"))).not.toThrow();
        expect(() => internals._platformChanged(select("Xiaomi Miio"))).not.toThrow();
        expect(() => internals._cameraChanged(select("camera.vacuum_map_2"))).not.toThrow();
        expect(() => internals._vacuumChanged(select("vacuum.other"))).not.toThrow();
        expect(() =>
            internals._valueChanged({ target: { configValue: "map_locked", checked: true } }),
        ).not.toThrow();
        expect(changes.length).toBeGreaterThanOrEqual(4);
        expect(config.vacuum_platform).toBe("Xiaomi Miio");
    });

    it("switching to a platform with built-in calibration drops the camera calibration, and back", async () => {
        const { internals, changes } = await editorWith(fixtureConfig(loadSyntheticFixture()));
        internals._platformChanged(select("Roomba"));
        expect(changes.at(-1)?.calibration_source).toBeUndefined();
        internals._platformChanged(select("Xiaomi Miio"));
        expect(changes.at(-1)?.calibration_source).toEqual({ camera: true });
    });
});

describe("editor on other frontends", () => {
    it("renders when the frontend has no loadCardHelpers", async () => {
        const original = (window as unknown as Record<string, unknown>).loadCardHelpers;
        delete (window as unknown as Record<string, unknown>).loadCardHelpers;
        try {
            const fixture = loadSyntheticFixture();
            const editor = await mountEditor(fixtureConfig(fixture), fixtureHass(fixture));
            await settle(editor.element);
            expect(editor.shadowRoot.querySelector(".card-config")).not.toBeNull();
        } finally {
            (window as unknown as Record<string, unknown>).loadCardHelpers = original;
        }
    });

    it("renders for a malformed configuration", async () => {
        const fixture = loadSyntheticFixture();
        const config = { ...fixtureConfig(fixture), map_source: "camera.vacuum_map" } as unknown as XiaomiVacuumMapCardConfig;
        const editor = await mountEditor(config, fixtureHass(fixture));
        await waitFor(() => editor.shadowRoot.querySelector(".card-config"));
        expect(editor.shadowRoot.querySelector(".card-config")).not.toBeNull();
    });
});
