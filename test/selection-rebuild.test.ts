import { describe, expect, it } from "vitest";

import { SelectionType } from "../src/model/map_mode/selection-type";
import {
    captureSelection,
    occurrenceKeys,
    type RebuildableSelection,
    restoreSelection,
    type RestoreOptions,
    type SelectionSnapshot,
} from "../src/model/selection-rebuild";

/** A predefined object: `entity` makes it follow a state entity, `byDefault` is its default_state. */
class Item implements RebuildableSelection {
    public selected: boolean;
    constructor(
        readonly key: string,
        readonly byDefault = false,
        readonly entity?: boolean,
        readonly size = 1,
    ) {
        this.selected = entity ?? byDefault;
    }
    selectionKey(): string {
        return this.key;
    }
    restoreSelected(selected: boolean): void {
        if (this.entity === undefined) this.selected = selected;
    }
    dropSelected(): void {
        this.selected = false;
    }
    defaultSelected(): boolean {
        return this.byDefault;
    }
    selectionSize(): number {
        return this.size;
    }
}

const ROOM = SelectionType.ROOM;
const keys = (items: Item[]): string[] => items.map(item => item.key);
const restore = (items: Item[], snapshot?: SelectionSnapshot, options?: RestoreOptions): string[] =>
    keys(restoreSelection(items, snapshot, options).selected);

describe("selection rebuild", () => {
    it("keeps the previous order, not the list order", () => {
        const before = [new Item("a"), new Item("b"), new Item("c")];
        const snapshot = captureSelection(ROOM, before, [before[2], before[0]]);

        const after = [new Item("a"), new Item("b"), new Item("c")];
        expect(restore(after, snapshot)).toEqual(["c", "a"]);
        expect(after.map(item => item.selected)).toEqual([true, false, true]);
    });

    it("drops an item that disappeared and keeps the others in order", () => {
        const before = [new Item("a"), new Item("b"), new Item("c")];
        const snapshot = captureSelection(ROOM, before, [before[2], before[1], before[0]]);
        expect(restore([new Item("a"), new Item("c")], snapshot)).toEqual(["c", "a"]);
    });

    it("keeps a known default item the user deselected unselected, and gives a new item its default", () => {
        const before = [new Item("a", true), new Item("b")];
        const snapshot = captureSelection(ROOM, before, [before[1]]);
        expect(restore([new Item("a", true), new Item("b"), new Item("new", true)], snapshot)).toEqual(["b", "new"]);
    });

    it("applies a default_state the configuration newly sets on a known item", () => {
        const before = [new Item("a"), new Item("b")];
        const snapshot = captureSelection(ROOM, before, [before[1]]);
        expect(restore([new Item("a", true), new Item("b")], snapshot)).toEqual(["b", "a"]);
    });

    it("lets an entity-backed item follow its entity and appends it when it joins", () => {
        const before = [new Item("a"), new Item("e", false, false), new Item("c")];
        const snapshot = captureSelection(ROOM, before, [before[2], before[0]]);
        const joined = [new Item("a"), new Item("e", false, true), new Item("c")];
        const result = restoreSelection(joined, snapshot).selected;
        expect(keys(result)).toEqual(["c", "a", "e"]);

        const kept = captureSelection(ROOM, joined, result);
        expect(restore([new Item("a"), new Item("e", false, false), new Item("c")], kept)).toEqual(["c", "a"]);
    });

    it("keeps the first items in order within max_selections, counting each item's size", () => {
        const before = [new Item("a"), new Item("e", false, false), new Item("c")];
        const snapshot = captureSelection(ROOM, before, [before[2], before[0]]);
        const after = [new Item("a"), new Item("e", false, true), new Item("c")];
        expect(restore(after, snapshot, { maxSelections: 2 })).toEqual(["c", "a"]);
        expect(after[1].selected).toBe(false);

        const zones = [new Item("big", false, undefined, 2), new Item("small")];
        const zoneSnapshot = captureSelection(SelectionType.PREDEFINED_RECTANGLE, zones, [zones[1], zones[0]]);
        expect(restore([new Item("big", false, undefined, 2), new Item("small")], zoneSnapshot, { maxSelections: 2 })).toEqual([
            "small",
        ]);
    });

    it("holds missing items while the source is unknown and restores them in place", () => {
        const before = [new Item("a"), new Item("b"), new Item("c")];
        const snapshot = captureSelection(ROOM, before, [before[2], before[0]]);

        // The source is unavailable: nothing to show, but the selection is held.
        const unknown = restoreSelection<Item>([], snapshot, { sourceUnknown: true });
        expect(unknown.selected).toEqual([]);
        const whileUnknown = captureSelection(ROOM, [], [], unknown.held);
        expect(whileUnknown.selectedKeys).toEqual(["0:c", "0:a"]);

        expect(restore([new Item("a"), new Item("b"), new Item("c")], whileUnknown)).toEqual(["c", "a"]);
    });

    it("tells identical items apart by occurrence", () => {
        const before = [new Item("z"), new Item("z")];
        expect(occurrenceKeys(before)).toEqual(["0:z", "1:z"]);
        const snapshot = captureSelection(SelectionType.PREDEFINED_RECTANGLE, before, [before[1]]);
        const after = [new Item("z"), new Item("z")];
        restoreSelection(after, snapshot);
        expect(after.map(item => item.selected)).toEqual([false, true]);
    });

    it("uses the constructor state without a snapshot", () => {
        expect(restore([new Item("a", true), new Item("b"), new Item("c", true)], undefined)).toEqual(["a", "c"]);
    });
});
