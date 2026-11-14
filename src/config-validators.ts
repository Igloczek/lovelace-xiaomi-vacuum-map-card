import {
    CalibrationPoint,
    CalibrationSourceConfig,
    CardLayout,
    CardPresetConfig,
    IconActionConfig,
    IconConfig,
    LabelConfig,
    Language,
    MapModeConfig,
    MapSourceConfig,
    MapViewConfig,
    PredefinedPointConfig,
    PredefinedSelectionConfig,
    PredefinedZoneConfig,
    RoomConfig,
    ServiceCallSchemaConfig,
    TileConfig,
    TranslatableString,
    XiaomiVacuumMapCardConfig,
} from "./types/types";
import { localize } from "./localize/localize";
import { MAP_VIEW_MAX_SCALE, MAP_VIEW_MIN_SCALE } from "./const";
import { MapMode } from "./model/map_mode/map-mode";
import { SelectionType } from "./model/map_mode/selection-type";
import { PlatformGenerator } from "./model/generators/platform-generator";
import { HomeAssistantFixed } from "./types/fixes";
import { RepeatsType } from "./model/map_mode/repeats-type";

/*
 * Every value below comes from YAML a user typed, so a field can hold any JSON-like value: a scalar
 * where a list belongs, `null` from an empty key, a list item that is a string. The parser accepts
 * all of those. Each validator checks the shape before it reads a property or calls an array
 * method, and reports the field by name, so a typo yields a message instead of a TypeError.
 */

function isMapping(value: unknown): boolean {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notMapping(field: string): TranslatableString {
    return ["validation.type.mapping", "{0}", field];
}

function notList(field: string): TranslatableString {
    return ["validation.type.list", "{0}", field];
}

/** Validates each item of an optional list, or reports the field when it is not a list. */
function validateList<T>(
    value: unknown,
    field: string,
    validateItem: (item: T) => TranslatableString[],
): TranslatableString[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) return [notList(field)];
    return value.flatMap(item => validateItem(item as T));
}

/**
 * The offending value of an enum option written by name (`selection_type: ROOM`), or `undefined`
 * when it is a valid name or absent. `null` and `""` (an empty YAML key) are absent and fall back
 * to the default, as upstream did. A number is rejected even where it indexes the enum: the
 * TypeScript enum maps `2` to `ROOM`, so `selection_type: 2` would silently mean a room mode.
 */
function validateEnumName(value: unknown, values: Record<string, unknown>): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const name = String(value);
    return typeof value === "string" && Number.isNaN(Number(name)) && name in values ? undefined : name;
}

function validateConditions(conditions: unknown, field: string): TranslatableString[] {
    return validateList<unknown>(conditions, field, condition =>
        isMapping(condition) ? [] : [notMapping(field)],
    );
}

function validateMapSource(mapSource: MapSourceConfig): TranslatableString[] {
    if (!isMapping(mapSource)) {
        return [notMapping("map_source")];
    }
    if (!mapSource.camera && !mapSource.image) {
        return ["validation.preset.map_source.none_provided"];
    }
    if (mapSource.camera && mapSource.image) {
        return ["validation.preset.map_source.ambiguous"];
    }
    return [];
}

function validateCalibrationPoint(calibrationPoint: CalibrationPoint): TranslatableString[] {
    if (!isMapping(calibrationPoint)) {
        return [notMapping("calibration_points")];
    }
    const errors: TranslatableString[] = [];
    if (!calibrationPoint?.map) {
        errors.push("validation.preset.calibration_source.calibration_points.missing_map");
    }
    if (!calibrationPoint?.vacuum) {
        errors.push("validation.preset.calibration_source.calibration_points.missing_vacuum");
    }
    if (
        [calibrationPoint?.map, calibrationPoint?.vacuum]
            .filter(p => p !== undefined)
            .some(p => !isMapping(p) || p.x === undefined || p.y === undefined)
    ) {
        errors.push("validation.preset.calibration_source.calibration_points.missing_coordinate");
    }
    return errors;
}

function validateCalibrationSource(calibrationSource: CalibrationSourceConfig): TranslatableString[] {
    if (!isMapping(calibrationSource)) {
        return [notMapping("calibration_source")];
    }
    if (Object.keys(calibrationSource).filter(k => k != "attribute").length > 1) {
        return ["validation.preset.calibration_source.ambiguous"];
    }
    if (calibrationSource.calibration_points) {
        if (!Array.isArray(calibrationSource.calibration_points)) {
            return [notList("calibration_points")];
        }
        if (![3, 4].includes(calibrationSource.calibration_points.length)) {
            return ["validation.preset.calibration_source.calibration_points.invalid_number"];
        }
        return calibrationSource.calibration_points.flatMap(cp => validateCalibrationPoint(cp));
    }
    return [];
}

function validateIconConfig(config: IconActionConfig): TranslatableString[] {
    if (!isMapping(config)) {
        return ["validation.preset.icons.invalid"];
    }
    const errors: TranslatableString[] = [...validateConditions(config.conditions, "icons.conditions")];
    if (!config.icon && config.type !== "menu" && !config.replace_config) {
        errors.push("validation.preset.icons.icon.missing");
    }
    return errors;
}

function validateTileConfig(config: TileConfig): TranslatableString[] {
    if (!isMapping(config)) {
        return ["validation.preset.tiles.invalid"];
    }
    const errors: TranslatableString[] = [...validateConditions(config.conditions, "tiles.conditions")];
    if (config.replace_config) {
        return errors;
    }
    if (!config.entity && !config.internal_variable) {
        errors.push("validation.preset.tiles.entity.missing");
    }
    if (!config.label && !config.entity) {
        errors.push("validation.preset.tiles.label.missing");
    }
    return errors;
}

function validateIcon(config: IconConfig): TranslatableString[] {
    if (!isMapping(config)) {
        return [notMapping("icon")];
    }
    if (config.x === undefined) {
        return ["validation.preset.map_modes.predefined_selections.icon.x.missing"];
    }
    if (config.y === undefined) {
        return ["validation.preset.map_modes.predefined_selections.icon.y.missing"];
    }
    if (!config.name) {
        return ["validation.preset.map_modes.predefined_selections.icon.name.missing"];
    }
    return [];
}

function validateLabel(config: LabelConfig): TranslatableString[] {
    if (!isMapping(config)) {
        return [notMapping("label")];
    }
    if (config.x === undefined) {
        return ["validation.preset.map_modes.predefined_selections.label.x.missing"];
    }
    if (config.y === undefined) {
        return ["validation.preset.map_modes.predefined_selections.label.y.missing"];
    }
    if (!config.text) {
        return ["validation.preset.map_modes.predefined_selections.label.text.missing"];
    }
    return [];
}

function validatePredefinedRectangleConfig(ps: PredefinedSelectionConfig): TranslatableString[] {
    if (!isMapping(ps)) {
        return [notMapping("predefined_selections")];
    }
    const config = ps as PredefinedZoneConfig;
    const errors: TranslatableString[] = [];
    if (!config.zones) {
        errors.push("validation.preset.map_modes.predefined_selections.zones.missing");
    } else if (typeof config.zones !== "string" && !Array.isArray(config.zones)) {
        errors.push(notList("zones"));
    } else if (
        typeof config.zones !== "string" &&
        config.zones.some(z => !Array.isArray(z) || z.length != 4)
    ) {
        errors.push("validation.preset.map_modes.predefined_selections.zones.invalid_parameters_number");
    }
    if (config.icon) {
        validateIcon(config.icon).forEach(e => errors.push(e));
    }
    if (config.label) {
        validateLabel(config.label).forEach(e => errors.push(e));
    }
    return errors;
}

function validatePredefinedPointConfig(ps: PredefinedSelectionConfig): TranslatableString[] {
    if (!isMapping(ps)) {
        return [notMapping("predefined_selections")];
    }
    const config = ps as PredefinedPointConfig;
    const errors: TranslatableString[] = [];
    if (!config.position) {
        errors.push("validation.preset.map_modes.predefined_selections.points.position.missing");
    }
    if (typeof config.position !== "string" && (!Array.isArray(config.position) || config.position.length != 2)) {
        errors.push("validation.preset.map_modes.predefined_selections.points.position.invalid_parameters_number");
    }
    if (config.icon) {
        validateIcon(config.icon).forEach(e => errors.push(e));
    }
    if (config.label) {
        validateLabel(config.label).forEach(e => errors.push(e));
    }
    return errors;
}

function validateRoomConfig(ps: PredefinedSelectionConfig): TranslatableString[] {
    if (!isMapping(ps)) {
        return [notMapping("predefined_selections")];
    }
    const config = ps as RoomConfig;
    const errors: TranslatableString[] = [];
    if (config.id === undefined || config.id === null) {
        errors.push("validation.preset.map_modes.predefined_selections.rooms.id.missing");
    } else if (!config.id.toString().match(/^[A-Za-z0-9 _]+$/i)) {
        errors.push([
            "validation.preset.map_modes.predefined_selections.rooms.id.invalid_format",
            "{0}",
            config.id.toString(),
        ]);
    }
    if (config.outline !== undefined && config.outline !== null && !Array.isArray(config.outline)) {
        errors.push(notList("outline"));
    } else if ((config.outline ?? []).some(o => !Array.isArray(o) || o.length != 2)) {
        errors.push("validation.preset.map_modes.predefined_selections.rooms.outline.invalid_parameters_number");
    }
    if (config.icon) {
        validateIcon(config.icon).forEach(e => errors.push(e));
    }
    if (config.label) {
        validateLabel(config.label).forEach(e => errors.push(e));
    }
    return errors;
}

function validateServiceCallSchemaConfig(config: ServiceCallSchemaConfig): TranslatableString[] {
    if (!isMapping(config)) {
        return [notMapping("service_call_schema")];
    }
    if (typeof config.service !== "string" || !config.service) {
        return ["validation.preset.map_modes.service_call_schema.service.missing"];
    }
    if (!config.service.includes(".")) {
        return [["validation.preset.map_modes.service_call_schema.service.invalid", "{0}", config.service]];
    }
    return [];
}

function validateMapModeConfig(
    vacuumPlatform: string,
    config: MapModeConfig,
    language: Language,
): TranslatableString[] {
    if (!isMapping(config)) {
        return ["validation.preset.map_modes.invalid"];
    }
    if (config.template && !PlatformGenerator.isValidModeTemplate(vacuumPlatform, config.template)) {
        return [["validation.preset.map_modes.template.invalid", "{0}", config.template]];
    }
    const errors: TranslatableString[] = [];
    const selectionTypeError = validateEnumName(config.selection_type, SelectionType as unknown as Record<string, unknown>);
    if (selectionTypeError !== undefined) {
        return [["validation.preset.map_modes.selection_type.invalid", "{0}", selectionTypeError]];
    }
    const repeatsTypeError = validateEnumName(config.repeats_type, RepeatsType as unknown as Record<string, unknown>);
    if (repeatsTypeError !== undefined) {
        return [["validation.preset.map_modes.repeats_type.invalid", "{0}", repeatsTypeError]];
    }
    if (config.predefined_selections !== undefined && config.predefined_selections !== null
        && !Array.isArray(config.predefined_selections)) {
        return [notList("predefined_selections")];
    }
    if (!config.template && !config.icon) {
        errors.push("validation.preset.map_modes.icon.missing");
    }
    if (!config.template && !config.name) {
        errors.push("validation.preset.map_modes.name.missing");
    }
    if (!config.template && !config.service_call_schema) {
        errors.push("validation.preset.map_modes.service_call_schema.missing");
    }
    const parsed = new MapMode(vacuumPlatform, config, language);
    switch (parsed.selectionType) {
        case SelectionType.PREDEFINED_RECTANGLE:
            parsed.predefinedSelections
                .flatMap(ps => validatePredefinedRectangleConfig(ps))
                .forEach(e => errors.push(e));
            break;
        case SelectionType.ROOM:
            parsed.predefinedSelections.flatMap(ps => validateRoomConfig(ps)).forEach(e => errors.push(e));
            break;
        case SelectionType.PREDEFINED_POINT:
            parsed.predefinedSelections.flatMap(ps => validatePredefinedPointConfig(ps)).forEach(e => errors.push(e));
            break;
        case SelectionType.MANUAL_RECTANGLE:
        case SelectionType.MANUAL_PATH:
        case SelectionType.MANUAL_POINT:
            if (parsed.predefinedSelections?.length ?? 0 > 0) {
                errors.push([
                    "validation.preset.map_modes.predefined_selections.not_applicable",
                    "{0}",
                    SelectionType[parsed.selectionType],
                ]);
            }
    }
    if (config.service_call_schema)
        validateServiceCallSchemaConfig(config.service_call_schema).forEach(e => errors.push(e));
    return errors;
}

function validatePreset(config: CardPresetConfig, nameRequired: boolean, language: Language): TranslatableString[] {
    if (!isMapping(config)) {
        return [notMapping("additional_presets")];
    }
    if (config.vacuum_platform !== undefined && typeof config.vacuum_platform !== "string") {
        return [["validation.preset.platform.invalid", "{0}", JSON.stringify(config.vacuum_platform)]];
    }
    const errors: TranslatableString[] = [];
    const platformsWithDefaultCalibration = PlatformGenerator.getPlatformsWithDefaultCalibration();
    const mandatoryFields = new Map<string, string>([
        ["entity", "validation.preset.entity.missing"],
        ["map_source", "validation.preset.map_source.missing"],
    ]);
    const vacuumPlatform = PlatformGenerator.getPlatformName(config.vacuum_platform);
    if (!platformsWithDefaultCalibration.includes(vacuumPlatform)) {
        mandatoryFields.set("calibration_source", "validation.preset.calibration_source.missing");
    }
    // An empty YAML key (`calibration_source:`) is `null`, which counts as missing.
    const params = Object.keys(config).filter(k => (config as unknown as Record<string, unknown>)[k] != null);
    mandatoryFields.forEach((v: string, k: string) => {
        if (!params.includes(k)) {
            errors.push(v);
        }
    });
    if (config.map_source != null) validateMapSource(config.map_source).forEach(e => errors.push(e));
    // An empty `calibration_source:` key is YAML `null`: absent, as upstream treated it.
    if (config.calibration_source !== undefined && config.calibration_source !== null)
        validateCalibrationSource(config.calibration_source as CalibrationSourceConfig).forEach(e => errors.push(e));
    if (config.vacuum_platform
        && !PlatformGenerator.getPlatforms().includes(PlatformGenerator.getPlatformName(config.vacuum_platform))
    )
        errors.push(["validation.preset.platform.invalid", "{0}", config.vacuum_platform]);
    validateList(config.icons, "icons", validateIconConfig).forEach(e => errors.push(e));
    validateList(config.tiles, "tiles", validateTileConfig).forEach(e => errors.push(e));
    validateConditions(config.conditions, "conditions").forEach(e => errors.push(e));
    if (![PlatformGenerator.SETUP_INTEGER_PLATFORM, PlatformGenerator.SETUP_DECIMAL_PLATFORM]
        .includes(PlatformGenerator.getPlatformName(config.vacuum_platform))) {
        validateList<MapModeConfig>(config.map_modes, "map_modes", mode =>
            validateMapModeConfig(vacuumPlatform, mode, language),
        ).forEach(e => errors.push(e));
    } else if (config.map_modes !== undefined && config.map_modes !== null && !Array.isArray(config.map_modes)) {
        errors.push(notList("map_modes"));
    }
    if (!config.preset_name && nameRequired) errors.push("validation.preset.preset_name.missing");
    return errors;
}

const MAP_VIEW_FIELDS = ["scale", "x", "y", "rotation"] as const;

/**
 * Validates the configured default map view (`map_view`).
 *
 * Every field is optional on purpose: a partial default keeps the neutral value for the fields it
 * leaves out, so `map_view: {scale: 2.5}` is a complete configuration and is not an error. A field
 * that is present must be a finite number, and `scale` must be inside the card's zoom range
 * (`MAP_VIEW_MIN_SCALE`..`MAP_VIEW_MAX_SCALE`): pinch-zoom refuses a scale outside it, which would
 * otherwise leave the card at the neutral view without ever saying why. The message names the
 * offending field so a typo in a four-key object does not need a bisect.
 */
export function validateMapViewConfig(mapView: MapViewConfig | undefined): TranslatableString[] {
    if (mapView === undefined) {
        return [];
    }
    if (!mapView || typeof mapView !== "object" || Array.isArray(mapView)) {
        return [["validation.map_view.invalid", "{0}", "map_view"]];
    }
    const fields = mapView as unknown as Record<string, unknown>;
    return MAP_VIEW_FIELDS.filter(field => {
        const value = fields[field];
        if (value === undefined) {
            return false;
        }
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return true;
        }
        return field === "scale" && (value < MAP_VIEW_MIN_SCALE || value > MAP_VIEW_MAX_SCALE);
    }).map(field => ["validation.map_view.invalid", "{0}", field] as TranslatableString);
}

const CARD_LAYOUTS: readonly string[] = ["vertical", "horizontal"];

/**
 * Validates the main `layout` option.
 *
 * An unknown value is reported instead of being silently treated as `vertical`: a typo such as
 * `horizonal` would otherwise look like the option was ignored and send the user back to card-mod.
 * The renderer still resolves anything that is not exactly `horizontal` to `vertical`, so a config
 * that bypassed validation cannot crash the card.
 */
export function validateLayout(layout: CardLayout | undefined): TranslatableString[] {
    if (layout === undefined || CARD_LAYOUTS.includes(layout)) {
        return [];
    }
    return [["validation.layout.invalid", "{0}", String(layout)]];
}

export function validateConfig(config: XiaomiVacuumMapCardConfig): string[] {
    if (!isMapping(config)) {
        return [localize(notMapping("config"))];
    }
    const errors: TranslatableString[] = [];
    const additionalPresets: unknown = config.additional_presets;
    const multiplePresets = Array.isArray(additionalPresets) && additionalPresets.length > 0;
    validatePreset(config, multiplePresets, config.language).forEach(e => errors.push(e));
    validateLayout(config.layout).forEach(e => errors.push(e));
    validateMapViewConfig(config.map_view).forEach(e => errors.push(e));
    validateList<CardPresetConfig>(additionalPresets, "additional_presets", preset =>
        validatePreset(preset, multiplePresets, config.language),
    ).forEach(e => errors.push(e));
    return errors.map(e => localize(e, config.language));
}

export function isOldConfig(config: XiaomiVacuumMapCardConfig): boolean {
    return Boolean(config.map_image || config.map_camera);
}

export function areAllEntitiesDefined(usedEntities: string[], hass: HomeAssistantFixed): string[] {
    const availableEntities = Object.keys(hass.states);
    return usedEntities.filter(e => !availableEntities.includes(e));
}
