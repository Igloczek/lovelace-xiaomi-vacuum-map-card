/**
 * Service-call contract matrix: every platform template × every map mode it offers, with room ids
 * as the camera metadata reports them (strings) and as a configuration usually has them (numbers).
 * Each case is built with the card's own `MapMode` code and checked against what the integration's
 * service accepts. The validators restate each integration's schema (voluptuous/probatio, or the
 * handler's own parsing for passthrough commands) with a source reference, so a template that
 * would be rejected, or silently misread, fails here.
 *
 * Shared by `test/service-call-contract.test.ts` (plain templates, no Home Assistant needed) and
 * `test/e2e/specs/service-call-contract.spec.ts` (every case, with `evaluate_data_as_template`
 * rendered by a real Home Assistant).
 */
import { MapMode } from "../../src/model/map_mode/map-mode";
import { SelectionType } from "../../src/model/map_mode/selection-type";
import { RepeatsType } from "../../src/model/map_mode/repeats-type";
import { PlatformGenerator } from "../../src/model/generators/platform-generator";
import type { ServiceCall } from "../../src/model/map_mode/service-call";
import type { HomeAssistantFixed } from "../../src/types/fixes";
import type { MapModeConfig, VariablesStorage } from "../../src/types/types";

// ---------------------------------------------------------------------------------------------
// A tiny validator vocabulary mirroring Home Assistant's (probatio, voluptuous-compatible).
// ---------------------------------------------------------------------------------------------

export type Validator = (value: unknown, path: string) => string[];

const ok: string[] = [];
const fail = (path: string, message: string, value: unknown): string[] => [
    `${path}: ${message} (got ${JSON.stringify(value)})`,
];

/** `vol.Coerce(int)`: numbers (floats truncate) and integer strings such as "13". */
export const coerceInt: Validator = (v, p) =>
    (typeof v === "number" && isFinite(v)) || (typeof v === "string" && /^\s*[-+]?\d+\s*$/.test(v))
        ? ok
        : fail(p, "expected a value vol.Coerce(int) accepts", v);

/** `vol.Coerce(float)`: numbers and numeric strings. */
export const coerceFloat: Validator = (v, p) =>
    (typeof v === "number" && isFinite(v)) || (typeof v === "string" && v.trim() !== "" && isFinite(+v))
        ? ok
        : fail(p, "expected a value vol.Coerce(float) accepts", v);

/** Plain `int` (probatio/voluptuous type check): no strings, no floats. */
export const strictInt: Validator = (v, p) =>
    typeof v === "number" && Number.isInteger(v) ? ok : fail(p, "expected an int", v);

/** A JSON number, for payloads a device parses with `typeof x === "number"`. */
export const jsonNumber: Validator = (v, p) =>
    typeof v === "number" && isFinite(v) ? ok : fail(p, "expected a JSON number", v);

/** `cv.string`: strings and numbers; lists, dicts and null are rejected. */
export const cvString: Validator = (v, p) =>
    typeof v === "string" || typeof v === "number" ? ok : fail(p, "expected a cv.string value", v);

/** `cv.boolean`. */
export const cvBoolean: Validator = (v, p) =>
    typeof v === "boolean" || ["true", "false", "on", "off", "yes", "no", "1", "0"].includes(String(v).toLowerCase())
        ? ok
        : fail(p, "expected a boolean", v);

/** `cv.entity_id(s)`. */
export const entityId: Validator = (v, p) =>
    typeof v === "string" && /^\w+\.\w+$/.test(v) ? ok : fail(p, "expected an entity id", v);

export const literal =
    (expected: unknown): Validator =>
    (v, p) =>
        v === expected ? ok : fail(p, `expected ${JSON.stringify(expected)}`, v);

export const oneOf =
    (...options: unknown[]): Validator =>
    (v, p) =>
        options.includes(v) ? ok : fail(p, `expected one of ${JSON.stringify(options)}`, v);

/** `vol.All(Coerce(int), Clamp(min, max))`: clamping never rejects, the value only has to coerce. */
export const clampedInt = coerceInt;

export const listOf =
    (item: Validator, options: { min?: number } = {}): Validator =>
    (v, p) => {
        if (!Array.isArray(v)) return fail(p, "expected a list", v);
        if (v.length < (options.min ?? 0)) return fail(p, `expected at least ${options.min} items`, v);
        return v.flatMap((x, i) => item(x, `${p}[${i}]`));
    };

/** `vol.ExactSequence([...])`. */
export const exactSequence =
    (...items: Validator[]): Validator =>
    (v, p) => {
        if (!Array.isArray(v) || v.length !== items.length)
            return fail(p, `expected exactly ${items.length} items`, v);
        return v.flatMap((x, i) => items[i](x, `${p}[${i}]`));
    };

export const anyOf =
    (...options: Validator[]): Validator =>
    (v, p) => {
        const results = options.map(o => o(v, p));
        return results.some(r => r.length === 0) ? ok : results[0];
    };

export const allOf =
    (...validators: Validator[]): Validator =>
    (v, p) =>
        validators.flatMap(validator => validator(v, p));

interface ObjectSchema {
    required?: Record<string, Validator>;
    optional?: Record<string, Validator>;
    /** `vol.Schema` default is PREVENT_EXTRA; `cv.make_entity_service_schema` too. */
    extra?: boolean;
}

export const object =
    (schema: ObjectSchema): Validator =>
    (v, p) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return fail(p, "expected a mapping", v);
        const record = v as Record<string, unknown>;
        const errors: string[] = [];
        for (const [key, validator] of Object.entries(schema.required ?? {})) {
            if (!(key in record)) errors.push(`${p}.${key}: required key not provided`);
            else errors.push(...validator(record[key], `${p}.${key}`));
        }
        for (const [key, validator] of Object.entries(schema.optional ?? {})) {
            if (key in record) errors.push(...validator(record[key], `${p}.${key}`));
        }
        if (!schema.extra) {
            const known = new Set([...Object.keys(schema.required ?? {}), ...Object.keys(schema.optional ?? {})]);
            for (const key of Object.keys(record)) if (!known.has(key)) errors.push(`${p}.${key}: extra keys not allowed`);
        }
        return errors;
    };

/** A JSON string whose parsed value satisfies `inner` (MQTT payloads). */
export const jsonString =
    (inner: Validator): Validator =>
    (v, p) => {
        if (typeof v !== "string") return fail(p, "expected a JSON string", v);
        let parsed: unknown;
        try {
            parsed = JSON.parse(v);
        } catch (e) {
            return fail(p, `invalid JSON: ${(e as Error).message}`, v);
        }
        return inner(parsed, `${p}<json>`);
    };

/** The target fields `cv.make_entity_service_schema` adds. */
const ENTITY_SERVICE_TARGET = {
    entity_id: entityId,
    device_id: cvString,
    area_id: cvString,
    floor_id: cvString,
    label_id: cvString,
};

/** `cv.make_entity_service_schema(schema)`: extra keys rejected, target fields allowed. */
const entityService = (required: Record<string, Validator>, optional: Record<string, Validator> = {}): Validator =>
    object({ required, optional: { ...ENTITY_SERVICE_TARGET, ...optional } });

/** A legacy `vol.Schema({...})` service that only adds `entity_id`. */
const plainService = (required: Record<string, Validator>, optional: Record<string, Validator> = {}): Validator =>
    object({ required, optional: { entity_id: entityId, ...optional } });

/** Core `vacuum.send_command`: `command` string and `params` dict or list, then the integration's own check. */
const sendCommand = (command: string, params: Validator): Validator =>
    entityService({ command: literal(command) }, { params });

const zone4 = (coord: Validator): Validator => exactSequence(coord, coord, coord, coord);
const point2 = (coord: Validator): Validator => exactSequence(coord, coord);

// ---------------------------------------------------------------------------------------------
// Service contracts, keyed by platform and mode template.
// ---------------------------------------------------------------------------------------------

export interface ServiceContract {
    service: string;
    data: Validator;
    /** Where the schema comes from. */
    source: string;
}

/**
 * Templates the card cannot complete by itself. They are listed rather than validated, and the
 * documentation says what the user has to add.
 */
export const USER_CONFIGURED: Record<string, string> = {
    "al-one/hass-xiaomi-miot":
        "xiaomi_miot.call_action needs per-model siid/aiid/params; docs/templates/alOneHassXiaomiMiot.md asks for a full service_call_schema",
    "default": "the `new.json` scaffold for contributors has no services",
};

const XIAOMI_MIIO = "home-assistant/core homeassistant/components/xiaomi_miio/services.py";
const HUMBERTO = "humbertogontijo/homeassistant-roborock custom_components/roborock/vacuum.py L133-178";
const DREAME = "Tasshack/dreame-vacuum custom_components/dreame_vacuum/vacuum.py L203-294";
const MIIO2 = "KrzysztofHajdamowicz/home-assistant-vacuum-styj02ym custom_components/miio2/vacuum.py L54-124";
const VIOMI_V8 = "tykarol/home-assistant-viomi-vacuum-v8 custom_components/viomi_vacuum_v8/vacuum.py L45-133";
const VIOMISE = "marotoweb/home-assistant-vacuum-viomise custom_components/viomise/vacuum.py L66-172, L324-345";
const ECOVACS = "home-assistant/core ecovacs/vacuum.py L375-405; deebot-client commands/json/clean.py `\",\".join(str(i) for i in area)`";
const VALETUDO = "Hypfer/Valetudo backend/lib/mqtt/capabilities/*MqttHandle.js";
const VALETUDO_RE = "rand256/valetudo lib/MqttClient.js L570-720 (a string segment id is looked up as a room name)";
const MQTT = "home-assistant/core mqtt/services.py L46-63 (payload Any(cv.string, None))";
const PERSISTENT = "home-assistant/core persistent_notification/services.py L70-87";

const mqttPublish = (payload: Validator): Validator =>
    object({ required: { topic: cvString, payload }, optional: { qos: coerceInt, retain: cvBoolean } });

export const CONTRACTS: Record<string, Record<string, ServiceContract>> = {
    "Xiaomi Miio": {
        vacuum_clean_segment: {
            service: "xiaomi_miio.vacuum_clean_segment",
            data: entityService({ segments: anyOf(coerceInt, listOf(coerceInt, { min: 1 })) }),
            source: XIAOMI_MIIO,
        },
        vacuum_clean_zone: {
            service: "xiaomi_miio.vacuum_clean_zone",
            data: entityService({ zone: listOf(zone4(coerceInt), { min: 1 }), repeats: clampedInt }),
            source: XIAOMI_MIIO,
        },
        vacuum_clean_zone_predefined: {
            service: "xiaomi_miio.vacuum_clean_zone",
            data: entityService({ zone: listOf(zone4(coerceInt), { min: 1 }), repeats: clampedInt }),
            source: XIAOMI_MIIO,
        },
        vacuum_goto: {
            service: "xiaomi_miio.vacuum_goto",
            data: entityService({ x_coord: coerceInt, y_coord: coerceInt }),
            source: XIAOMI_MIIO,
        },
        vacuum_goto_predefined: {
            service: "xiaomi_miio.vacuum_goto",
            data: entityService({ x_coord: coerceInt, y_coord: coerceInt }),
            source: XIAOMI_MIIO,
        },
        vacuum_follow_path: followPath("xiaomi_miio.vacuum_goto"),
    },
    "Roborock": {
        // Core roborock passes `params` unchanged to the device (python-roborock v1_protocol), which
        // expects integer segment ids: a string id would reach the firmware as a string.
        vacuum_clean_segment: {
            service: "vacuum.send_command",
            data: sendCommand(
                "app_segment_clean",
                exactSequence(object({ required: { segments: listOf(strictInt, { min: 1 }), repeat: strictInt } })),
            ),
            source: "home-assistant/core roborock/vacuum.py L336-343; python-roborock protocols/v1_protocol.py",
        },
        vacuum_clean_zone: {
            service: "vacuum.send_command",
            data: sendCommand("app_zoned_clean", listOf(exactSequence(strictInt, strictInt, strictInt, strictInt, strictInt), { min: 1 })),
            source: "home-assistant/core roborock/vacuum.py; zones carry repeats as the fifth value",
        },
        vacuum_clean_zone_predefined: {
            service: "vacuum.send_command",
            data: sendCommand("app_zoned_clean", listOf(exactSequence(strictInt, strictInt, strictInt, strictInt, strictInt), { min: 1 })),
            source: "home-assistant/core roborock/vacuum.py",
        },
        vacuum_goto: {
            service: "roborock.set_vacuum_goto_position",
            data: entityService({ x: coerceInt, y: coerceInt }),
            source: "home-assistant/core roborock/services.py L59-71",
        },
        vacuum_goto_predefined: {
            service: "roborock.set_vacuum_goto_position",
            data: entityService({ x: coerceInt, y: coerceInt }),
            source: "home-assistant/core roborock/services.py L59-71",
        },
        vacuum_follow_path: followPath("roborock.set_vacuum_goto_position"),
    },
    "humbertogontijo/homeassistant-roborock": {
        vacuum_clean_segment: {
            service: "roborock.vacuum_clean_segment",
            data: entityService(
                { segments: anyOf(coerceInt, listOf(coerceInt, { min: 1 }), cvString) },
                { repeats: clampedInt },
            ),
            source: HUMBERTO,
        },
        vacuum_clean_zone: {
            service: "roborock.vacuum_clean_zone",
            data: entityService({ zone: listOf(zone4(coerceInt), { min: 1 }) }, { repeats: clampedInt }),
            source: HUMBERTO,
        },
        vacuum_clean_zone_predefined: {
            service: "roborock.vacuum_clean_zone",
            data: entityService({ zone: listOf(zone4(coerceInt), { min: 1 }) }, { repeats: clampedInt }),
            source: HUMBERTO,
        },
        vacuum_goto: {
            service: "roborock.vacuum_goto",
            data: entityService({ x_coord: coerceInt, y_coord: coerceInt }),
            source: HUMBERTO,
        },
        vacuum_goto_predefined: {
            service: "roborock.vacuum_goto",
            data: entityService({ x_coord: coerceInt, y_coord: coerceInt }),
            source: HUMBERTO,
        },
        vacuum_follow_path: followPath("roborock.vacuum_goto"),
    },
    "Tasshack/dreame-vacuum": {
        vacuum_clean_segment: {
            service: "dreame_vacuum.vacuum_clean_segment",
            data: entityService(
                { segments: anyOf(coerceInt, listOf(coerceInt, { min: 1 })) },
                { repeats: anyOf(coerceInt, listOf(coerceInt)) },
            ),
            source: DREAME,
        },
        vacuum_clean_zone: {
            service: "dreame_vacuum.vacuum_clean_zone",
            data: entityService(
                { zone: anyOf(listOf(zone4(coerceInt), { min: 1 }), zone4(coerceInt)) },
                { repeats: anyOf(coerceInt, listOf(coerceInt)) },
            ),
            source: DREAME,
        },
        vacuum_clean_zone_predefined: {
            service: "dreame_vacuum.vacuum_clean_zone",
            data: entityService(
                { zone: anyOf(listOf(zone4(coerceInt), { min: 1 }), zone4(coerceInt)) },
                { repeats: anyOf(coerceInt, listOf(coerceInt)) },
            ),
            source: DREAME,
        },
        vacuum_clean_point: {
            service: "dreame_vacuum.vacuum_clean_spot",
            data: entityService(
                { points: anyOf(listOf(point2(coerceInt), { min: 1 }), point2(coerceInt)) },
                { repeats: anyOf(coerceInt, listOf(coerceInt)) },
            ),
            source: DREAME,
        },
        vacuum_clean_point_predefined: {
            service: "dreame_vacuum.vacuum_clean_spot",
            data: entityService(
                { points: anyOf(listOf(point2(coerceInt), { min: 1 }), point2(coerceInt)) },
                { repeats: anyOf(coerceInt, listOf(coerceInt)) },
            ),
            source: DREAME,
        },
        vacuum_goto: {
            service: "dreame_vacuum.vacuum_goto",
            data: entityService({ x: coerceInt, y: coerceInt }),
            source: DREAME,
        },
        vacuum_goto_predefined: {
            service: "dreame_vacuum.vacuum_goto",
            data: entityService({ x: coerceInt, y: coerceInt }),
            source: DREAME,
        },
        vacuum_follow_path: {
            service: "dreame_vacuum.vacuum_follow_path",
            data: entityService({}, { points: listOf(point2(coerceInt)) }),
            source: DREAME,
        },
    },
    "KrzysztofHajdamowicz/miio2": {
        vacuum_clean_segment: {
            service: "vacuum.vacuum_clean_segment",
            data: plainService({ segments: anyOf(coerceInt, listOf(coerceInt, { min: 1 })) }),
            source: MIIO2,
        },
        vacuum_clean_zone: {
            service: "vacuum.vacuum_clean_zone",
            data: plainService({ zone: listOf(zone4(coerceFloat), { min: 1 }), repeats: clampedInt }),
            source: MIIO2,
        },
        vacuum_clean_zone_predefined: {
            service: "vacuum.vacuum_clean_zone",
            data: plainService({ zone: listOf(zone4(coerceFloat), { min: 1 }), repeats: clampedInt }),
            source: MIIO2,
        },
        vacuum_goto: {
            service: "vacuum.vacuum_goto",
            data: plainService({ x_coord: coerceFloat, y_coord: coerceFloat }),
            source: MIIO2,
        },
        vacuum_goto_predefined: {
            service: "vacuum.vacuum_goto",
            data: plainService({ x_coord: coerceFloat, y_coord: coerceFloat }),
            source: MIIO2,
        },
        vacuum_follow_path: followPath("vacuum.vacuum_goto"),
    },
    "tykarol/viomi-vacuum-v8": {
        vacuum_clean_segment: {
            service: "viomi_vacuum_v8.clean_segment",
            data: plainService({ segments: anyOf(coerceInt, listOf(coerceInt, { min: 1 })) }),
            source: VIOMI_V8,
        },
        vacuum_clean_zone: {
            service: "viomi_vacuum_v8.clean_zone",
            data: plainService({ zone: listOf(zone4(coerceFloat), { min: 1 }), repeats: clampedInt }),
            source: VIOMI_V8,
        },
        vacuum_clean_zone_predefined: {
            service: "viomi_vacuum_v8.clean_zone",
            data: plainService({ zone: listOf(zone4(coerceFloat), { min: 1 }), repeats: clampedInt }),
            source: VIOMI_V8,
        },
        vacuum_clean_point: {
            service: "viomi_vacuum_v8.clean_point",
            data: plainService({ point: point2(coerceFloat) }),
            source: VIOMI_V8,
        },
        vacuum_clean_point_predefined: {
            service: "viomi_vacuum_v8.clean_point",
            data: plainService({ point: point2(coerceFloat) }),
            source: VIOMI_V8,
        },
    },
    "marotoweb/viomise": {
        vacuum_clean_zone: {
            service: "vacuum.xiaomi_clean_zone",
            data: plainService({ zone: listOf(zone4(coerceFloat), { min: 1 }) }, { repeats: clampedInt }),
            source: VIOMISE,
        },
        vacuum_clean_zone_predefined: {
            service: "vacuum.xiaomi_clean_zone",
            data: plainService({ zone: listOf(zone4(coerceFloat), { min: 1 }) }, { repeats: clampedInt }),
            source: VIOMISE,
        },
        vacuum_clean_point: {
            service: "vacuum.xiaomi_clean_point",
            data: plainService({ point: point2(coerceFloat) }),
            source: VIOMISE,
        },
        vacuum_clean_point_predefined: {
            service: "vacuum.xiaomi_clean_point",
            data: plainService({ point: point2(coerceFloat) }),
            source: VIOMISE,
        },
        // `send_command` passes params raw to the device: [action_mode, 1 (start), count, *room_ids].
        vacuum_clean_segment: {
            service: "vacuum.send_command",
            data: sendCommand("set_mode_withroom", (v, p) => {
                if (!Array.isArray(v) || v.length < 4) return fail(p, "expected [mode, 1, count, ...ids]", v);
                const [, op, count, ...ids] = v;
                return [
                    ...strictInt(op, `${p}[1]`),
                    ...strictInt(count, `${p}[2]`),
                    ...(count === ids.length ? ok : fail(`${p}[2]`, `count must equal the ${ids.length} ids`, count)),
                    ...ids.flatMap((id, i) => strictInt(id, `${p}[${i + 3}]`)),
                ];
            }),
            source: VIOMISE,
        },
    },
    "DeebotUniverse/Deebot-4-Home-Assistant": {
        // Core ecovacs (the integration Deebot-4-Home-Assistant became) joins the list it is given:
        // a "13,14" string becomes "1,3,,,1,4".
        vacuum_clean_segment: {
            service: "vacuum.send_command",
            data: sendCommand(
                "spot_area",
                object({ required: { rooms: listOf(strictInt, { min: 1 }) }, optional: { cleanings: strictInt } }),
            ),
            source: ECOVACS,
        },
        vacuum_clean_zone: {
            service: "vacuum.send_command",
            data: sendCommand(
                "custom_area",
                object({ required: { coordinates: listOf(jsonNumber, { min: 4 }) }, optional: { cleanings: strictInt } }),
            ),
            source: ECOVACS,
        },
        vacuum_clean_zone_predefined: {
            service: "vacuum.send_command",
            data: sendCommand(
                "custom_area",
                object({ required: { coordinates: listOf(jsonNumber, { min: 4 }) }, optional: { cleanings: strictInt } }),
            ),
            source: ECOVACS,
        },
    },
    "Hypfer/Valetudo": {
        vacuum_clean_segment: {
            service: "mqtt.publish",
            data: mqttPublish(
                jsonString(
                    object({
                        required: { segment_ids: listOf(anyOf(cvString), { min: 1 }), iterations: jsonNumber },
                        optional: { customOrder: literal(true) },
                    }),
                ),
            ),
            source: `${VALETUDO} MapSegmentationCapabilityMqttHandle.js L28-58 (iterations ignored unless a number)`,
        },
        vacuum_clean_zone: valetudoZone(),
        vacuum_clean_zone_predefined: valetudoZone(),
        vacuum_goto: valetudoGoto(),
        vacuum_goto_predefined: valetudoGoto(),
    },
    "rand256/ValetudoRE": {
        vacuum_clean_segment: {
            service: "mqtt.publish",
            data: mqttPublish(
                jsonString(
                    object({
                        required: {
                            command: literal("segmented_cleanup"),
                            segment_ids: listOf(jsonNumber, { min: 1 }),
                            repeats: jsonNumber,
                            afterCleaning: cvString,
                        },
                    }),
                ),
            ),
            source: VALETUDO_RE,
        },
        vacuum_clean_zone: {
            service: "mqtt.publish",
            data: mqttPublish(
                jsonString(
                    object({
                        required: {
                            command: literal("zoned_cleanup"),
                            zone_coordinates: listOf(
                                object({ required: { x1: jsonNumber, y1: jsonNumber, x2: jsonNumber, y2: jsonNumber, repeats: jsonNumber } }),
                                { min: 1 },
                            ),
                            afterCleaning: cvString,
                        },
                    }),
                ),
            ),
            source: VALETUDO_RE,
        },
        // Zone ids are the names of zones saved in Valetudo RE.
        vacuum_clean_zone_predefined: {
            service: "mqtt.publish",
            data: mqttPublish(
                jsonString(
                    object({
                        required: {
                            command: literal("zoned_cleanup"),
                            zone_ids: listOf(object({ required: { id: cvString, repeats: jsonNumber } }), { min: 1 }),
                            afterCleaning: cvString,
                        },
                    }),
                ),
            ),
            source: VALETUDO_RE,
        },
        vacuum_goto: {
            service: "mqtt.publish",
            data: mqttPublish(
                jsonString(
                    object({
                        required: {
                            command: literal("go_to"),
                            spot_coordinates: object({ required: { x: jsonNumber, y: jsonNumber } }),
                        },
                    }),
                ),
            ),
            source: VALETUDO_RE,
        },
        vacuum_goto_predefined: {
            service: "mqtt.publish",
            data: mqttPublish(
                jsonString(object({ required: { command: literal("go_to"), spot_id: cvString } })),
            ),
            source: VALETUDO_RE,
        },
    },
    "send_command": {
        vacuum_clean_segment: {
            service: "vacuum.send_command",
            data: sendCommand("app_segment_clean", listOf(strictInt, { min: 1 })),
            source: "home-assistant/core xiaomi_miio send_command: params passed to the device unchanged",
        },
        vacuum_clean_zone: {
            service: "vacuum.send_command",
            data: sendCommand("app_zoned_clean", listOf(exactSequence(strictInt, strictInt, strictInt, strictInt, strictInt))),
            source: "miio app_zoned_clean: [[x1, y1, x2, y2, repeats], ...]",
        },
        vacuum_clean_zone_predefined: {
            service: "vacuum.send_command",
            data: sendCommand("app_zoned_clean", listOf(exactSequence(strictInt, strictInt, strictInt, strictInt, strictInt))),
            source: "miio app_zoned_clean",
        },
        vacuum_goto: {
            service: "vacuum.send_command",
            data: sendCommand("app_goto_target", exactSequence(strictInt, strictInt)),
            source: "miio app_goto_target: [x, y]",
        },
        vacuum_goto_predefined: {
            service: "vacuum.send_command",
            data: sendCommand("app_goto_target", exactSequence(strictInt, strictInt)),
            source: "miio app_goto_target: [x, y]",
        },
        vacuum_follow_path: followPath("vacuum.send_command"),
    },
    "Neato": {
        vacuum_clean_segment: {
            service: "neato.custom_cleaning",
            data: entityService({}, { zone: cvString, mode: coerceInt, navigation: coerceInt, category: coerceInt }),
            source: "home-assistant/core neato/services.py L33-50 (zone is a boundary name)",
        },
    },
    "BenjaminPaap/home-assistant-myneato": {
        vacuum_clean_segment: {
            service: "myneato.custom_cleaning",
            data: entityService({}, { zone: cvString, mode: oneOf("eco", "max", "turbo", "auto") }),
            source: "BenjaminPaap/home-assistant-myneato vacuum.py L89-96, L385-420",
        },
    },
    "CoderAS-ru/hass-neatsvor": {
        vacuum_clean_zone: {
            service: "neatsvor.vacuum_clean_zone",
            data: object({
                required: { entity_id: entityId, zones: listOf(anyOf(zone4(jsonNumber), exactSequence(jsonNumber, jsonNumber, jsonNumber, jsonNumber, jsonNumber)), { min: 1 }) },
                extra: true,
            }),
            source: "CoderAS-ru/hass-neatsvor __init__.py L472-511 (no schema; numbers required)",
        },
    },
    "Roomba": {
        vacuum_clean_segment: {
            service: "vacuum.send_command",
            data: sendCommand(
                "start",
                object({
                    required: {
                        pmap_id: cvString,
                        regions: listOf(
                            object({
                                required: {
                                    region_id: cvString,
                                    type: oneOf("rid", "zid"),
                                    params: object({ required: { noAutoPasses: literal(true), twoPass: cvBoolean } }),
                                },
                            }),
                            { min: 1 },
                        ),
                    },
                }),
            ),
            source: "home-assistant/core roomba/vacuum.py L251-275; roombapy roomba.py (params merged into the command)",
        },
    },
    "johnnyh1975/ha_roomba_plus": {
        vacuum_clean_segment: {
            service: "roomba_plus.clean_room",
            data: plainService(
                { entity_id: entityId, room_name: anyOf(cvString, listOf(cvString, { min: 1 })) },
                { ordered: cvBoolean, two_pass: cvBoolean },
            ),
            source: "johnnyh1975/ha_roomba_plus services.py L2041-2124 (names, then region ids)",
        },
        vacuum_clean_segment_two_pass: {
            service: "roomba_plus.clean_room",
            data: plainService(
                { entity_id: entityId, room_name: anyOf(cvString, listOf(cvString, { min: 1 })) },
                { ordered: cvBoolean, two_pass: cvBoolean },
            ),
            source: "johnnyh1975/ha_roomba_plus services.py L2041-2124",
        },
        vacuum_clean_segment_with_blocking: {
            service: "roomba_plus.smart_start",
            data: plainService({ entity_id: entityId, rooms: listOf(cvString, { min: 1 }) }),
            source: "johnnyh1975/ha_roomba_plus services.py L2180-2190",
        },
    },
    "romedtino/simple-wyze-vac": {
        vacuum_clean_segment: {
            service: "vacuum.send_command",
            data: sendCommand("sweep_rooms", object({ required: { rooms: listOf(cvString, { min: 1 }) } })),
            source: "romedtino/simple-wyze-vac vacuum.py L277-295 (rooms are matched by name)",
        },
    },
    "Setup integer": setupContracts(),
    "Setup decimal": setupContracts(),
};

function followPath(service: string): ServiceContract {
    // `script.vacuum_follow_path` is the script from docs/follow_path.yaml, which takes these fields.
    return {
        service: "script.vacuum_follow_path",
        data: object({
            required: {
                entity_id: entityId,
                service: literal(service),
                mode: oneOf("individual", "send_command"),
                path: listOf(point2(jsonNumber), { min: 1 }),
            },
        }),
        source: "docs/follow_path.yaml",
    };
}

function valetudoZone(): ServiceContract {
    const point = object({ required: { x: jsonNumber, y: jsonNumber } });
    return {
        service: "mqtt.publish",
        data: mqttPublish(
            jsonString(
                object({
                    required: {
                        zones: listOf(object({ required: { points: object({ required: { pA: point, pB: point, pC: point, pD: point } }) } }), { min: 1 }),
                        iterations: jsonNumber,
                    },
                }),
            ),
        ),
        source: `${VALETUDO} ZoneCleaningCapabilityMqttHandle.js L27-63, ValetudoZone.js L29-48`,
    };
}

function valetudoGoto(): ServiceContract {
    return {
        service: "mqtt.publish",
        data: mqttPublish(
            jsonString(object({ required: { coordinates: object({ required: { x: jsonNumber, y: jsonNumber } }) } })),
        ),
        source: `${VALETUDO} GoToLocationCapabilityMqttHandle.js L27-44 (x and y must be numbers)`,
    };
}

function setupContracts(): Record<string, ServiceContract> {
    const create: ServiceContract = {
        service: "persistent_notification.create",
        data: object({ required: { message: cvString }, optional: { title: cvString, notification_id: cvString } }),
        source: PERSISTENT,
    };
    return { setup_zone: create, setup_point: create, setup_outline: create };
}

// ---------------------------------------------------------------------------------------------
// Cases.
// ---------------------------------------------------------------------------------------------

export const ENTITY_ID = "vacuum.contract_test";

/** Variables the platform docs tell the user to define, so a case is what a working setup sends. */
const DOCUMENTED_VARIABLES: Record<string, VariablesStorage> = {
    "Hypfer/Valetudo": { topic: "valetudo/robot" },
    "rand256/ValetudoRE": { topic: "valetudo/rockrobo" },
    "Roomba": { pmap_id: "abc123def456" },
};

/** Per-room variables the docs ask for (Roomba: the region `type`). */
const DOCUMENTED_ROOM_VARIABLES: Record<string, VariablesStorage> = {
    "Roomba": { type: "rid" },
};

export type IdVariant = "metadata-string-ids" | "configured-number-ids";

export interface ContractCase {
    platform: string;
    template: string;
    /** `id_type` forced by the case, or `undefined` for the template's own. */
    idType: "number" | "string" | undefined;
    ids: IdVariant | undefined;
    mode: MapMode;
    selection: unknown[];
    repeats: number;
    variables: VariablesStorage;
    contract: ServiceContract | undefined;
    templated: boolean;
    name: string;
}

const ZONES = [
    [25500, 25500, 26500, 26500],
    [27000, 25000, 28500, 26000],
];
const POINT = [25500, 25000];
const PATH = [
    [25500, 25000],
    [26000, 25500],
];

function variablesFor(platform: string, mode: MapMode, roomCount: number): VariablesStorage {
    const platformVariables = PlatformGenerator.getVariables(platform) ?? {};
    const roomVariables = DOCUMENTED_ROOM_VARIABLES[platform] ?? {};
    const perSelection = mode.selectionType === SelectionType.ROOM ? roomCount : 1;
    const variables: VariablesStorage = {
        ...platformVariables,
        ...(DOCUMENTED_VARIABLES[platform] ?? {}),
        ...roomVariables,
        variables: Array(perSelection).fill(roomVariables),
    };
    return variables;
}

function selectionFor(mode: MapMode, ids: IdVariant | undefined, repeats: number): unknown[] {
    const internal = mode.repeatsType === RepeatsType.INTERNAL ? repeats : null;
    const withRepeats = (item: number[]): number[] => (internal === null ? item : [...item, internal]);
    switch (mode.selectionType) {
        case SelectionType.ROOM: {
            const roomIds = ids === "configured-number-ids" ? [16, 17] : ["16", "17"];
            return mode.getRoomSelection(roomIds.slice(0, Math.min(2, mode.maxSelections)), repeats);
        }
        case SelectionType.MANUAL_RECTANGLE:
        case SelectionType.PREDEFINED_RECTANGLE:
            return mode.repeatSelection(ZONES.slice(0, Math.min(2, mode.maxSelections)).map(withRepeats), repeats);
        case SelectionType.MANUAL_POINT:
        case SelectionType.PREDEFINED_POINT:
            return mode.repeatSelection(withRepeats(POINT), repeats);
        case SelectionType.MANUAL_PATH:
            return mode.repeatSelection(PATH.map(withRepeats), repeats);
    }
    return [];
}

export function contractCases(): ContractCase[] {
    const cases: ContractCase[] = [];
    for (const platform of PlatformGenerator.getPlatforms()) {
        for (const template of PlatformGenerator.getModeTemplateNames(platform)) {
            const base = new MapMode(platform, { template } as MapModeConfig, "en");
            const isRoom = base.selectionType === SelectionType.ROOM;
            const idTypes: Array<"number" | "string" | undefined> = isRoom ? [undefined, "number", "string"] : [undefined];
            const idVariants: Array<IdVariant | undefined> = isRoom
                ? ["metadata-string-ids", "configured-number-ids"]
                : [undefined];
            for (const idType of idTypes) {
                for (const ids of idVariants) {
                    const config = { template, ...(idType ? { id_type: idType } : {}) } as MapModeConfig;
                    const mode = new MapMode(platform, config, "en");
                    const repeats = Math.min(2, mode.maxRepeats);
                    const selection = selectionFor(mode, ids, repeats);
                    const roomCount = isRoom ? selection.filter(s => typeof s === "string" || typeof s === "number").length : 1;
                    cases.push({
                        platform,
                        template,
                        idType,
                        ids,
                        mode,
                        selection,
                        repeats,
                        variables: variablesFor(platform, mode, roomCount),
                        contract: CONTRACTS[platform]?.[template],
                        templated: mode.serviceCallSchema.evaluateDataAsTemplate,
                        name: [platform, template, idType ? `id_type=${idType}` : "", ids ?? ""].filter(Boolean).join(" · "),
                    });
                }
            }
        }
    }
    return cases;
}

/**
 * `id_type` forced on a template whose integration needs a different id type is a configuration
 * error, not a template bug: only the template's own `id_type`, and overrides that agree with the
 * integration, are held to the contract.
 */
export function isExpectedToPass(testCase: ContractCase): boolean {
    if (testCase.idType === undefined) return true;
    const own = new MapMode(testCase.platform, { template: testCase.template } as MapModeConfig, "en").idType;
    return testCase.idType === own;
}

export async function buildServiceCall(testCase: ContractCase, hass: HomeAssistantFixed): Promise<ServiceCall> {
    return testCase.mode.getServiceCall(hass, ENTITY_ID, testCase.selection, testCase.repeats, testCase.variables);
}

/** Errors of a built call against its contract: wrong service, or data the integration rejects. */
export function checkContract(testCase: ContractCase, call: ServiceCall): string[] {
    const contract = testCase.contract;
    if (!contract) return [`no contract for ${testCase.platform} / ${testCase.template}`];
    const errors: string[] = [];
    const service = `${call.domain}.${call.service}`;
    if (service !== contract.service) errors.push(`service: expected ${contract.service}, got ${service}`);
    // Home Assistant merges `target` into the service data before validating it.
    const data = { ...(call.serviceData ?? {}), ...(call.target ?? {}) };
    errors.push(...contract.data(data, "data"));
    return errors;
}
