import { expect, openDashboard, card, shot, test, waitForCard, viewState, type CardHandle } from "./helpers";

/**
 * What only a real dashboard does to a zoomed map: Home Assistant detaches the card when the user
 * switches to another view and attaches the cached element again on the way back, and a sections
 * view resizes the card with the window.
 *
 * Asserted as the map point in the middle of the viewport (a fraction of the map content), so the
 * check reads what the user sees at any card width, plus the image source: a detached card must not
 * have swapped its camera snapshot for the disconnected placeholder.
 */

interface Fraction {
    x: number;
    y: number;
}

function viewCentre(target: CardHandle): Promise<Fraction> {
    return target.evaluate(element => {
        const root = element.shadowRoot as ShadowRoot;
        const zoomer = root.getElementById("map-zoomer") as HTMLElement;
        const content = root.getElementById("map-zoomer-content") as HTMLElement;
        const matrix = new DOMMatrix(getComputedStyle(content).transform);
        const viewport = zoomer.getBoundingClientRect();
        const point = matrix.inverse().transformPoint(new DOMPoint(viewport.width / 2, viewport.height / 2));
        return { x: point.x / content.offsetWidth, y: point.y / content.offsetHeight };
    });
}

function mapSrc(target: CardHandle): Promise<string> {
    return target.evaluate(element => element.shadowRoot.getElementById("map-image-source").getAttribute("src") ?? "");
}

function contentWidth(target: CardHandle): Promise<number> {
    return target.evaluate(element => element.shadowRoot.getElementById("map-zoomer-content").offsetWidth);
}

async function navigateInApp(page: import("@playwright/test").Page, path: string): Promise<void> {
    await page.evaluate(target => {
        history.pushState(null, "", target);
        window.dispatchEvent(new CustomEvent("location-changed", { detail: { replace: false } }));
    }, path);
    await page.waitForURL(`**${path}`);
}

function distance(a: Fraction, b: Fraction): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

test("a zoomed map keeps its view through a view switch and a window resize", async ({ loggedIn: page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDashboard(page, "/e2e-layout/sections");
    await waitForCard(page);
    const target = await card(page);
    await expect.poll(async () => (await mapSrc(target)).includes("/api/")).toBe(true);

    // Zoom off-centre with the card's own pinch-zoom, as a pinch would leave it.
    await target.evaluate(element => {
        const root = element.shadowRoot as ShadowRoot;
        const zoomer = root.getElementById("map-zoomer") as any;
        const content = root.getElementById("map-zoomer-content") as HTMLElement;
        const viewport = zoomer.getBoundingClientRect();
        const scale = 2.5;
        zoomer.setTransform({
            scale,
            x: viewport.width / 2 - scale * content.offsetWidth * 0.3,
            y: viewport.height / 2 - scale * content.offsetHeight * 0.6,
            allowChangeEvent: true,
        });
    });
    await expect.poll(async () => (await viewState(target)).scale).toBeCloseTo(2.5, 2);
    const zoomed = await viewCentre(target);
    expect(distance(zoomed, { x: 0.3, y: 0.6 })).toBeLessThan(0.01);

    // Away to another view and back: the cached card element is detached and attached again.
    await navigateInApp(page, "/e2e-layout/vertical");
    await page.waitForTimeout(1500);
    await navigateInApp(page, "/e2e-layout/sections");
    await waitForCard(page);
    const back = await card(page);
    await page.waitForTimeout(500);
    expect(await mapSrc(back), "the camera snapshot, not the placeholder").toContain("/api/");
    expect(await mapSrc(back)).not.toBe("");
    expect((await viewState(back)).scale).toBeCloseTo(2.5, 2);
    expect(distance(await viewCentre(back), zoomed), "same map point after the view switch").toBeLessThan(0.01);

    // A phone-width window makes the sections column, and so the card, narrower.
    const wideWidth = await contentWidth(back);
    await page.setViewportSize({ width: 400, height: 900 });
    await expect.poll(async () => Math.abs((await contentWidth(back)) - wideWidth)).toBeGreaterThan(40);
    await expect.poll(async () => distance(await viewCentre(back), zoomed)).toBeLessThan(0.01);
    await shot(page, "view-switch-resize");
});
