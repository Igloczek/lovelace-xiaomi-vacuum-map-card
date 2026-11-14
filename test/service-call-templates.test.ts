import { describe, expect, it } from "vitest";

import { MapMode } from "../src/model/map_mode/map-mode";
import { ServiceCallSchema } from "../src/model/map_mode/service-call-schema";
import type { HomeAssistantFixed } from "../src/types/fixes";
import type { MapModeConfig } from "../src/types/types";
import { normalizeJinjaQuotes } from "../src/utils";

/**
 * The service data is sent to Home Assistant's `render_template` as one JSON document. These cases
 * were rendered by Home Assistant 2026.11 (see `test/e2e/specs/service-call-contract.spec.ts`):
 * `{{ [\"13\"] | length }}` is a syntax error, `'[\"13\"]'|from_json` renders, and the 1.0.2
 * rewrite of `\"` to `'` turned the second one into `'['13']'`, also a syntax error.
 */
describe("normalizeJinjaQuotes", () => {
    it("turns a JSON-escaped list inside {{ }} into Jinja code", () => {
        expect(normalizeJinjaQuotes(JSON.stringify({ a: '{{ ["13"] | length }}' }))).toBe('{"a":"{{ ["13"] | length }}"}');
    });

    it("keeps a list inside a single-quoted Jinja string (roomba, Valetudo RE)", () => {
        const template = JSON.stringify({ regions: "{%set s='[\"13\",\"14\"]'|from_json%}{{ s | length }}" });
        expect(normalizeJinjaQuotes(template)).toBe('{"regions":"{%set s=\'["13","14"]\'|from_json%}{{ s | length }}"}');
    });

    it("leaves text outside the Jinja delimiters untouched", () => {
        const template = JSON.stringify({ payload: '{"segment_ids": ["13"], "after": "{{ \'Base\' }}"}' });
        expect(normalizeJinjaQuotes(template)).toBe(
            '{"payload":"{\\"segment_ids\\": [\\"13\\"], \\"after\\": \\"{{ \'Base\' }}\\"}"}',
        );
    });

    it("unescapes a double-quoted Jinja string containing an apostrophe", () => {
        expect(normalizeJinjaQuotes(JSON.stringify({ a: "{{ \"it's\" }}" }))).toBe('{"a":"{{ "it\'s" }}"}');
    });
});


const ENTITY = "vacuum.test";
const noRender = {} as HomeAssistantFixed;

function mode(config: Partial<MapModeConfig>): MapMode {
    return new MapMode("Xiaomi Miio", { name: "m", icon: "mdi:x", ...config } as MapModeConfig, "en");
}

function fill(
    data: Record<string, unknown>,
    selection: unknown[],
    repeats = 1,
    variables = {},
    pointSelection?: boolean,
): Record<string, unknown> {
    return new ServiceCallSchema({ service: "a.b", service_data: data }).apply(ENTITY, selection, repeats, variables, pointSelection)
        .serviceData as Record<string, unknown>;
}

describe("placeholders", () => {
    it("keep string room ids as strings and unwrap them without quotes", () => {
        expect(
            fill(
                {
                    whole: "[[selection]]",
                    inline: "ids=[[selection]]",
                    unwrapped: "[[selection_unwrapped]]",
                    size: "[[selection_size]]",
                    entity: "[[entity_id]]",
                },
                ["13", "14"],
            ),
        ).toEqual({ whole: ["13", "14"], inline: 'ids=["13","14"]', unwrapped: "13,14", size: 2, entity: ENTITY });
        expect(fill({ unwrapped: "[[selection_unwrapped]]" }, [13, 14])).toEqual({ unwrapped: "13,14" });
    });

    it("give an empty selection an empty list, an empty unwrapped string and size 0", () => {
        expect(
            fill({ whole: "[[selection]]", unwrapped: "[[selection_unwrapped]]", size: "[[selection_size]]", x: "[[point_x]]" }, []),
        ).toEqual({ whole: [], unwrapped: "", size: 0, x: "" });
    });

    it("pass the repeats as a number", () => {
        expect(fill({ repeats: "[[repeats]]", text: "x[[repeats]]" }, [1], 3)).toEqual({ repeats: 3, text: "x3" });
    });

    it("give point_x and point_y for a point, also when the repeats are inside it", () => {
        expect(fill({ x: "[[point_x]]", y: "[[point_y]]" }, [25500, 25000])).toEqual({ x: 25500, y: 25000 });
        expect(fill({ x: "[[point_x]]", y: "[[point_y]]" }, [25500, 25000, 2], 1, {}, true)).toEqual({ x: 25500, y: 25000 });
        expect(fill({ x: "[[point_x]]", y: "[[point_y]]" }, [25500, 25000, 2], 1, {}, false)).toEqual({ x: "", y: "" });
        expect(fill({ x: "[[point_x]]" }, [[25500, 25000]])).toEqual({ x: "" });
    });

    it("decode |[[jsonify]] and pass variables through", () => {
        expect(
            fill({ ids: "[ [[selection_unwrapped]] ]|[[jsonify]]", topic: "[[topic]]/set", list: "[[variables]]" }, ["13", "14"], 1, {
                topic: "valetudo/robot",
                variables: [{ type: "rid" }, { type: "zid" }],
            }),
        ).toEqual({ ids: [13, 14], topic: "valetudo/robot/set", list: [{ type: "rid" }, { type: "zid" }] });
    });

    it("reject a |[[jsonify]] value that is not JSON instead of throwing out of the run", async () => {
        const m = mode({
            selection_type: "ROOM",
            service_call_schema: { service: "a.b", service_data: { ids: "[ [[selection_unwrapped]] ]|[[jsonify]]" } },
        });
        await expect(m.getServiceCall(noRender, ENTITY, ["kitchen"], 1, {})).rejects.toThrow();
    });
});

describe("room selection and repeats types", () => {
    const ids = ["13", "14"];
    it.each([
        ["NONE", undefined, ["13", "14"]],
        ["NONE", "number", [13, 14]],
        ["NONE", "string", ["13", "14"]],
        ["INTERNAL", "number", [13, 14, 2]],
        ["EXTERNAL", "number", [13, 14]],
        ["REPEAT", "number", [13, 14, 13, 14]],
    ] as const)("%s repeats with id_type %s", (repeatsType, idType, expected) => {
        const m = mode({ selection_type: "ROOM", repeats_type: repeatsType, id_type: idType });
        expect(m.getRoomSelection(ids, 2)).toEqual(expected);
    });

    it("turns configured numbers into strings for id_type string and keeps names as they are for number", () => {
        expect(mode({ selection_type: "ROOM", id_type: "string" }).getRoomSelection([13, 14], 1)).toEqual(["13", "14"]);
        expect(mode({ selection_type: "ROOM", id_type: "number" }).getRoomSelection(["kitchen", " ", 7], 1)).toEqual([
            "kitchen",
            " ",
            7,
        ]);
    });

    it("sends nothing extra for an empty room selection", () => {
        expect(mode({ selection_type: "ROOM", repeats_type: "INTERNAL" }).getRoomSelection([], 2)).toEqual([]);
        expect(mode({ selection_type: "ROOM", repeats_type: "REPEAT" }).getRoomSelection([], 2)).toEqual([]);
    });

    it("repeats a zone selection for REPEAT and leaves it alone otherwise", () => {
        const zones = [[1, 2, 3, 4]];
        expect(mode({ selection_type: "MANUAL_RECTANGLE", repeats_type: "REPEAT" }).repeatSelection(zones, 3)).toEqual([
            ...zones,
            ...zones,
            ...zones,
        ]);
        expect(mode({ selection_type: "MANUAL_RECTANGLE", repeats_type: "EXTERNAL" }).repeatSelection(zones, 3)).toEqual(zones);
    });
});

describe("point placeholders follow the mode's selection type", () => {
    const schema = { service: "a.b", service_data: { x: "[[point_x]]", y: "[[point_y]]" } };
    it("fills them for a point mode with INTERNAL repeats", async () => {
        const m = mode({ selection_type: "MANUAL_POINT", repeats_type: "INTERNAL", service_call_schema: schema });
        expect((await m.getServiceCall(noRender, ENTITY, [25500, 25000, 2], 2, {})).serviceData).toEqual({ x: 25500, y: 25000 });
    });

    it("leaves them empty for three numeric room ids", async () => {
        const m = mode({ selection_type: "ROOM", service_call_schema: schema });
        expect((await m.getServiceCall(noRender, ENTITY, [13, 14, 15], 1, {})).serviceData).toEqual({ x: "", y: "" });
    });
});

describe("Home Assistant version dependent payloads (Deebot / Ecovacs)", () => {
    const hassAt = (version?: string): HomeAssistantFixed =>
        ({ config: version === undefined ? {} : { version } }) as unknown as HomeAssistantFixed;
    const deebot = (template: string): MapMode =>
        new MapMode("DeebotUniverse/Deebot-4-Home-Assistant", { template } as MapModeConfig, "en");

    it.each([
        ["2026.2.3", "16,17", "25500,25500,26500,26500"],
        ["2025.12.0", "16,17", "25500,25500,26500,26500"],
        ["2026.3.0", [16, 17], [25500, 25500, 26500, 26500]],
        ["2026.11.0", [16, 17], [25500, 25500, 26500, 26500]],
        ["2026.3.0.dev0", [16, 17], [25500, 25500, 26500, 26500]],
        [undefined, [16, 17], [25500, 25500, 26500, 26500]],
    ])("Home Assistant %s gets rooms %j and coordinates %j", async (version, rooms, coordinates) => {
        const segmentMode = deebot("vacuum_clean_segment");
        const selection = segmentMode.getRoomSelection(["16", "17"], 2);
        const segment = await segmentMode.getServiceCall(hassAt(version), ENTITY, selection, 2, {});
        expect(segment.serviceData).toEqual({
            entity_id: ENTITY,
            command: "spot_area",
            params: { rooms, cleanings: 2 },
        });
        const zone = await deebot("vacuum_clean_zone").getServiceCall(hassAt(version), ENTITY, [[25500, 25500, 26500, 26500]], 1, {});
        expect(zone.serviceData).toEqual({ entity_id: ENTITY, command: "custom_area", params: { coordinates } });
    });

    it("never replaces a service_call_schema the user configured", async () => {
        const custom = { service: "x.y", service_data: { ids: "[[selection]]" } };
        const m = new MapMode(
            "DeebotUniverse/Deebot-4-Home-Assistant",
            { template: "vacuum_clean_segment", service_call_schema: custom } as MapModeConfig,
            "en",
        );
        const call = await m.getServiceCall(hassAt("2026.2.0"), ENTITY, m.getRoomSelection(["16"], 1), 1, {});
        expect([call.domain, call.service, call.serviceData]).toEqual(["x", "y", { ids: [16] }]);
    });
});

describe("normalizeJinjaQuotes on the shipped templates", () => {
    it("finds only complete, single Jinja blocks, so literal JSON braces are never unescaped", async () => {
        const { contractCases } = await import("./contract/service-contracts");
        const templated = contractCases().filter(c => c.templated);
        expect(templated.length).toBeGreaterThan(0);
        for (const testCase of templated) {
            const call = testCase.mode.serviceCallSchema.apply(ENTITY, testCase.selection, testCase.repeats, testCase.variables);
            const text = JSON.stringify(call.serviceData);
            for (const block of text.match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) ?? []) {
                const inner = block.slice(2, -2);
                expect(inner, `${testCase.name}: ${block}`).not.toMatch(/\{\{|\{%|\}\}|%\}/);
            }
        }
    });

    it("leaves a JSON payload with nested objects untouched", () => {
        const template = JSON.stringify({ payload: '{"a": {"b": {"c": 1}}, "n": {{ 1 + 1 }}}' });
        expect(normalizeJinjaQuotes(template)).toBe(template);
    });
});

describe("exported mode config keeps the legacy schemas", () => {
    it("round-trips a Deebot mode through toMapModeConfig and still picks the payload by version", async () => {
        const original = new MapMode("DeebotUniverse/Deebot-4-Home-Assistant", { template: "vacuum_clean_segment" } as MapModeConfig, "en");
        const exported = original.toMapModeConfig();
        expect(exported.legacy_service_call_schemas?.[0]?.before_ha_version).toBe("2026.3");

        // The exported config has a service_call_schema of its own, like a pasted-back YAML config.
        const reimported = new MapMode("DeebotUniverse/Deebot-4-Home-Assistant", JSON.parse(JSON.stringify(exported)), "en");
        const at = (version: string) => ({ config: { version } }) as unknown as HomeAssistantFixed;
        const selection = reimported.getRoomSelection(["16", "17"], 1);
        expect((await reimported.getServiceCall(at("2026.2.0"), ENTITY, selection, 1, {})).serviceData).toMatchObject({
            params: { rooms: "16,17" },
        });
        expect((await reimported.getServiceCall(at("2026.3.0"), ENTITY, selection, 1, {})).serviceData).toMatchObject({
            params: { rooms: [16, 17] },
        });
    });

    it("exports no legacy schemas for a mode without them", () => {
        const m = new MapMode("Xiaomi Miio", { template: "vacuum_clean_segment" } as MapModeConfig, "en");
        expect(m.toMapModeConfig().legacy_service_call_schemas).toBeUndefined();
    });
});
