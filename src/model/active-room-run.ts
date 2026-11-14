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
     * The vacuum's state and its `last_updated` when the call was sent. That report predates the
     * command, so its `cleaning` or `returning` cannot be the start of this run: a polling
     * integration may still show the previous job. Compared as values, never against the browser
     * clock, so a clock difference between browser and server does not matter.
     */
    reportedState?: string;
    reportedAt?: string;
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
 * `lastUpdated` is the state object's `last_updated`. While the run is pending, a working state
 * counts as its start only when it was reported after the call (see `ActiveRoomRun.reportedAt`).
 * If the vacuum was already working and nothing changes, the start grace accepts that working
 * state rather than drop a run that is probably in progress. `unavailable` and `unknown` neither
 * start nor end a run.
 */
export function advanceActiveRoomRun(
    run: ActiveRoomRun | undefined,
    vacuumState: string | undefined,
    now: number,
    lastUpdated?: string,
): ActiveRoomRun | undefined {
    if (!run) return undefined;
    if (now - run.startedAt > ACTIVE_ROOM_RUN_MAX_AGE_MS) return undefined;
    const working = isWorking(vacuumState);
    if (run.seenActive) return working || !isInformative(vacuumState) ? run : undefined;
    const reportedAfterStart =
        run.reportedState === undefined ||
        vacuumState !== run.reportedState ||
        (run.reportedAt !== undefined && lastUpdated !== undefined && lastUpdated !== run.reportedAt);
    if (working && reportedAfterStart) return { ...run, seenActive: true };
    if (now - run.startedAt > ACTIVE_ROOM_RUN_START_GRACE_MS) return working ? { ...run, seenActive: true } : undefined;
    return run;
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
export function expectedVacuumState(run: ActiveRoomRun | undefined, vacuumState: string | undefined): string | undefined {
    if (!run || run.seenActive || isWorking(vacuumState)) return vacuumState;
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

function read(): ActiveRoomRunStorage {
    try {
        const raw = window.localStorage.getItem(ACTIVE_ROOM_RUN_STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
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
        (run.reportedAt === undefined || typeof run.reportedAt === "string")
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
        const storage = read();
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
