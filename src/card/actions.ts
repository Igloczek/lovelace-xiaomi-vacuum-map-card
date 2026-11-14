import { ActionHandlerEvent, handleAction, HomeAssistant } from "custom-card-helpers";

import type { ActionableObjectConfig, ActionHandlerFunction } from "../types/types";
import { ServiceCallSchema } from "../model/map_mode/service-call-schema";
import { TemplatableItemValue } from "../model/map_mode/templatable-value";
import { getFilledTemplate } from "../utils";
import type { XiaomiVacuumMapCard } from "../xiaomi-vacuum-map-card";
import { callServiceReported } from "./run";

/**
 * Icon and tile actions (`tap_action`, `hold_action`, `double_tap_action`). Placeholders are filled
 * from the current selection and variables, then `custom-card-helpers` performs the action with
 * every service call routed through `callServiceReported`, so a rejection reaches the user.
 */
export function createActionWithConfigHandler(
    node: XiaomiVacuumMapCard,
    config: ActionableObjectConfig | undefined,
    action?: string,
): ActionHandlerFunction {
    if (action) {
        return (): void => handleActionWithConfig(node, config, action);
    }
    return (ev?: ActionHandlerEvent): void => handleActionWithConfig(node, config, ev?.detail?.action ?? "tap");
}

export function handleActionWithConfig(
    node: XiaomiVacuumMapCard,
    config: ActionableObjectConfig | undefined,
    action: string,
): void {
    if (node.hass && config && action) {
        const currentPreset = node._getCurrentPreset();
        const currentMode = node._getCurrentMode();
        let itemVariables = {};
        itemVariables[TemplatableItemValue.VACUUM_ENTITY_ID] = currentPreset.entity;
        if (config.hasOwnProperty("attribute")) {
            itemVariables[TemplatableItemValue.ATTRIBUTE] = config["attribute"];
        }
        if (config.hasOwnProperty("variables")) {
            itemVariables = { ...itemVariables, ...config["variables"] };
        }
        const entity_id = config.hasOwnProperty("entity") ? config["entity"] : currentPreset.entity;
        const { selection, variables } = node._getSelection(currentMode);
        const defaultVariables = ServiceCallSchema.getDefaultVariables(
            entity_id,
            selection,
            node.repeats,
            currentMode?.isPointSelection(),
        );
        const filled = getFilledTemplate(config as Record<string, unknown>, defaultVariables, itemVariables,
            node.internalVariables, currentMode?.variables ?? {}, variables);
        // `handleAction` sends `call-service` and `toggle` without waiting for the answer, so a
        // rejected call vanished. Every call it makes goes through the card instead, which reports
        // a rejection to the user.
        const reportingHass = {
            ...node.hass,
            callService: (domain: string, service: string, data?: Record<string, unknown>, target?: Record<string, unknown>) =>
                callServiceReported(node, domain, service, data, target),
        };
        handleAction(
            node,
            reportingHass as unknown as HomeAssistant,
            withCallServiceActions(filled as ActionableObjectConfig),
            action,
        );
    }
}

const ACTION_KEYS = ["tap_action", "hold_action", "double_tap_action"] as const;

/**
 * Home Assistant 2024.8 renamed `call-service` to `perform-action` (with `perform_action` and
 * `data`), and the frontend writes the new form. `custom-card-helpers` only knows the old form and
 * silently ignores the new one, so both are passed to it as `call-service`.
 */
export function withCallServiceActions(config: ActionableObjectConfig): ActionableObjectConfig {
    const result = { ...config } as Record<string, unknown>;
    for (const key of ACTION_KEYS) {
        const action = result[key] as Record<string, unknown> | undefined;
        if (!action || (action.action !== "perform-action" && action.action !== "call-service")) continue;
        const { perform_action, data, ...rest } = action;
        result[key] = {
            ...rest,
            action: "call-service",
            service: rest.service ?? perform_action,
            service_data: rest.service_data ?? data,
        };
    }
    return result as unknown as ActionableObjectConfig;
}

