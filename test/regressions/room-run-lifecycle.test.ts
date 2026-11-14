import { afterEach, describe, expect, it, vi } from "vitest";

import { ACTIVE_ROOM_RUN_STORE_KEY } from "../../src/const";
import {
    ACTIVE_ROOM_RUN_MAX_AGE_MS,
    ACTIVE_ROOM_RUN_START_GRACE_MS,
    ActiveRoomRun,
    advanceActiveRoomRun,
    expectedVacuumState,
    isActiveRoomRunLocked,
    loadActiveRoomRun,
    nextActiveRoomRunDeadline,
} from "../../src/model/active-room-run";
import { setCurrentMode } from "../../src/card/selection";
import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";
import type { CardHandle, MockHass } from "../harness";
import { fixtureConfig, fixtureHass, loadSyntheticFixture, mountCard, settle, useHarnessClock, withState } from "../harness";

/**
 * What happens after Start, for every state sequence a vacuum and its integration can produce.
 *
 * Real integrations misbehave in ways the run tracking did not survive: polling integrations
 * (xiaomi_miot) report a state ~30 s late or go `unavailable` for a while, Start is pressed while
 * the previous job's state is still shown, the user pauses and wants other rooms, a second card or
 * tab shows the same vacuum, a service call fails, and one vacuum has several ROOM modes whose ids
 * mean different things. Each case below failed before the fix.
 */

const VACUUM = "vacuum.roborock_s7";
const BEFORE_START = "2026-11-01T09:59:00.000Z";
const AFTER_START = "2026-11-01T10:00:30.000Z";

function run(overrides: Partial<ActiveRoomRun> = {}): ActiveRoomRun {
    return { entity: VACUUM, roomIds: ["2", "0"], startedAt: 1_000, seenActive: false, ...overrides };
}

describe("advanceActiveRoomRun with lagging and uninformative states", () => {
    for (const state of ["unavailable", "unknown", undefined]) {
        it(`keeps a working run while the vacuum is ${state ?? "missing"}`, () => {
            // A polling integration loses the device for a few minutes mid-run; the vacuum keeps
            // cleaning, so the run must stay on the map.
            const working = run({ seenActive: true });
            const held = advanceActiveRoomRun(working, state, 1_000 + 10 * 60_000);
            expect(held).toBe(working);
            expect(advanceActiveRoomRun(held, "cleaning", 1_000 + 11 * 60_000)).toBe(working);
            expect(advanceActiveRoomRun(held, "docked", 1_000 + 12 * 60_000)).toBeUndefined();
        });
    }

    it("still drops a run that never started, even while the vacuum is unavailable", () => {
        expect(advanceActiveRoomRun(run(), "unavailable", 1_000 + ACTIVE_ROOM_RUN_START_GRACE_MS + 1)).toBeUndefined();
    });

    it("ends a run that has outlived any real cleaning job", () => {
        const working = run({ seenActive: true });
        expect(advanceActiveRoomRun(working, "unavailable", 1_000 + ACTIVE_ROOM_RUN_MAX_AGE_MS + 1)).toBeUndefined();
        expect(advanceActiveRoomRun(working, "cleaning", 1_000 + ACTIVE_ROOM_RUN_MAX_AGE_MS + 1)).toBeUndefined();
    });

    it("does not take the previous job's working state, reported before Start, as the start", () => {
        // Start pressed while Home Assistant still shows the last job `returning`: that report is
        // older than the command. Taking it as the start ended the run on the next (stale) `docked`
        // before the vacuum had even begun the new rooms.
        const pending = run({ reportedState: "returning", reportedChangedAt: BEFORE_START });
        expect(advanceActiveRoomRun(pending, "returning", 2_000, BEFORE_START)).toBe(pending);
        expect(advanceActiveRoomRun(pending, "docked", 20_000, "2026-11-01T10:00:10.000Z")).toBe(pending);
        expect(advanceActiveRoomRun(pending, "cleaning", 40_000, AFTER_START)).toMatchObject({ seenActive: true });
    });

    it("does not take a stale return after a stale cleaning as the start", () => {
        // Start pressed while Home Assistant still shows the last job `cleaning`; the lagging
        // integration then reports that job's trip home and dock before the new rooms. Only a
        // `cleaning` reported after Start can be this run's start.
        const pending = run({ reportedState: "cleaning", reportedChangedAt: BEFORE_START });
        expect(advanceActiveRoomRun(pending, "returning", 10_000, "2026-11-01T10:00:05.000Z")).toBe(pending);
        expect(advanceActiveRoomRun(pending, "docked", 20_000, "2026-11-01T10:00:10.000Z")).toBe(pending);
        expect(advanceActiveRoomRun(pending, "cleaning", 40_000, AFTER_START)).toMatchObject({ seenActive: true });
    });

    it("accepts a working state that never changed once the start grace has passed", () => {
        // The vacuum was already cleaning and took the new rooms without any new report.
        const pending = run({ reportedState: "cleaning", reportedChangedAt: BEFORE_START });
        const late = 1_000 + ACTIVE_ROOM_RUN_START_GRACE_MS + 1;
        expect(advanceActiveRoomRun(pending, "cleaning", late, BEFORE_START)).toMatchObject({ seenActive: true });
        expect(advanceActiveRoomRun(pending, "docked", late, BEFORE_START)).toBeUndefined();
    });

    for (const state of ["returning", "paused"]) {
        it(`drops a pending run at the start grace while the vacuum is still ${state}`, () => {
            // The command was ignored (a Viomi heading home does), and the previous job's state is
            // still shown. Only `cleaning` can be this run's start, also at the deadline.
            const pending = run({ reportedState: state, reportedChangedAt: BEFORE_START });
            const late = 1_000 + ACTIVE_ROOM_RUN_START_GRACE_MS + 1;
            expect(advanceActiveRoomRun(pending, state, late, BEFORE_START)).toBeUndefined();
            expect(isActiveRoomRunLocked(advanceActiveRoomRun(pending, state, late, BEFORE_START), state)).toBe(false);
        });
    }

    it("reports when the run can change without a state update", () => {
        expect(nextActiveRoomRunDeadline(run())).toBe(1_000 + ACTIVE_ROOM_RUN_START_GRACE_MS + 1);
        expect(nextActiveRoomRunDeadline(run({ seenActive: true }))).toBe(1_000 + ACTIVE_ROOM_RUN_MAX_AGE_MS + 1);
    });
});

describe("isActiveRoomRunLocked", () => {
    it("locks the rooms only while the vacuum is seen working through the run", () => {
        expect(isActiveRoomRunLocked(undefined, "cleaning")).toBe(false);
        expect(isActiveRoomRunLocked(run(), "cleaning")).toBe(false);
        expect(isActiveRoomRunLocked(run({ seenActive: true }), "cleaning")).toBe(true);
        expect(isActiveRoomRunLocked(run({ seenActive: true }), "returning")).toBe(true);
    });

    it("does not lock while the vacuum is paused or its state is unknown", () => {
        expect(isActiveRoomRunLocked(run({ seenActive: true }), "paused")).toBe(false);
        expect(isActiveRoomRunLocked(run({ seenActive: true }), "unavailable")).toBe(false);
        expect(isActiveRoomRunLocked(run({ seenActive: true }), undefined)).toBe(false);
    });
});

describe("expectedVacuumState", () => {
    it("reads a pending run's vacuum as cleaning, and the real state otherwise", () => {
        expect(expectedVacuumState(undefined, "docked")).toBe("docked");
        expect(expectedVacuumState(run(), "docked")).toBe("cleaning");
        // Only while the state shown at Start is still shown: a new non-working state is real.
        const pending = run({ reportedState: "docked", reportedChangedAt: BEFORE_START });
        expect(expectedVacuumState(pending, "docked", BEFORE_START)).toBe("cleaning");
        expect(expectedVacuumState(pending, "docked", AFTER_START)).toBe("docked");
        expect(expectedVacuumState(pending, "error", AFTER_START)).toBe("error");
        expect(expectedVacuumState(run(), "returning")).toBe("returning");
        expect(expectedVacuumState(run({ seenActive: true }), "paused")).toBe("paused");
    });
});

function cardConfig(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        ...fixtureConfig(loadSyntheticFixture()),
        // The badges are what is tested, so the mode declares that the platform follows the order.
        map_modes: [{ template: "vacuum_clean_segment", cleaning_order: true }],
        tiles: [],
        icons: [],
        persist_map_view: false,
        ...overrides,
    };
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

function badges(card: CardHandle): Record<string, string> {
    const entries: Array<[string, string]> = [];
    for (const id of ["0", "1", "2"]) {
        const value = card.shadowRoot.querySelector(`.room-${id}-wrapper .room-order`)?.textContent?.trim();
        if (value) entries.push([id, value]);
    }
    return Object.fromEntries(entries);
}

function highlighted(card: CardHandle): string[] {
    return ["0", "1", "2"].filter(id =>
        card.shadowRoot.querySelector(`.room-${id}-wrapper`)?.classList.contains("selected"),
    );
}

function selectedRoomIds(card: CardHandle): string[] {
    return (card.element as unknown as { selectedRooms: Array<{ toVacuum(): unknown }> }).selectedRooms.map(room =>
        String(room.toVacuum()),
    );
}

async function setVacuumState(card: CardHandle, state: string): Promise<void> {
    await card.updateHass(withState(card.hass, VACUUM, { state }).hass);
    await settle(card.element);
}

async function mount(
    overrides: Partial<XiaomiVacuumMapCardConfig> = {},
    hass: MockHass = fixtureHass(loadSyntheticFixture()),
): Promise<CardHandle> {
    const card = await mountCard(cardConfig(overrides), hass);
    await card.fireMapLoad();
    return card;
}

async function startRun(card: CardHandle, ids = ["2", "0"]): Promise<void> {
    for (const id of ids) await clickRoom(card, id);
    await runSelection(card);
}

describe("the run on the map after Start", () => {
    afterEach(() => window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY));

    it("ends a run the vacuum never started on time, without another state update", async () => {
        useHarnessClock();
        const card = await mount();
        await startRun(card);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });

        // The vacuum ignored the command (a Viomi heading home does) and nothing else changes in
        // Home Assistant, so no hass update arrives to re-check the run.
        await settle(card.element, ACTIVE_ROOM_RUN_START_GRACE_MS + 2_000);
        expect(badges(card)).toEqual({});
        expect(loadActiveRoomRun(VACUUM)).toBeUndefined();
    });

    it("ends a pending run restored after a reload on time", async () => {
        useHarnessClock();
        const card = await mount();
        await startRun(card);
        card.element.remove();

        const reloaded = await mount();
        expect(badges(reloaded)).toEqual({ "2": "1", "0": "2" });
        await settle(reloaded.element, ACTIVE_ROOM_RUN_START_GRACE_MS + 2_000);
        expect(badges(reloaded)).toEqual({});
    });

    it("keeps the run, unlocked, while a polling integration reports the vacuum unavailable", async () => {
        useHarnessClock();
        const card = await mount();
        await startRun(card);
        await setVacuumState(card, "cleaning");
        await setVacuumState(card, "unavailable");
        await settle(card.element, 5 * 60_000);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
        await setVacuumState(card, "cleaning");
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });

        // Unknown is not working: the rooms are not locked, a tap starts a new selection.
        await setVacuumState(card, "unknown");
        await clickRoom(card, "1");
        expect(selectedRoomIds(card)).toEqual(["1"]);
    });

    it("keeps a run started while the previous job's state was still shown", async () => {
        // A polling integration still shows the last job `returning` when Start is pressed, then
        // reports it `docked` before it reports the new rooms. The run used to count the stale
        // `returning` as its start and end on that `docked`.
        useHarnessClock();
        const hass = withState(fixtureHass(loadSyntheticFixture()), VACUUM, {
            state: "returning",
            last_changed: BEFORE_START,
            last_updated: BEFORE_START,
        }).hass;
        const card = await mount({}, hass);
        await startRun(card);
        // Another entity changes: Home Assistant pushes a new hass with the vacuum's old report.
        await card.updateHass(withState(card.hass, "sensor.other", { state: "1" }).hass);
        await settle(card.element);
        await card.updateHass(withState(card.hass, VACUUM, { state: "docked", last_changed: "2026-11-01T10:00:10.000Z", last_updated: "2026-11-01T10:00:10.000Z" }).hass);
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });

        await card.updateHass(withState(card.hass, VACUUM, { state: "cleaning", last_changed: AFTER_START, last_updated: AFTER_START }).hass);
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
        await clickRoom(card, "1");
        expect(selectedRoomIds(card)).toEqual([]);
    });

    it("does not take an attribute-only update of the state shown at Start as the start", async () => {
        // Polling integrations rewrite the state object whenever an attribute (battery, area)
        // changes. That bumps `last_updated` but not `last_changed`: the vacuum is still on the
        // trip home it was on before Start, and a Viomi ignores the room command meanwhile.
        useHarnessClock();
        const hass = withState(fixtureHass(loadSyntheticFixture()), VACUUM, {
            state: "returning",
            last_changed: BEFORE_START,
            last_updated: BEFORE_START,
        }).hass;
        const card = await mount({}, hass);
        await startRun(card);
        await card.updateHass(
            withState(card.hass, VACUUM, {
                state: "returning",
                last_changed: BEFORE_START,
                last_updated: "2026-11-01T10:00:05.000Z",
                attributes: { ...card.hass.states[VACUUM].attributes, battery_level: 41 },
            }).hass,
        );
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
        // Not started, so not locked: a tap starts a new selection.
        await clickRoom(card, "1");
        expect(selectedRoomIds(card)).toEqual(["1"]);
    });

    it("reads the start from last_changed, not last_updated, at card level", async () => {
        // Start while Home Assistant still shows the previous job `cleaning`; a poll rewrites it
        // with a new attribute (new last_updated, same last_changed), then the stale `docked`.
        // Neither is this run's start, so the run stays on the map, pending.
        useHarnessClock();
        const hass = withState(fixtureHass(loadSyntheticFixture()), VACUUM, {
            state: "cleaning",
            last_changed: BEFORE_START,
            last_updated: BEFORE_START,
        }).hass;
        const card = await mount({}, hass);
        await startRun(card);
        await card.updateHass(
            withState(card.hass, VACUUM, {
                state: "cleaning",
                last_changed: BEFORE_START,
                last_updated: "2026-11-01T10:00:05.000Z",
                attributes: { ...card.hass.states[VACUUM].attributes, battery_level: 41 },
            }).hass,
        );
        await settle(card.element);
        await card.updateHass(
            withState(card.hass, VACUUM, { state: "docked", last_changed: "2026-11-01T10:00:10.000Z", last_updated: "2026-11-01T10:00:10.000Z" }).hass,
        );
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
        expect(loadActiveRoomRun(VACUUM)?.seenActive).toBe(false);
    });

    it("shows the run while the service call is still in flight", async () => {
        useHarnessClock();
        const hass = fixtureHass(loadSyntheticFixture());
        let resolveCall!: () => void;
        vi.mocked(hass.callService).mockImplementation(
            () => new Promise<undefined>(resolve => (resolveCall = () => resolve(undefined))),
        );
        const card = await mount({}, hass);
        await startRun(card);

        // xiaomi_miot answers a send_command only after the device replies; the selection is
        // already cleared, so the run must already be on the map.
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
        expect(loadActiveRoomRun(VACUUM)?.roomIds).toEqual(["2", "0"]);

        resolveCall();
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
    });

    it("drops the run and gives the selection back, in order, when the service call fails", async () => {
        useHarnessClock();
        const hass = fixtureHass(loadSyntheticFixture());
        vi.mocked(hass.callService).mockRejectedValue(new Error("Unable to send command to the vacuum"));
        const card = await mount({}, hass);
        await startRun(card);

        expect(loadActiveRoomRun(VACUUM)).toBeUndefined();
        expect(selectedRoomIds(card)).toEqual(["2", "0"]);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
    });

    it("lets the user pick new rooms while the vacuum is paused", async () => {
        useHarnessClock();
        const card = await mount();
        await startRun(card);
        await setVacuumState(card, "cleaning");
        await setVacuumState(card, "paused");
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
        await clickRoom(card, "1");
        expect(selectedRoomIds(card)).toEqual(["1"]);
        expect(badges(card)).toEqual({ "1": "1" });
        expect(loadActiveRoomRun(VACUUM)).toBeUndefined();
    });

    it("binds the run to the ROOM mode it was started from", async () => {
        // rand256/ValetudoRE has three ROOM modes on one vacuum: segment ids, zone ids and spot
        // ids. A run of segments must not highlight or lock the rooms of another mode.
        useHarnessClock();
        const card = await mount({
            map_modes: [
                { template: "vacuum_clean_segment", cleaning_order: true },
                {
                    template: "vacuum_clean_segment",
                    name: "Other ROOM mode",
                    service_call_schema: { service: "script.turn_on", service_data: { rooms: "[[selection]]" } },
                },
            ],
        });
        await startRun(card);
        await setVacuumState(card, "cleaning");
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });

        setCurrentMode(card.element, 1);
        await settle(card.element);
        expect(highlighted(card)).toEqual([]);
        await clickRoom(card, "1");
        expect(selectedRoomIds(card)).toEqual(["1"]);

        setCurrentMode(card.element, 0);
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
    });

    it("shows a run started by another card on the same page, and never deletes it", async () => {
        useHarnessClock();
        const first = await mount();
        const second = await mount();

        // The second card starts a run and sees the vacuum work on it.
        await startRun(second, ["1"]);
        await setVacuumState(second, "cleaning");
        // The first card sees it done, and starts another run.
        await setVacuumState(first, "docked");
        await startRun(first, ["2", "0"]);
        await settle(second.element);
        expect(badges(second)).toEqual({ "2": "1", "0": "2" });

        // A state update reaches the second card after the first started its run: a card that kept
        // its own copy of the old run ended that copy and deleted the new run from storage.
        await setVacuumState(second, "docked");
        expect(loadActiveRoomRun(VACUUM)?.roomIds).toEqual(["2", "0"]);
        expect(badges(second)).toEqual({ "2": "1", "0": "2" });
        expect(badges(first)).toEqual({ "2": "1", "0": "2" });
    });

    it("picks up a run another browser tab started", async () => {
        useHarnessClock();
        const card = await mount();
        const stored: ActiveRoomRun = { ...run(), startedAt: Date.now() };
        window.localStorage.setItem(ACTIVE_ROOM_RUN_STORE_KEY, JSON.stringify({ [VACUUM]: stored }));
        window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE_ROOM_RUN_STORE_KEY }));
        await settle(card.element);
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
    });

    it("hides the start control while the run's start is not yet reported", async () => {
        // With a ~30 s state lag the vacuum still reads `docked` after Start, and a second tap on
        // the play icon would send `vacuum.start`: a full clean instead of the chosen rooms.
        useHarnessClock();
        const card = await mount({
            icons: [
                {
                    icon: "mdi:play-box",
                    icon_id: "test_start",
                    conditions: [{ entity: VACUUM, value_not: "cleaning" }],
                    tap_action: { action: "call-service", service: "vacuum.start" },
                },
            ],
        });
        const playIcons = (): number => card.shadowRoot.querySelectorAll('ha-icon[icon="mdi:play-box"]').length;
        await setVacuumState(card, "docked");
        expect(playIcons()).toBe(1);
        await startRun(card);
        expect(playIcons()).toBe(0);
        // The vacuum ignored the command: once the start grace has passed the control is back.
        await settle(card.element, ACTIVE_ROOM_RUN_START_GRACE_MS + 2_000);
        expect(playIcons()).toBe(1);
    });

    it("shows the start control again as soon as the vacuum reports a new non-working state", async () => {
        // The vacuum could not take the command and reports `error`. That report is real and new,
        // so the icons must not keep pretending the vacuum is cleaning for three minutes.
        useHarnessClock();
        const hass = withState(fixtureHass(loadSyntheticFixture()), VACUUM, {
            state: "docked",
            last_changed: BEFORE_START,
            last_updated: BEFORE_START,
        }).hass;
        const card = await mount(
            {
                icons: [
                    {
                        icon: "mdi:play-box",
                        icon_id: "test_start",
                        conditions: [{ entity: VACUUM, value_not: "cleaning" }],
                        tap_action: { action: "call-service", service: "vacuum.start" },
                    },
                ],
            },
            hass,
        );
        const playIcons = (): number => card.shadowRoot.querySelectorAll('ha-icon[icon="mdi:play-box"]').length;
        await startRun(card);
        expect(playIcons()).toBe(0);
        await card.updateHass(
            withState(card.hass, VACUUM, { state: "error", last_changed: AFTER_START, last_updated: AFTER_START }).hass,
        );
        await settle(card.element);
        expect(playIcons()).toBe(1);
        // The run itself stays pending (the start may still be on its way) and unlocked.
        expect(badges(card)).toEqual({ "2": "1", "0": "2" });
    });
});
