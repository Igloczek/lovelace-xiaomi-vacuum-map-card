import { expect, openDashboard, shot, test, waitForCard } from "./helpers";

/**
 * Generated configuration and validation against the real frontend: the real `hass` (its display
 * registry, states and locale), the real `hui-error-card`. Every card here is created in the page
 * and removed again; no dashboard is changed.
 */

const CALIBRATION = [
    { map: { x: 0, y: 0 }, vacuum: { x: 0, y: 0 } },
    { map: { x: 200, y: 0 }, vacuum: { x: 2000, y: 0 } },
    { map: { x: 0, y: 150 }, vacuum: { x: 0, y: 1500 } },
];

test.beforeEach(async ({ loggedIn: page }) => {
    await openDashboard(page, "/e2e-map/map");
    await waitForCard(page);
});

test("the card picker stub is built from the real hass", async ({ loggedIn: page }) => {
    const result = await page.evaluate(calibration => {
        const hass = (document.querySelector("home-assistant") as any).hass;
        const Card = customElements.get("xiaomi-vacuum-map-card") as any;
        // The fixture camera publishes no calibration, so no stub can be offered for it as is.
        const withoutCalibration = Card.getStubConfig(hass) ?? null;
        const camera = hass.states["camera.vacuum_map"];
        const calibrated = {
            ...hass,
            states: {
                ...hass.states,
                "camera.vacuum_map": { ...camera, attributes: { ...camera.attributes, calibration_points: calibration } },
            },
        };
        return { withoutCalibration, stub: Card.getStubConfig(calibrated) };
    }, CALIBRATION);
    expect(result.withoutCalibration).toBeNull();
    expect(result.stub).toMatchObject({
        type: "custom:xiaomi-vacuum-map-card",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        // The demo integration has no template, so the upstream default stays.
        vacuum_platform: "Xiaomi Miio",
    });
    expect(String(result.stub.entity)).toMatch(/^vacuum\./);
});

test("without map_modes, the camera's rooms add the room mode", async ({ loggedIn: page }) => {
    const modes = await page.evaluate(async calibration => {
        const hass = (document.querySelector("home-assistant") as any).hass;
        const element = document.createElement("xiaomi-vacuum-map-card") as any;
        element.setConfig({
            type: "custom:xiaomi-vacuum-map-card",
            entity: Object.keys(hass.states).find(id => id.startsWith("vacuum.")),
            vacuum_platform: "Xiaomi Miio",
            map_source: { camera: "camera.vacuum_map" },
            calibration_source: { calibration_points: calibration },
        });
        element.hass = hass;
        document.body.appendChild(element);
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = element.modes.map((mode: any) => mode.config.template);
        element.remove();
        return result;
    }, CALIBRATION);
    expect(modes).toEqual(["vacuum_clean_zone", "vacuum_goto", "vacuum_clean_segment"]);
});

test("malformed YAML shows Home Assistant's error card with the field", async ({ loggedIn: page }) => {
    const shown = await page.evaluate(async () => {
        const hass = (document.querySelector("home-assistant") as any).hass;
        const element = document.createElement("xiaomi-vacuum-map-card") as any;
        element.setConfig({
            type: "custom:xiaomi-vacuum-map-card",
            entity: Object.keys(hass.states).find(id => id.startsWith("vacuum.")),
            map_source: { camera: "camera.vacuum_map" },
            calibration_source: { camera: true },
            map_modes: "vacuum_clean_zone",
        });
        element.hass = hass;
        document.body.appendChild(element);
        await new Promise(resolve => setTimeout(resolve, 500));
        const errorCard = element.shadowRoot?.querySelector("hui-error-card");
        const text = errorCard ? `${errorCard.shadowRoot?.textContent ?? ""} ${JSON.stringify(errorCard._config ?? {})}` : "";
        element.remove();
        return { hasErrorCard: !!errorCard, text };
    });
    expect(shown.hasErrorCard).toBe(true);
    expect(shown.text).toContain("map_modes must be a list");
    await shot(page, "config-defaults-error");
});
