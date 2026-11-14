import { css, CSSResultGroup, html, TemplateResult } from "lit";
import { customElement, property } from "lit/decorators";
import { ifDefined } from "lit/directives/if-defined";
import { computeStateDomain, hasAction } from "custom-card-helpers";
import { HassEntity } from "home-assistant-js-websocket/dist/types";

import { actionHandler } from "../action-handler-directive";
import { conditional } from "../utils";
import { computeEntityName } from "../entity-name";
import {
    ActionHandlerFunctionCreator,
    EntityConfig,
    ReplacedKey,
    TileConfig,
    VariablesStorage,
} from "../types/types";
import { HomeAssistantFixed } from "../types/fixes";
import { localizeEntity } from "../localize/localize";
import { computeAttributeNameDisplay } from "../localize/hass/compute_attribute_display";
import { blankBeforePercent } from "../localize/hass/blank_before_percent";
import { formatNumber } from "../localize/hass/format_number";
import { RootlessLitElement } from "./rootless-lit-element";


@customElement("xvmc-tile")
export class Tile extends RootlessLitElement {

    @property({attribute: false})
    private config!: TileConfig;

    @property({attribute: false})
    private hass!: HomeAssistantFixed;

    @property({attribute: false})
    private isInEditor!: boolean;

    @property({attribute: false})
    private onAction!: ActionHandlerFunctionCreator;

    @property({attribute: false})
    private internalVariables!: VariablesStorage;

    protected render(): TemplateResult | void {
        if (!this.config || !this.hass || !this.onAction || !this.internalVariables) {
            return;
        }
        this.className = `tile-wrapper clickable ripple ${this.config.tile_id ? `tile-${this.config.tile_id}-wrapper` : ""}`;
        const stateObj = this.config.entity ? this.hass.states[this.config.entity] : undefined;
        const title = this.getTileLabel(stateObj);
        const value = this.getTileValue(stateObj);
        const icon = this.getIcon(stateObj);
        const domain = stateObj ? computeStateDomain(stateObj) : undefined;

        return html`
            <div
                .title="${this.isInEditor ? `tile_id: ${this.config.tile_id}` : this.config.tooltip ?? ""}"
                @action="${this.onAction(this.config)}"
                .actionHandler="${actionHandler({
                    hasHold: hasAction(this.config?.hold_action),
                    hasDoubleClick: hasAction(this.config?.double_tap_action),
                })}">
                <div class="tile-title">${title}</div>
                <div class="tile-value-wrapper">
                    ${conditional(
                        icon !== "",
                        () => html`
                            <div class="tile-icon">
                                <ha-state-icon
                                    .icon=${icon}
                                    .state=${stateObj}
                                    data-domain=${ifDefined(domain)}
                                    data-state=${stateObj?.state}>
                                </ha-state-icon>
                            </div>`,
                    )}
                    <div class="tile-value">${value}</div>
                </div>
            </div>
        `;
    }

    private getTileLabel(
        stateObject?: HassEntity,
    ) {
        if (this.config.label !== undefined)
            return this.config.label;
        if (stateObject !== undefined) {
            if (this.config.attribute !== undefined)
                return computeAttributeNameDisplay(this.hass.localize, stateObject, this.hass.entities, this.config.attribute);
            return computeEntityName(this.hass, stateObject) ?? this.config.entity;
        }
        return this.config.tile_id ?? "tile";
    }

    private getTileValue(
        stateObject?: HassEntity,
    ) {
        let value: ReplacedKey = "";
        let unit = this.getUnit();
        const processNumber = this.config.multiplier !== undefined || this.config.precision !== undefined;
        // A value that is not a number - `unavailable`, `unknown`, a missing or null attribute -
        // cannot carry the tile's unit: "unavailable h" reads as a measurement. It is shown as
        // Home Assistant shows the state, without the unit.
        let numeric = false;
        if (this.config.entity && stateObject) {
            if (processNumber) {
                const raw = this.config.attribute
                    ? stateObject.attributes[this.config.attribute]
                    : stateObject.state;
                numeric = Tile.isNumeric(raw);
                value = numeric ? (raw as ReplacedKey) : localizeEntity(this.hass, this.config as EntityConfig, stateObject);
            } else {
                value = localizeEntity(this.hass, this.config as EntityConfig, stateObject);
                const originalUnit = stateObject.attributes.unit_of_measurement;
                if (unit !== "" && originalUnit && value.endsWith(originalUnit)) {
                    value = value.substring(0, value.length - originalUnit.length).trimEnd();
                }
            }
        } else if (this.config.internal_variable && this.config.internal_variable in this.internalVariables) {
            value = this.internalVariables[this.config.internal_variable];
            numeric = processNumber && Tile.isNumeric(value);
        } else if (this.config.entity && processNumber) {
            // The configured entity does not exist (removed, renamed or not loaded yet).
            value = this.hass.localize?.("state.default.unavailable") || "unavailable";
        }
        let formatted: string | undefined;
        if (processNumber && numeric) {
            const number = parseFloat(`${value}`) * (this.config.multiplier ?? 1);
            const precision = this.config.precision;
            value = precision !== undefined ? number.toFixed(precision) : number;
            // The user's number format (decimal comma, grouping), as Home Assistant's own cards
            // show numbers. The translation lookup below still uses the plain value.
            formatted = formatNumber(
                number,
                this.hass.locale,
                precision !== undefined
                    ? { minimumFractionDigits: precision, maximumFractionDigits: precision }
                    : { maximumFractionDigits: 10 },
            );
        } else if (processNumber) {
            unit = "";
        }
        const translations = this.config.translations ?? {};
        // Master matched the lower-cased value as an exact key. Keep that first so a config with
        // both `{Charging, charging}` still resolves to `charging` exactly as before, then fall back
        // to the case-insensitive scan so a mixed-case-only key still matches a differently-cased
        // value.
        const valueKey = `${value}`.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(translations, valueKey)) {
            value = translations[valueKey];
        } else {
            const translationKey = Object.keys(translations)
                .find(key => key.toLowerCase() === valueKey);
            if (translationKey !== undefined) {
                value = translations[translationKey];
            } else if (formatted !== undefined) {
                value = formatted;
            }
        }
        return `${value}${unit}`;
    }

    private static isNumeric(value: unknown): boolean {
        if (typeof value === "number") return Number.isFinite(value);
        return typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value));
    }

    private getIcon(stateObject?: HassEntity) {
        if (this.config.icon_source) {
            const split = this.config.icon_source.split(".attributes.");
            const entity = this.hass.states[split[0]];
            if (!entity) {
                // The icon's source entity is gone; fall back to the tile's own icon.
                return this.config.icon ?? stateObject?.attributes.icon ?? "";
            }
            let icon = entity.state;
            if (split.length === 2) {
                icon = entity.attributes[split[1]];
            }
            return icon;
        }
        if (this.config.icon === undefined && stateObject) {
            return stateObject.attributes.icon ?? null;
        }
        return this.config.icon;
    }

    private getUnit() {
        return !this.config.unit
            ? "" :
            this.config.unit === "%"
                ? blankBeforePercent(this.hass.locale) + "%"
                : ` ${this.config.unit}`;
    }

    public static get styles(): CSSResultGroup {
        return css`
          .tile-wrapper {
            min-width: fit-content;
            width: 80px;
            padding: 10px;
            border-radius: var(--map-card-internal-small-radius);
            background-color: var(--map-card-internal-tertiary-color);
            flex-grow: 1;
            overflow: hidden;
            color: var(--map-card-internal-tertiary-text-color);
          }

          .tile-title {
            font-size: smaller;
          }

          .tile-value-wrapper {
            display: inline-flex;
            align-items: flex-end;
            padding-top: 5px;
          }

          .tile-icon {
            padding-right: 5px;
          }

          .tile-value {
          }
        `;
    }
}
