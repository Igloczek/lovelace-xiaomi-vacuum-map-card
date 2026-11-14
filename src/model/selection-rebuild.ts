import { SelectionType } from "./map_mode/selection-type";

/**
 * The parts of a predefined selection object (room, zone, point) a rebuild needs. Implemented by
 * `PredefinedMapObject`; kept structural so the rules below are testable without a card.
 */
export interface RebuildableSelection {
    /** Identifies the thing the object refers to: a room id, a zone list or a point. */
    selectionKey(): string;
    readonly selected: boolean;
    /** Applies a kept selection; a `state_entity` object ignores it and follows its entity. */
    restoreSelected(selected: boolean): void;
    /** Leaves the selection because of the limit, without touching a `state_entity`. */
    dropSelected(): void;
    /** Whether the object's `default_state` is `selected`. */
    defaultSelected(): boolean;
    /** How much of `max_selections` the object uses (a predefined zone counts each rectangle). */
    selectionSize(): number;
}

/**
 * What the user had selected before the card rebuilt its selectable objects. Predefined objects are
 * matched by key, so a rebuilt object takes the place of the one it replaces.
 *
 * `known` maps every object that was selectable to the `default_state` it had. A known object
 * whose default is unchanged keeps the user's choice (so a default room the user deselected stays
 * deselected); an object that is new, or whose default the configuration changed, gets its default.
 *
 * Manual selections (rectangles, path, point) are not part of the snapshot: they live on the card
 * and a rebuild of the same selection type leaves them alone.
 */
export interface SelectionSnapshot {
    readonly selectionType: SelectionType;
    readonly selectedKeys: readonly string[];
    readonly known: ReadonlyMap<string, boolean>;
}

export interface RestoreOptions {
    /**
     * The source of some objects (camera `rooms` metadata, an entity that lists zones or points) is
     * unavailable. Missing metadata means "unknown", not "gone": selected objects that are missing
     * now are held and come back, in their place, once the source reports them again.
     */
    readonly sourceUnknown?: boolean;
    /** `max_selections`: objects past it, in selection order, leave the selection. */
    readonly maxSelections?: number;
}

export interface RestoredSelection<T> {
    /** The selection, in order. */
    readonly selected: T[];
    /** The snapshot to keep while the source is unknown; pass it to the next `captureSelection`. */
    readonly held?: SelectionSnapshot;
}

/**
 * Keys made unique by occurrence: two objects that refer to the same thing (two identical zones,
 * say) are told apart by their position among equals, so selecting one does not select both.
 */
export function occurrenceKeys(items: readonly RebuildableSelection[]): string[] {
    const seen = new Map<string, number>();
    return items.map(item => {
        const key = item.selectionKey();
        const count = seen.get(key) ?? 0;
        seen.set(key, count + 1);
        return `${count}:${key}`;
    });
}

/**
 * Captures the current selection of a predefined selection type, in selection order. `held` is the
 * snapshot a rebuild kept while a source was unknown: its keys that are still missing stay in the
 * selection, in their place.
 */
export function captureSelection(
    selectionType: SelectionType,
    selectables: readonly RebuildableSelection[],
    selected: readonly RebuildableSelection[],
    held?: SelectionSnapshot,
): SelectionSnapshot {
    const keys = occurrenceKeys(selectables);
    const present = new Set(keys);
    const current = selected
        .map(item => keys[selectables.indexOf(item)])
        .filter((key): key is string => key !== undefined);
    const known = new Map(selectables.map((item, index) => [keys[index], item.defaultSelected()]));
    if (!held || held.selectionType !== selectionType) {
        return { selectionType, selectedKeys: current, known };
    }
    const missing = new Set(held.selectedKeys.filter(key => !present.has(key)));
    missing.forEach(key => known.set(key, held.known.get(key) ?? false));
    const currentSet = new Set(current);
    const ordered = held.selectedKeys.filter(key => missing.has(key) || currentSet.has(key));
    const orderedSet = new Set(ordered);
    return { selectionType, selectedKeys: [...ordered, ...current.filter(key => !orderedSet.has(key))], known };
}

/**
 * Applies `snapshot` to freshly built `selectables` and returns the selection in order.
 *
 * - An object the snapshot knew keeps the user's choice; one that disappeared is absent (or held,
 *   see `RestoreOptions.sourceUnknown`).
 * - A new object, or every object when there is no snapshot, keeps the state its constructor gave
 *   it (`default_state` or `state_entity`).
 * - A `state_entity` object follows its entity, so it may join or leave the selection.
 * - The kept objects stay in their previous order (the cleaning order for rooms); objects that
 *   joined follow in list order, and only while `max_selections` allows it.
 */
export function restoreSelection<T extends RebuildableSelection>(
    selectables: readonly T[],
    snapshot: SelectionSnapshot | undefined,
    options: RestoreOptions = {},
): RestoredSelection<T> {
    const keys = occurrenceKeys(selectables);
    if (snapshot) {
        const kept = new Set(snapshot.selectedKeys);
        selectables.forEach((item, index) => {
            if (snapshot.known.get(keys[index]) === item.defaultSelected()) item.restoreSelected(kept.has(keys[index]));
        });
    }
    const position = (index: number): number => {
        const previous = snapshot?.selectedKeys.indexOf(keys[index]) ?? -1;
        return previous < 0 ? Number.MAX_SAFE_INTEGER : previous;
    };
    const ordered = selectables
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.selected)
        .sort((a, b) => position(a.index) - position(b.index) || a.index - b.index)
        .map(({ item }) => item);
    const limit = options.maxSelections ?? Number.POSITIVE_INFINITY;
    let used = 0;
    const selected = ordered.filter(item => {
        const size = item.selectionSize();
        if (used + size > limit) {
            item.dropSelected();
            return false;
        }
        used += size;
        return true;
    });
    const held = options.sourceUnknown && snapshot ? snapshot : undefined;
    return { selected, held };
}
