import { ReplacedKey, ServiceCallSchemaConfig, VariablesStorage } from "../../types/types";
import { TemplatableValue } from "./templatable-value";
import { ServiceCall } from "./service-call";
import { getFilledTemplate } from "../../utils";

export class ServiceCallSchema {
    public readonly evaluateDataAsTemplate: boolean;
    private readonly service: string;
    private readonly serviceData?: Record<string, unknown>;
    private readonly target?: Record<string, unknown>;

    constructor(public readonly config: ServiceCallSchemaConfig) {
        this.service = config.service;
        this.serviceData = config.service_data;
        this.target = config.target;
        this.evaluateDataAsTemplate = config.evaluate_data_as_template ?? false;
    }

    public apply(
        entityId: string,
        selection: unknown[],
        repeats: number,
        variables: VariablesStorage,
        pointSelection?: boolean,
    ): ServiceCall {
        const defaultVariables = ServiceCallSchema.getDefaultVariables(entityId, selection, repeats, pointSelection);
        let serviceData: ReplacedKey | undefined = undefined;
        let target: ReplacedKey | undefined = undefined;
        if (this.serviceData) {
            serviceData = getFilledTemplate(this.serviceData, defaultVariables, variables);
        }
        if (this.target) {
            target = getFilledTemplate(this.target, defaultVariables, variables);
        }
        const service = this.service.split(".");
        return new ServiceCall(
            service[0],
            service[1],
            serviceData as Record<string, unknown> | undefined,
            target as Record<string, unknown> | undefined,
        );
    }

    /**
     * `pointSelection` says whether the selection is one point (a point mode). Without it, only a
     * two-number selection counts as a point, as before; with it, a point mode's `[x, y, repeats]`
     * also fills `[[point_x]]`/`[[point_y]]` and no other mode does.
     */
    public static getDefaultVariables(
        entityId: string,
        selection: unknown[],
        repeats: number,
        pointSelection?: boolean,
    ): VariablesStorage {
        const isPoint = this.isPoint(selection, pointSelection);
        const variables: VariablesStorage = {};
        variables[TemplatableValue.ENTITY_ID] = entityId;
        variables[TemplatableValue.SELECTION] = selection;
        variables[TemplatableValue.SELECTION_SIZE] = selection.length;
        variables[TemplatableValue.SELECTION_UNWRAPPED] = JSON.stringify(selection)
            .replaceAll("[", "")
            .replaceAll("]", "")
            .replaceAll('"', "");
        variables[TemplatableValue.REPEATS] = repeats;
        variables[TemplatableValue.POINT_X] = isPoint ? (selection[0] as number) : "";
        variables[TemplatableValue.POINT_Y] = isPoint ? (selection[1] as number) : "";
        return variables;
    }

    private static isPoint(selection: unknown[], pointSelection?: boolean): boolean {
        const numbers = typeof selection[0] === "number" && typeof selection[1] === "number";
        if (pointSelection === undefined) return numbers && selection.length == 2;
        return pointSelection && numbers && (selection.length == 2 || selection.length == 3);
    }
}
