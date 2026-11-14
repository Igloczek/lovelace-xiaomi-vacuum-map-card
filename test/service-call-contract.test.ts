import { describe, expect, it } from "vitest";

import { PlatformGenerator } from "../src/model/generators/platform-generator";
import type { HomeAssistantFixed } from "../src/types/fixes";
import {
    buildServiceCall,
    checkContract,
    contractCases,
    CONTRACTS,
    isExpectedToPass,
    USER_CONFIGURED,
} from "./contract/service-contracts";

/**
 * Every platform template × map mode × room-id type, built with the card's `MapMode` and checked
 * against the integration's service schema (see `test/contract/service-contracts.ts`). Modes with
 * `evaluate_data_as_template` need Home Assistant to render them; the e2e spec
 * `service-call-contract.spec.ts` runs those through a real instance.
 */

const noRender = {
    connection: {
        subscribeMessage: () => {
            throw new Error("templated cases are rendered by the e2e suite");
        },
    },
} as unknown as HomeAssistantFixed;

const cases = contractCases();

describe("service-call contract matrix", () => {
    it("covers every platform template", () => {
        const missing = PlatformGenerator.getPlatforms().flatMap(platform =>
            USER_CONFIGURED[platform]
                ? []
                : PlatformGenerator.getModeTemplateNames(platform)
                      .filter(template => !CONTRACTS[platform]?.[template])
                      .map(template => `${platform} / ${template}`),
        );
        expect(missing).toEqual([]);
    });

    const plain = cases.filter(c => !c.templated && !USER_CONFIGURED[c.platform]);
    it.each(plain.filter(isExpectedToPass).map(c => [c.name, c] as const))("%s", async (_name, testCase) => {
        const call = await buildServiceCall(testCase, noRender);
        expect(checkContract(testCase, call), JSON.stringify(call)).toEqual([]);
    });
});
