import { expect, test } from "@playwright/test";

import { connectRealHass, type RealHass } from "../support/ha-websocket";
import {
    buildServiceCall,
    checkContract,
    contractCases,
    ENTITY_ID,
    isExpectedToPass,
    USER_CONFIGURED,
} from "../../contract/service-contracts";
import { evaluateJinjaTemplate } from "../../../src/utils";
import type { HomeAssistantFixed } from "../../../src/types/fixes";

/**
 * The service-call contract matrix against a real Home Assistant (2026.11 in Docker). The card's
 * own `MapMode` code builds every case in Node; a mode with `evaluate_data_as_template` is rendered
 * by Home Assistant's `render_template`, exactly as the card does it, and the result is checked
 * against the integration's schema. The unit suite cannot do this: its mock always renders.
 *
 * Core services that this instance has are also called for real, so Home Assistant's own schema
 * has the last word: `persistent_notification.create` for the setup platforms and
 * `vacuum.send_command` on the demo vacuum for the templates that use it.
 */

const DEMO_VACUUM = "vacuum.demo_vacuum_0_ground_floor";

let hass: RealHass;

test.beforeAll(async () => {
    hass = await connectRealHass();
});

test.afterAll(() => hass?.close());

const cases = contractCases().filter(c => !USER_CONFIGURED[c.platform] && isExpectedToPass(c));

test("every templated mode renders in Home Assistant and matches its integration's schema", async () => {
    const templated = cases.filter(c => c.templated);
    expect(templated.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const testCase of templated) {
        try {
            const call = await buildServiceCall(testCase, hass as unknown as HomeAssistantFixed);
            const errors = checkContract(testCase, call);
            if (errors.length) failures.push(`${testCase.name}: ${errors.join("; ")} ${JSON.stringify(call.serviceData)}`);
        } catch (e) {
            failures.push(`${testCase.name}: ${(e as Error).message}`);
        }
    }
    expect(failures).toEqual([]);
});

test("every plain mode matches its integration's schema", async () => {
    const failures: string[] = [];
    for (const testCase of cases.filter(c => !c.templated)) {
        const call = await buildServiceCall(testCase, hass as unknown as HomeAssistantFixed);
        const errors = checkContract(testCase, call);
        if (errors.length) failures.push(`${testCase.name}: ${errors.join("; ")}`);
    }
    expect(failures).toEqual([]);
});

test("Home Assistant accepts the setup platforms' notifications", async () => {
    const setupCases = cases.filter(c => c.platform.startsWith("Setup"));
    expect(setupCases.length).toBe(6);
    const failures: string[] = [];
    for (const testCase of setupCases) {
        const call = await buildServiceCall(testCase, hass as unknown as HomeAssistantFixed);
        try {
            await hass.callService(call.domain, call.service, call.serviceData, call.target);
        } catch (e) {
            failures.push(`${testCase.name}: ${JSON.stringify(e)}`);
        }
    }
    expect(failures).toEqual([]);
});

test("Home Assistant's vacuum.send_command schema accepts every send_command template", async () => {
    const sendCommandCases = cases.filter(c => c.contract?.service === "vacuum.send_command");
    expect(sendCommandCases.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const testCase of sendCommandCases) {
        const call = await buildServiceCall(testCase, hass as unknown as HomeAssistantFixed);
        const data = { ...(call.serviceData ?? {}), entity_id: DEMO_VACUUM };
        try {
            await hass.callService(call.domain, call.service, data);
        } catch (e) {
            failures.push(`${testCase.name}: ${JSON.stringify(e)}`);
        }
    }
    expect(failures).toEqual([]);
});

test("a template error is reported by Home Assistant and rejects instead of hanging", async () => {
    await expect(evaluateJinjaTemplate(hass as unknown as HomeAssistantFixed, '{"a": "{{ [\\"13\\"] | length }}"}')).rejects.toThrow(
        /TemplateSyntaxError/,
    );
    await expect(evaluateJinjaTemplate(hass as unknown as HomeAssistantFixed, "{{ states('" + ENTITY_ID + "') }}")).resolves.toBe(
        "unknown",
    );
});
