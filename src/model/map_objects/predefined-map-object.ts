import { Context } from "./context";
import {
    PredefinedSelectionCommonConfig,
    SelectionState,
    VariablesStorage,
} from "../../types/types";
import { MapObject } from "./map-object";

export abstract class PredefinedMapObject extends MapObject {
    protected _selected: boolean;
    private readonly _common_config: PredefinedSelectionCommonConfig;

    protected constructor(config: PredefinedSelectionCommonConfig, context: Context) {
        super(context);
        this._common_config = config;
        this._selected = config.default_state == SelectionState.SELECTED;
        if (this._common_config.state_entity) {
            this._selected = this._context.getState(this._common_config.state_entity) == "on"
        }
    }

    public get variables(): VariablesStorage {
        return this._common_config.variables ?? super.variables;
    }

    public get selected(): boolean {
        return this._selected;
    }

    protected _toggleSelected(): void {
        if (this._common_config.state_entity) {
            this._selected = this._context.getState(this._common_config.state_entity) != "on"
            this._context.toggleEntity(this._common_config.state_entity)
        } else {
            this._selected = !this._selected;
        }
    }

    /** Identifies what this object refers to, so a rebuilt object can take over its selection. */
    public abstract selectionKey(): string;

    /**
     * Applies a selection kept across a rebuild. An object with a `state_entity` follows its entity
     * instead: the entity is where the selection lives.
     */
    public restoreSelected(selected: boolean): void {
        if (this._common_config.state_entity) return;
        this._selected = selected;
    }

    /** Leaves the selection because of `max_selections`; a `state_entity` is not toggled. */
    public dropSelected(): void {
        this._selected = false;
    }

    public defaultSelected(): boolean {
        return this._common_config.default_state == SelectionState.SELECTED;
    }

    /** How much of `max_selections` this object uses. */
    public selectionSize(): number {
        return 1;
    }

    public isDynamic(): boolean {
        return this._common_config.state_entity !== undefined;
    }
}
