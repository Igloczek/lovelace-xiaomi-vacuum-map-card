import { ACTIVE_ROOM_RUN_STORE_KEY } from "../const";

/**
 * The room run the card started last, so the cleaning order stays on the map while the vacuum
 * works through it. The selection itself is cleared on start (`clean_selection_on_start`), so
 * without this record the order badges vanished the moment the run began.
 */
export interface ActiveRoomRun {
    /** The vacuum entity the run was sent to. */
    entity: string;
    /** Room ids in cleaning order (click order). */
    roomIds: string[];
    /**
     * Epoch milliseconds when the service call was sent. The run is shown from that moment: some
     * integrations answer the call only after the device replied.
     */
    startedAt: number;
    /** True once the vacuum has reported a working state after the start. */
    seenActive: boolean;
    /**
     * Identity of the ROOM mode the run was started from (`roomRunModeKey`). One vacuum can have
     * several ROOM modes whose ids mean different things (segments, zones, spots), so a run is shown
     * only in its own mode. Runs stored before this field existed match any ROOM mode.
     */
    mode?: string;
    /**
     * The vacuum's state and its `last_changed` when the call was sent. That report predates the
     * command: a polling integration may still show the previous job. `last_changed` moves only
     * when the state itself changes; `last_updated` also moves on every attribute change (battery,
     * cleaned area), which says nothing about a new job. Compared as values, never against the
     * browser clock, so a clock difference between browser and server does not matter.
     */
    reportedState?: string;
    reportedChangedAt?: string;
}

/** Vacuum states that mean a run is still in progress, including the trip back between rooms. */
export const ACTIVE_VACUUM_STATES: ReadonlySet<string> = new Set(["cleaning", "paused", "returning"]);

/**
 * How long a run may wait for the vacuum to report a working state. Integrations that poll (for
 * example xiaomi_miot) report the start tens of seconds late, so the badges must survive that gap,
 * but a command the vacuum never acted on must not leave them on the map forever.
 */
export const ACTIVE_ROOM_RUN_START_GRACE_MS = 3 * 60 * 1000;

/**
 * The longest a run can be shown. `unavailable` and `unknown` keep a run on the map instead of
 * ending it, so a vacuum that never comes back must not keep its run forever. No real cleaning
 * job, including a mid-run recharge, takes this long.
 */
export const ACTIVE_ROOM_RUN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/**
 * States that say nothing about the vacuum: the integration lost the device, Home Assistant is
 * restarting, or the entity is missing from `hass.states`. Polling integrations such as
 * xiaomi_miot report these mid-run while the vacuum keeps cleaning.
 */
const UNINFORMATIVE_STATES: ReadonlySet<string> = new Set(["unavailable", "unknown"]);

function isInformative(state: string | undefined): state is string {
    return state !== undefined && !UNINFORMATIVE_STATES.has(state);
}

function isWorking(state: string | undefined): boolean {
    return isInformative(state) && ACTIVE_VACUUM_STATES.has(state);
}

/**
 * Advances a run with the vacuum's current state. Returns the same object when nothing changed,
 * an updated copy when the run first becomes active, and undefined when the run is over: the
 * vacuum reported a non-working state (docked, idle, error...) after it was seen working, or it
 * never started within the start grace period. A run ends the moment the vacuum is done, so the
 * rooms are never locked while it sits on the dock.
 *
 * `lastChanged` is the state object's `last_changed`. While the run is pending, only `cleaning`
 * reported after the call counts as its start: a different state than the one shown at Start, or
 * the same state with a new `last_changed`. `returning` and `paused` are never the start of a room
 * job; after Start they are the previous job's trip home, still on its way through a lagging
 * integration. If the vacuum was already cleaning and nothing changes, the start grace accepts
 * that `cleaning` rather than drop a run that is probably in progress; any other state at the
 * deadline drops the run. `unavailable` and
 * `unknown` neither start nor end a run.
 */
export function advanceActiveRoomRun(
    run: ActiveRoomRun | undefined,
    vacuumState: string | undefined,
    now: number,
    lastChanged?: string,
): ActiveRoomRun | undefined {
    if (!run) return undefined;
    if (now - run.startedAt > ACTIVE_ROOM_RUN_MAX_AGE_MS) return undefined;
    if (run.seenActive) return isWorking(vacuumState) || !isInformative(vacuumState) ? run : undefined;
    if (vacuumState === "cleaning" && isNewReport(run, vacuumState, lastChanged)) return { ...run, seenActive: true };
    // At the deadline only `cleaning` is accepted: a vacuum that was already cleaning and took the
    // new rooms without a new report. A `returning` or `paused` still shown then is the previous
    // job, and the command was ignored.
    if (now - run.startedAt > ACTIVE_ROOM_RUN_START_GRACE_MS) return vacuumState === "cleaning" ? { ...run, seenActive: true } : undefined;
    return run;
}

/** True when the state is not the report that was shown when the call was sent. */
function isNewReport(run: ActiveRoomRun, vacuumState: string | undefined, lastChanged: string | undefined): boolean {
    if (run.reportedState === undefined) return true;
    if (vacuumState !== run.reportedState) return true;
    return run.reportedChangedAt !== undefined && lastChanged !== undefined && lastChanged !== run.reportedChangedAt;
}

/**
 * The epoch millisecond at which `advanceActiveRoomRun` would change the run if the vacuum's state
 * stayed as it is. The card re-checks the run then, because a quiet Home Assistant sends no update
 * that would do it.
 */
export function nextActiveRoomRunDeadline(run: ActiveRoomRun): number {
    const maxAge = run.startedAt + ACTIVE_ROOM_RUN_MAX_AGE_MS + 1;
    return run.seenActive ? maxAge : Math.min(maxAge, run.startedAt + ACTIVE_ROOM_RUN_START_GRACE_MS + 1);
}

/**
 * Whether room taps are refused. Only while the vacuum is seen working through the run: before it
 * reported the start (the state may lag, or the command was ignored), while it is paused (it waits
 * for the user, who may want another job) and while its state is unknown, the run stays on the map
 * but a tap replaces it with a new selection.
 */
export function isActiveRoomRunLocked(run: ActiveRoomRun | undefined, vacuumState: string | undefined): boolean {
    return !!run?.seenActive && (vacuumState === "cleaning" || vacuumState === "returning");
}

/**
 * While the start is pending, the state the vacuum is expected to report shortly. A polling
 * integration reports the start tens of seconds late, so controls that depend on the state (the
 * play icon) would otherwise offer a second, different command for a job that is already starting.
 */
export function expectedVacuumState(
    run: ActiveRoomRun | undefined,
    vacuumState: string | undefined,
    lastChanged?: string,
): string | undefined {
    if (!run || run.seenActive || isWorking(vacuumState)) return vacuumState;
    // A new non-working report (docked, error, unavailable) after Start is real: the command was
    // ignored or failed, so the icons show it instead of waiting out the start grace.
    if (run.reportedState !== undefined && isNewReport(run, vacuumState, lastChanged)) return vacuumState;
    return "cleaning";
}

/** A short stable key for the ROOM mode a run belongs to, from what decides the meaning of its ids. */
export function roomRunModeKey(parts: unknown): string {
    const text = JSON.stringify(parts) ?? "";
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return (hash >>> 0).toString(36);
}

type ActiveRoomRunStorage = Record<string, ActiveRoomRun>;

/**
 * The last raw storage string and what it parsed to. Every card reads the stored run on every
 * Home Assistant update, so the JSON is parsed only when the string actually changed. The cached
 * object is never mutated; `saveActiveRoomRun` writes a copy.
 */
let cachedRaw: string | null | undefined;
let cachedStorage: ActiveRoomRunStorage = {};

function read(): ActiveRoomRunStorage {
    try {
        const raw = window.localStorage.getItem(ACTIVE_ROOM_RUN_STORE_KEY);
        if (raw === cachedRaw) return cachedStorage;
        const parsed = raw ? JSON.parse(raw) : {};
        cachedStorage = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
        cachedRaw = raw;
        return cachedStorage;
    } catch {
        return {};
    }
}

function isActiveRoomRun(value: unknown): value is ActiveRoomRun {
    const run = value as ActiveRoomRun | undefined;
    return (
        !!run &&
        typeof run.entity === "string" &&
        Array.isArray(run.roomIds) &&
        run.roomIds.every(id => typeof id === "string") &&
        typeof run.startedAt === "number" &&
        typeof run.seenActive === "boolean" &&
        (run.mode === undefined || typeof run.mode === "string") &&
        (run.reportedState === undefined || typeof run.reportedState === "string") &&
        (run.reportedChangedAt === undefined || typeof run.reportedChangedAt === "string")
    );
}

/** The stored run for a vacuum, kept per browser so a reload keeps showing the order. */
export function loadActiveRoomRun(entity: string): ActiveRoomRun | undefined {
    const run = read()[entity];
    return isActiveRoomRun(run) && run.entity === entity ? run : undefined;
}

/**
 * Window event fired after this page stored or removed a run, so every card on the page showing the
 * same vacuum follows at once. Other tabs learn about it from the `storage` event.
 */
export const ACTIVE_ROOM_RUN_CHANGED_EVENT = "xiaomi-vacuum-map-card-active-room-run-changed";

/** Stores or, with `undefined`, removes the run for a vacuum. Storage failures are ignored. */
export function saveActiveRoomRun(entity: string, run: ActiveRoomRun | undefined): void {
    try {
        const storage = { ...read() };
        if (JSON.stringify(storage[entity] ?? null) === JSON.stringify(run ?? null)) return;
        if (run) storage[entity] = run;
        else delete storage[entity];
        if (Object.keys(storage).length === 0) window.localStorage.removeItem(ACTIVE_ROOM_RUN_STORE_KEY);
        else window.localStorage.setItem(ACTIVE_ROOM_RUN_STORE_KEY, JSON.stringify(storage));
    } catch {
        // Private windows and blocked storage only lose the badges across a reload.
        return;
    }
    window.dispatchEvent(new CustomEvent(ACTIVE_ROOM_RUN_CHANGED_EVENT, { detail: { entity } }));
}

/**
 * Removes the stored run for a vacuum only if it is still `run`. A failed call or a dismissal must
 * not delete a newer run that another card or tab started meanwhile.
 */
export function clearActiveRoomRunIf(entity: string, run: ActiveRoomRun): void {
    if (loadActiveRoomRun(entity)?.startedAt === run.startedAt) saveActiveRoomRun(entity, undefined);
}
