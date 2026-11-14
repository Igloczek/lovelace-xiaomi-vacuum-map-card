import { ACTIVE_ROOM_RUN_STORE_KEY } from "../const";
import {
    ACTIVE_ROOM_RUN_CHANGED_EVENT,
    ActiveRoomRun,
    advanceActiveRoomRun,
    clearActiveRoomRunIf,
    expectedVacuumState,
    isActiveRoomRunLocked,
    loadActiveRoomRun,
    nextActiveRoomRunDeadline,
    roomRunModeKey,
    saveActiveRoomRun,
} from "../model/active-room-run";
import { MapMode } from "../model/map_mode/map-mode";
import { SelectionType } from "../model/map_mode/selection-type";
import type { CardPresetConfig } from "../types/types";
import type { HomeAssistantFixed } from "../types/fixes";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";

const modeKeys = new WeakMap<MapMode, string>();

/**
 * What a run's ids mean is decided by the mode's selection type and service call, so those make up
 * its identity; the name and icon do not.
 */
export function getRoomRunModeKey(mode: MapMode): string {
    let key = modeKeys.get(mode);
    if (key === undefined) {
        key = roomRunModeKey([mode.selectionType, mode.idType, mode.serviceCallSchema.config]);
        modeKeys.set(mode, key);
    }
    return key;
}

/** The run in progress for the current vacuum, if it belongs to the ROOM mode shown. */
function getShownRoomRun(card: XiaomiVacuumMapCard): ActiveRoomRun | undefined {
    const run = card.activeRoomRun;
    const mode = card._getCurrentMode();
    if (!run || !mode || mode.selectionType !== SelectionType.ROOM) return undefined;
    if (run.entity !== card._getCurrentPreset()?.entity) return undefined;
    return run.mode === undefined || run.mode === getRoomRunModeKey(mode) ? run : undefined;
}

/** The order of the run in progress for the current vacuum, while its ROOM mode is shown. */
export function getActiveRoomOrder(card: XiaomiVacuumMapCard): string[] {
    return getShownRoomRun(card)?.roomIds ?? [];
}

/** True while room taps are refused because the vacuum is working through the shown run. */
export function isActiveRoomRunShownLocked(card: XiaomiVacuumMapCard): boolean {
    const run = getShownRoomRun(card);
    return isActiveRoomRunLocked(run, run ? card._hass?.states[run.entity]?.state : undefined);
}

/** Forgets the run on the map, when the user starts a new selection instead. */
export function dismissActiveRoomRun(card: XiaomiVacuumMapCard): void {
    const run = getShownRoomRun(card);
    if (!run) return;
    card.activeRoomRun = undefined;
    clearActiveRoomRunIf(run.entity, run);
    card.requestUpdate();
}

/**
 * Records a room run when its service call is sent, so it is shown from that moment: the
 * selection is cleared right away and some integrations answer only after the device replied.
 */
export function startActiveRoomRun(
    card: XiaomiVacuumMapCard,
    entity: string,
    roomIds: string[],
    mode: MapMode,
): ActiveRoomRun {
    const run: ActiveRoomRun = {
        entity,
        roomIds,
        startedAt: Date.now(),
        seenActive: false,
        mode: getRoomRunModeKey(mode),
        reportedState: card._hass?.states[entity]?.state,
        reportedChangedAt: card._hass?.states[entity]?.last_changed,
    };
    saveActiveRoomRun(entity, run);
    advanceCardActiveRun(card);
    return run;
}

/**
 * Undoes a run whose service call failed: nothing is cleaning, so the run leaves the map and the
 * user gets the selection back in the same order to retry. A newer run another card started is
 * left alone, and so is a selection the user has already begun again.
 */
export function rollBackActiveRoomRun(
    card: XiaomiVacuumMapCard,
    run: ActiveRoomRun,
    mode: MapMode,
    restoreSelection: (roomIds: string[]) => void,
): void {
    clearActiveRoomRunIf(run.entity, run);
    advanceCardActiveRun(card);
    if (card._getCurrentMode() !== mode || card._getCurrentPreset()?.entity !== run.entity) return;
    if (card.selectedRooms.length > 0) return;
    restoreSelection(run.roomIds);
    card.requestUpdate();
}

/**
 * The hass object the icons' conditions read. While a started run is not yet reported (a polling
 * integration lags ~30 s), the vacuum reads as the state it is about to report, so the play icon
 * does not offer `vacuum.start`, a full clean, for a job that is already starting. Tiles keep
 * showing the real state.
 */
export function getIconHass(card: XiaomiVacuumMapCard, preset: CardPresetConfig): HomeAssistantFixed {
    const run = card.activeRoomRun;
    const stateObj = card.hass?.states[preset.entity];
    if (!run || run.entity !== preset.entity || !stateObj) return card.hass;
    const expected = expectedVacuumState(run, stateObj.state, stateObj.last_changed);
    if (expected === undefined || expected === stateObj.state) return card.hass;
    return { ...card.hass, states: { ...card.hass.states, [preset.entity]: { ...stateObj, state: expected } } };
}

function clearTimer(card: XiaomiVacuumMapCard): void {
    if (card.activeRoomRunTimer !== undefined) window.clearTimeout(card.activeRoomRunTimer);
    card.activeRoomRunTimer = undefined;
}

/**
 * Reads the stored run for the current vacuum and advances it with the vacuum's state, so the
 * badges disappear once the vacuum is done. Called on every hass update, on (re)attach, and when
 * the run's next deadline passes.
 *
 * The stored run is the source of truth and is read every time: a card that kept its own copy
 * showed a stale run next to another card's new one, and saving the stale copy deleted the new run.
 *
 * With `advance` false the stored run is only shown, not advanced or saved. Changes made by another
 * card or tab are handled that way: two cards briefly holding different states would otherwise keep
 * overwriting each other's progress through the change event.
 */
export function advanceCardActiveRun(card: XiaomiVacuumMapCard, advance = true): void {
    const entity = card._getCurrentPreset()?.entity;
    if (!entity || !card.config) return;
    const previous = card.activeRoomRun;
    const stored = loadActiveRoomRun(entity);
    const stateObj = card._hass?.states[entity];
    const next = advance ? advanceActiveRoomRun(stored, stateObj?.state, Date.now(), stateObj?.last_changed) : stored;
    if (next !== stored) saveActiveRoomRun(entity, next);
    card.activeRoomRun = next;
    clearTimer(card);
    if (next && card.connected) {
        // A quiet Home Assistant sends no further update, so the card re-checks the run on time.
        const delay = Math.max(0, nextActiveRoomRunDeadline(next) - Date.now());
        card.activeRoomRunTimer = window.setTimeout(() => {
            card.activeRoomRunTimer = undefined;
            if (card.connected) advanceCardActiveRun(card);
        }, Math.min(delay, 2 ** 31 - 1));
    }
    if (JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null)) card.requestUpdate();
}

/** Handles `ACTIVE_ROOM_RUN_CHANGED_EVENT` from another card on the page. */
export function handleActiveRoomRunChanged(card: XiaomiVacuumMapCard, event: Event): void {
    const entity = (event as CustomEvent<{ entity?: string }>).detail?.entity;
    if (entity === undefined || entity === card._getCurrentPreset()?.entity) advanceCardActiveRun(card, false);
}

/** Handles the `storage` event: another tab stored or removed a run. */
export function handleActiveRoomRunStorage(card: XiaomiVacuumMapCard, event: StorageEvent): void {
    if (event.key === null || event.key === ACTIVE_ROOM_RUN_STORE_KEY) advanceCardActiveRun(card, false);
}

/** Starts following runs: listeners for other cards and tabs, and the current stored run. */
export function connectActiveRun(card: XiaomiVacuumMapCard): void {
    window.addEventListener(ACTIVE_ROOM_RUN_CHANGED_EVENT, card._handleActiveRoomRunChanged);
    window.addEventListener("storage", card._handleActiveRoomRunStorage);
    if (card.config && card._hass) advanceCardActiveRun(card);
}

export function disconnectActiveRun(card: XiaomiVacuumMapCard): void {
    window.removeEventListener(ACTIVE_ROOM_RUN_CHANGED_EVENT, card._handleActiveRoomRunChanged);
    window.removeEventListener("storage", card._handleActiveRoomRunStorage);
    clearTimer(card);
}
