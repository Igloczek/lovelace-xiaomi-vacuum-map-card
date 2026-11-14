import { describe, expect, it } from "vitest";

import { isHaVersionBefore } from "../src/model/ha-version";

describe("isHaVersionBefore", () => {
    it.each([
        ["2026.2.3", "2026.3", true],
        ["2026.2.0b3", "2026.3", true],
        ["2025.12.5", "2026.3", true],
        ["2026.3.0", "2026.3", false],
        ["2026.3.0b1", "2026.3", false],
        ["2026.3.0.dev0", "2026.3", false],
        ["2026.10.0", "2026.3", false],
        ["2026.10.0", "2026.4", false],
        ["2026.3.1", "2026.3.2", true],
        ["2027.1.0", "2026.3", false],
    ])("%s before %s: %s", (version, target, expected) => {
        expect(isHaVersionBefore(version, target)).toBe(expected);
    });

    it.each([undefined, "", "unknown", "dev"])("treats %j as the newest version", version => {
        expect(isHaVersionBefore(version, "2026.3")).toBe(false);
    });
});
