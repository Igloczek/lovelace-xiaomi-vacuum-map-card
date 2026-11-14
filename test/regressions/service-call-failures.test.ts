import { describe, expect, it, vi } from "vitest";

import type {
    ActionableObjectConfig,
    MapModeConfig,
    XiaomiVacuumMapCardConfig,
} from "../../src/types/types";
import { setPresetIndex } from "../../src/card/presets";
import { createContext } from "../../src/card/selection";
import { handleActionWithConfig } from "../../src/card/actions";
import type { XiaomiVacuumMapCard } from "../../src/xiaomi-vacuum-map-card";
import type { CardHandle, MockHass } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock, withState } from "../harness";

/**
 * Every service call the card makes must either succeed or tell the user it failed. Before this,
 * the run button cleared the selection before Home Assistant answered (a rejected call lost it), and
 * preset activation, a state-entity toggle and an icon or tile `call-service` action sent the call
 * without listening for the answer, so a rejection was only an unhandled promise in the console.
 */

const ROOM_MODE = {
    name: "Rooms",
    icon: "mdi:floor-plan",
    selection_type: "ROOM",
    max_selections: 5,
    repeats_type: "NONE",
    service_call_schema: {
        service: "vacuum.send_command",
        service_data: { entity_id: "[[entity_id]]", command: "app_segment_clean", params: "[[selection]]" },
    },
} as const;

const SWITCH_POINT_MODE = {
    name: "Points",
    icon: "mdi:map-marker",
    selection_type: "PREDEFINED_POINT",
    service_call_schema: {
        service: "vacuum.send_command",
        service_data: { entity_id: "[[entity_id]]", command: "goto", params: "[[selection]]" },
    },
    predefined_selections: [
        { id: "kitchen", position: [25500, 25500], state_entity: "input_boolean.kitchen_point", icon: { name: "mdi:map-marker", x: 25500, y: 25500 } },
    ],
} as const;

type ToastSpy = ReturnType<typeof vi.spyOn>;

interface Mounted {
    card: CardHandle;
    hass: MockHass;
    toast: ToastSpy;
}

async function mount(overrides: Partial<XiaomiVacuumMapCardConfig> = {}, modes: unknown[] = [ROOM_MODE]): Promise<Mounted> {
    useHarnessClock();
    const fixture = loadSyntheticFixture();
    let hass = fixtureHass(fixture);
    hass = withState(hass, "input_boolean.kitchen_point", { state: "off" }).hass;
    const config: XiaomiVacuumMapCardConfig = {
        ...fixtureConfig(fixture),
        map_modes: modes as unknown as MapModeConfig[],
        tiles: [],
        icons: [],
        persist_map_view: false,
        ...(overrides.additional_presets ? { preset_name: "First" } : {}),
        ...overrides,
    };
    const card = await mountCard(config, hass);
    await card.fireMapLoad();
    const toast = vi.spyOn(card.element as unknown as { _showToast: (...a: unknown[]) => void }, "_showToast");
    return { card, hass, toast };
}

async function clickRoom(card: CardHandle, id: string): Promise<void> {
    const polygon = card.shadowRoot.querySelector(`.room-${id}-wrapper .room-outline`);
    if (!polygon) throw new Error(`room ${id} has no clickable outline`);
    polygon.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element);
}

async function runSelection(card: CardHandle): Promise<void> {
    const button = card.shadowRoot.querySelector(".map-actions-item.main");
    if (!button) throw new Error("the card has no run button");
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    await settle(card.element, 400);
}

function selectedIds(card: CardHandle): string[] {
    return (card.element as unknown as { selectedRooms: Array<{ toVacuum(): unknown }> }).selectedRooms.map(room =>
        String(room.toVacuum()),
    );
}

/** Home Assistant rejects a service call with an error object, not an `Error`. */
const HA_REJECTION = { code: "invalid_format", message: "required key not provided @ data['segments']" };

describe("the run button", () => {
    it("keeps the selection and reports the error when Home Assistant rejects the call", async () => {
        const { card, hass, toast } = await mount();
        vi.mocked(hass.callService).mockRejectedValue(HA_REJECTION);
        await clickRoom(card, "1");

        await runSelection(card);

        expect(hass.callService).toHaveBeenCalledTimes(1);
        expect(toast).toHaveBeenCalledWith("popups.failed", "mdi:close", false, HA_REJECTION.message);
        expect(toast).not.toHaveBeenCalledWith("popups.success", expect.anything(), true);
        expect(selectedIds(card)).toEqual(["1"]);
    });

    it("reports a call that throws before returning a promise", async () => {
        const { card, hass, toast } = await mount();
        vi.mocked(hass.callService).mockImplementation(() => {
            throw new Error("connection lost");
        });
        await clickRoom(card, "1");

        await runSelection(card);

        expect(toast).toHaveBeenCalledWith("popups.failed", "mdi:close", false, "connection lost");
        expect(selectedIds(card)).toEqual(["1"]);
    });

    it("clears the selection only after Home Assistant accepted the call", async () => {
        const { card, hass, toast } = await mount();
        await clickRoom(card, "1");

        await runSelection(card);

        expect(toast).toHaveBeenCalledWith("popups.success", "mdi:check", true);
        expect(selectedIds(card)).toEqual([]);
        expect(vi.mocked(hass.callService).mock.calls[0].slice(0, 3)).toEqual([
            "vacuum",
            "send_command",
            { entity_id: "vacuum.roborock_s7", command: "app_segment_clean", params: ["1"] },
        ]);
    });
});

describe("fire-and-forget service calls", () => {
    it("reports a failed preset activation", async () => {
        const { card, hass, toast } = await mount({
            additional_presets: [
                {
                    ...fixtureConfig(loadSyntheticFixture()),
                    preset_name: "Second",
                    map_modes: [ROOM_MODE as unknown as MapModeConfig],
                    tiles: [],
                    icons: [],
                    activate_on_switch: true,
                    activate: { service: "script.turn_on", service_data: { entity_id: "script.prepare" } },
                },
            ],
        });
        vi.mocked(hass.callService).mockRejectedValue({ code: "not_found", message: "Service script.turn_on not found" });

        setPresetIndex(card.element as unknown as XiaomiVacuumMapCard, 1, true);
        await settle(card.element, 300);

        expect(hass.callService).toHaveBeenCalledWith("script", "turn_on", { entity_id: "script.prepare" }, undefined);
        expect(toast).toHaveBeenCalledWith("popups.failed", "mdi:close", false, "Service script.turn_on not found");
    });

    it("reports a failed toggle of a selection's state entity", async () => {
        const { card, hass, toast } = await mount({}, [SWITCH_POINT_MODE]);
        vi.mocked(hass.callService).mockRejectedValue({ code: "not_found", message: "Entity not found" });

        const context = createContext(card.element as unknown as XiaomiVacuumMapCard);
        context.toggleEntity("input_boolean.kitchen_point");
        await settle(card.element);

        expect(hass.callService).toHaveBeenCalledWith("homeassistant", "toggle", { entity_id: "input_boolean.kitchen_point" }, undefined);
        expect(toast).toHaveBeenCalledWith("popups.failed", "mdi:close", false, "Entity not found");
    });

    it.each([
        ["call-service", { action: "call-service", service: "vacuum.start", service_data: { entity_id: "[[entity_id]]" } }],
        ["perform-action", { action: "perform-action", perform_action: "vacuum.start", data: { entity_id: "[[entity_id]]" } }],
    ])("sends an icon's %s action and reports a rejection", async (_name, tapAction) => {
        const { card, hass, toast } = await mount();
        vi.mocked(hass.callService).mockRejectedValue({ code: "home_assistant_error", message: "Vacuum is offline" });

        handleActionWithConfig(
            card.element as unknown as XiaomiVacuumMapCard,
            { icon: "mdi:play", tap_action: tapAction } as unknown as ActionableObjectConfig,
            "tap",
        );
        await settle(card.element);

        expect(vi.mocked(hass.callService).mock.calls[0].slice(0, 3)).toEqual([
            "vacuum",
            "start",
            { entity_id: "vacuum.roborock_s7" },
        ]);
        expect(toast).toHaveBeenCalledWith("popups.failed", "mdi:close", false, "Vacuum is offline");
    });
});
