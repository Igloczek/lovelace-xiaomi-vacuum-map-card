import { SelectionType } from "./selection-type";
import { RepeatsType } from "./repeats-type";
import { ServiceCallSchema } from "./service-call-schema";
import {
    Language,
    LegacyServiceCallSchemaConfig,
    MapModeConfig,
    PredefinedSelectionConfig,
    ServiceCallSchemaConfig,
    VariablesStorage,
} from "../../types/types";
import { localize } from "../../localize/localize";
import { ServiceCall } from "./service-call";
import { PlatformGenerator } from "../generators/platform-generator";
import { evaluateJinjaTemplate, normalizeJinjaQuotes, replaceInTarget } from "../../utils";
import { Modifier } from "./modifier";
import { HomeAssistantFixed } from "../../types/fixes";
import { isHaVersionBefore } from "../ha-version";

export class MapMode {
    private static readonly PREDEFINED_SELECTION_TYPES = [
        SelectionType.MANUAL_POINT,
        SelectionType.PREDEFINED_RECTANGLE,
        SelectionType.ROOM,
        SelectionType.PREDEFINED_POINT,
    ];

    public name: string;
    public icon: string;
    public selectionType: SelectionType;
    public idType?: "number" | "string";
    public maxSelections: number;
    public coordinatesRounding: boolean;
    public coordinatesToMetersDivider: number;
    public runImmediately: boolean;
    public repeatsType: RepeatsType;
    public maxRepeats: number;
    public serviceCallSchema: ServiceCallSchema;
    /** Template schemas for older Home Assistant versions, oldest limit first. */
    public legacyServiceCallSchemas: Array<{ beforeHaVersion: string; schema: ServiceCallSchema }> = [];
    public predefinedSelections: PredefinedSelectionConfig[];
    public variables: VariablesStorage;

    constructor(vacuumPlatform: string, public readonly config: MapModeConfig, language: Language) {
        this.name = config.name ?? localize("map_mode.invalid", language);
        this.icon = config.icon ?? "mdi:help";
        this.idType = config.id_type;
        this.selectionType = config.selection_type
            ? SelectionType[config.selection_type]
            : SelectionType.PREDEFINED_POINT;
        this.maxSelections = config.max_selections ?? 999;
        this.coordinatesRounding = config.coordinates_rounding ?? true;
        this.coordinatesToMetersDivider = config.coordinates_to_meters_divider ?? 1000;
        this.runImmediately = config.run_immediately ?? false;
        this.repeatsType = config.repeats_type ? RepeatsType[config.repeats_type] : RepeatsType.NONE;
        this.maxRepeats = config.max_repeats ?? 1;
        this.serviceCallSchema = new ServiceCallSchema(config.service_call_schema ?? ({} as ServiceCallSchemaConfig));
        // A config's own legacy schemas belong to its own service_call_schema (an exported config).
        this.legacyServiceCallSchemas = MapMode._legacySchemas(config.legacy_service_call_schemas);
        this.predefinedSelections = config.predefined_selections ?? [];
        this.variables = config.variables ?? {};
        this._applyTemplateIfPossible(vacuumPlatform, config, language);
        if (!MapMode.PREDEFINED_SELECTION_TYPES.includes(this.selectionType)) {
            this.runImmediately = false;
        }
    }

    public async getServiceCall(
        hass: HomeAssistantFixed,
        entityId: string,
        selection: unknown[],
        repeats: number,
        selectionVariables: VariablesStorage,
    ): Promise<ServiceCall> {
        const schema = this.getServiceCallSchema(hass?.config?.version);
        let serviceCall = this._applyData(schema, entityId, selection, repeats, selectionVariables);
        if (schema.evaluateDataAsTemplate) {
            // A failed evaluation throws: sending the unevaluated `{{ }}` text to the vacuum would be
            // wrong, and the caller reports the failure instead of doing nothing.
            const template = normalizeJinjaQuotes(JSON.stringify(serviceCall.serviceData));
            let output: string | Record<string, unknown>;
            try {
                output = await evaluateJinjaTemplate(hass, template);
            } catch (e) {
                console.error("Failed to evaluate template", serviceCall.serviceData, e);
                throw e;
            }
            try {
                const serviceData = typeof output === "string" ? JSON.parse(output) : output;
                replaceInTarget(serviceData, v =>
                    v.endsWith(Modifier.JSONIFY_JINJA) ? JSON.parse(v.replace(Modifier.JSONIFY_JINJA, "")) : v,
                );
                serviceCall = { ...serviceCall, serviceData: serviceData };
            } catch (e) {
                console.error("Failed to parse template output", output);
                throw e;
            }
        }
        return serviceCall;
    }

    /** The schema for a Home Assistant version: a template's legacy schema, or the current one. */
    public getServiceCallSchema(haVersion: string | undefined): ServiceCallSchema {
        return (
            this.legacyServiceCallSchemas.find(legacy => isHaVersionBefore(haVersion, legacy.beforeHaVersion))?.schema ??
            this.serviceCallSchema
        );
    }

    /**
     * A room id in the type this mode's service expects. Camera `rooms` metadata ids are strings
     * ("13") while configured ids are usually numbers, so `id_type: number` sends a numeric id as a
     * number and `id_type: string` sends any id as a string. Without `id_type` the id is unchanged.
     */
    public toServiceRoomId(roomId: string | number): string | number {
        if (this.idType === "number") {
            const roomIdAsNumber = typeof roomId === "string" && roomId.trim() === "" ? NaN : +roomId;
            return isNaN(roomIdAsNumber) ? roomId : roomIdAsNumber;
        }
        if (this.idType === "string") {
            return String(roomId);
        }
        return roomId;
    }

    /**
     * The ROOM selection sent to the service: the room ids in click order, converted with
     * `toServiceRoomId`, followed by the repeats for `INTERNAL` repeats and repeated for `REPEAT`.
     */
    public getRoomSelection(roomIds: Array<string | number>, repeats: number): unknown[] {
        const ids = roomIds.map(id => this.toServiceRoomId(id));
        const internal = this.repeatsType === RepeatsType.INTERNAL && ids.length > 0 ? [repeats] : [];
        return this.repeatSelection([...ids, ...internal], repeats);
    }

    /** `REPEAT` repeats the whole selection: repeats 2 and `[5, 6]` give `[5, 6, 5, 6]`. */
    public repeatSelection(selection: unknown[], repeats: number): unknown[] {
        if (this.repeatsType !== RepeatsType.REPEAT) return selection;
        return Array(Math.max(1, repeats))
            .fill(0)
            .flatMap(() => selection);
    }

    public toMapModeConfig(): MapModeConfig {
        return {
            name: this.name,
            icon: this.icon,
            run_immediately: this.runImmediately,
            coordinates_rounding: this.coordinatesRounding,
            coordinates_to_meters_divider: this.coordinatesToMetersDivider,
            selection_type: SelectionType[this.selectionType],
            id_type: this.idType,
            max_selections: this.maxSelections,
            repeats_type: RepeatsType[this.repeatsType],
            max_repeats: this.maxRepeats,
            service_call_schema: JSON.parse(JSON.stringify(this.serviceCallSchema.config)),
            // Without these, an exported config pasted back would send the current payload to an
            // older Home Assistant (Deebot before 2026.3).
            legacy_service_call_schemas: this.legacyServiceCallSchemas.length
                ? this.legacyServiceCallSchemas.map(legacy => ({
                      before_ha_version: legacy.beforeHaVersion,
                      service_call_schema: JSON.parse(JSON.stringify(legacy.schema.config)),
                  }))
                : undefined,
            predefined_selections: this.predefinedSelections,
            variables: Object.fromEntries(
                Object.entries(this.variables ?? {}).map(([k, v]) => [k.substr(2, k.length - 4), v]),
            ),
        };
    }

    private _applyTemplateIfPossible(vacuumPlatform: string, config: MapModeConfig, language: Language): void {
        if (!config.template || !PlatformGenerator.isValidModeTemplate(vacuumPlatform, config.template)) return;
        const templateValue = PlatformGenerator.getModeTemplate(vacuumPlatform, config.template);
        if (!config.name && templateValue.name) this.name = localize(templateValue.name, language);
        if (!config.icon && templateValue.icon) this.icon = templateValue.icon;
        if (!config.selection_type && templateValue.selection_type)
            this.selectionType = SelectionType[templateValue.selection_type];
        if (!config.id_type && templateValue.id_type)
            this.idType = templateValue.id_type;
        if (!config.max_selections && templateValue.max_selections) this.maxSelections = templateValue.max_selections;
        if (config.coordinates_rounding === undefined && templateValue.coordinates_rounding !== undefined)
            this.coordinatesRounding = templateValue.coordinates_rounding;
        if (config.coordinates_to_meters_divider === undefined && templateValue.coordinates_to_meters_divider !== undefined)
            this.coordinatesToMetersDivider = templateValue.coordinates_to_meters_divider;
        if (config.run_immediately === undefined && templateValue.run_immediately !== undefined)
            this.runImmediately = templateValue.run_immediately;
        if (!config.repeats_type && templateValue.repeats_type)
            this.repeatsType = RepeatsType[templateValue.repeats_type];
        if (!config.max_repeats && templateValue.max_repeats) this.maxRepeats = templateValue.max_repeats;
        if (!config.service_call_schema && templateValue.service_call_schema) {
            this.serviceCallSchema = new ServiceCallSchema(templateValue.service_call_schema);
            this.legacyServiceCallSchemas = MapMode._legacySchemas(templateValue.legacy_service_call_schemas);
        }
    }

    private static _legacySchemas(
        legacy: LegacyServiceCallSchemaConfig[] | undefined,
    ): Array<{ beforeHaVersion: string; schema: ServiceCallSchema }> {
        return (legacy ?? [])
            .map(entry => ({
                beforeHaVersion: entry.before_ha_version,
                schema: new ServiceCallSchema(entry.service_call_schema),
            }))
            .sort((a, b) => (isHaVersionBefore(a.beforeHaVersion, b.beforeHaVersion) ? -1 : 1));
    }

    /** True for the selection types whose selection is one point, `[x, y]` or `[x, y, repeats]`. */
    public isPointSelection(): boolean {
        return this.selectionType === SelectionType.MANUAL_POINT || this.selectionType === SelectionType.PREDEFINED_POINT;
    }

    private _applyData(
        schema: ServiceCallSchema,
        entityId: string,
        selection: unknown[],
        repeats: number,
        selectionVariables: VariablesStorage,
    ): ServiceCall {
        return schema.apply(
            entityId,
            selection,
            repeats,
            { ...this.variables, ...selectionVariables },
            this.isPointSelection(),
        );
    }
}
