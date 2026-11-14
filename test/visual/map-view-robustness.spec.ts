import { expect, test, type Page } from "@playwright/test";

import type { XiaomiVacuumMapCardConfig } from "../../src/types/types";

/**
 * Map view robustness in a real browser layout: the scenarios that failed for users rather than in
 * idealised unit tests. They change the card width, reload or resize the camera image, detach and
 * re-attach the card and drive real touch input, then assert geometry — which map point is in the
 * middle of the viewport, and whether the room overlay still covers its room in the image.
 *
 * Screenshot-free on purpose, so the file runs on any host as well as in the pinned CI image.
 */

const CARD = "xiaomi-vacuum-map-card";
const STORE_KEY = "xiaomi-vacuum-map-card.map-view";

interface VisualHarness {
    ready: boolean;
    hass: Record<string, unknown> & { states: Record<string, Record<string, unknown>> };
    mount: (config: XiaomiVacuumMapCardConfig) => Promise<boolean>;
    setZoom: (scale: number, anchor?: { x: number; y: number }) => Promise<{ mapScale: number; realScale: number }>;
}

type VisualWindow = Window & { visualHarness: VisualHarness };

interface Fraction {
    x: number;
    y: number;
}

const pageErrors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    pageErrors.set(page, errors);
    page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
    page.on("console", message => {
        if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
    });
    await page.goto("/");
    await page.waitForFunction(() => (window as unknown as VisualWindow).visualHarness?.ready === true, undefined, {
        timeout: 15_000,
    });
});

test.afterEach(async ({ page }) => {
    expect(pageErrors.get(page) ?? []).toEqual([]);
});

function cardConfig(overrides: Partial<XiaomiVacuumMapCardConfig> = {}): XiaomiVacuumMapCardConfig {
    return {
        type: "custom:xiaomi-vacuum-map-card",
        entity: "vacuum.roborock_s7",
        map_source: { camera: "camera.vacuum_map" },
        calibration_source: { camera: true },
        vacuum_platform: "Xiaomi Miio",
        map_modes: [{ template: "vacuum_clean_segment" }],
        tiles: [],
        icons: [],
        persist_map_view: true,
        ...overrides,
    };
}

async function mount(page: Page, config: XiaomiVacuumMapCardConfig): Promise<void> {
    await page.evaluate(input => (window as unknown as VisualWindow).visualHarness.mount(input), config);
    await expect(page.locator(CARD)).toBeVisible();
}

async function setContainerWidth(page: Page, width: number): Promise<void> {
    await page.setViewportSize({ width: Math.max(800, width + 40), height: 1100 });
    await page.evaluate(cardWidth => {
        const root = document.getElementById("card-root");
        if (root) root.style.width = `${cardWidth}px`;
    }, width);
}

function nextLayout(page: Page): Promise<void> {
    return page.evaluate(
        () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
}

/** Frames the content point at `anchor` (fractions of the content box) in the viewport centre. */
async function setZoom(page: Page, scale: number, anchor: Fraction): Promise<void> {
    const result = await page.evaluate(
        input => (window as unknown as VisualWindow).visualHarness.setZoom(input.scale, input.anchor),
        { scale, anchor },
    );
    expect(result.mapScale).toBeCloseTo(scale, 5);
}

/**
 * The map point in the middle of the map viewport, as a fraction of the untransformed content box.
 *
 * Read from the transform the browser renders, so it is what the user sees, independent of the
 * card's own bookkeeping and of the card width.
 */
function viewCentre(page: Page): Promise<Fraction> {
    return page.evaluate(() => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
        const root = card.shadowRoot as ShadowRoot;
        const zoomer = root.getElementById("map-zoomer") as HTMLElement;
        const content = root.getElementById("map-zoomer-content") as HTMLElement;
        const matrix = new DOMMatrix(getComputedStyle(content).transform);
        const viewport = zoomer.getBoundingClientRect();
        const point = matrix.inverse().transformPoint(new DOMPoint(viewport.width / 2, viewport.height / 2));
        return { x: point.x / content.offsetWidth, y: point.y / content.offsetHeight };
    });
}

function cardState(page: Page): Promise<{ mapScale: number; mapRotation: number; realScale: number }> {
    return page.evaluate(() => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as unknown as {
            mapScale: number;
            mapRotation: number;
            realScale: number;
        };
        return { mapScale: card.mapScale, mapRotation: card.mapRotation, realScale: card.realScale };
    });
}

/**
 * Largest distance, in screen pixels, between the living room's rendered outline and where that
 * room is in the rendered map image. Works at any zoom, rotation and image resolution because both
 * boxes are measured on screen and the room is given as a fraction of the image.
 */
function livingRoomAlignmentError(page: Page): Promise<number> {
    return page.evaluate(() => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
        const root = card.shadowRoot as ShadowRoot;
        const image = root.getElementById("map-image") as HTMLElement;
        const content = root.getElementById("map-zoomer-content") as HTMLElement;
        const polygon = root.querySelector(".room-1-wrapper polygon") as SVGGraphicsElement | null;
        if (!polygon) return Number.POSITIVE_INFINITY;
        // The room in fixture pixels (100..170 × 20..70 of 200 × 150), mapped through the content
        // transform to the screen.
        const matrix = new DOMMatrix(getComputedStyle(content).transform);
        const zoomerBox = (root.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
        const toScreen = (fx: number, fy: number): DOMPoint => {
            const local = new DOMPoint(image.offsetWidth * fx, image.offsetHeight * fy);
            const p = matrix.transformPoint(local);
            return new DOMPoint(p.x + zoomerBox.x, p.y + zoomerBox.y);
        };
        const corners = [
            toScreen(100 / 200, 20 / 150),
            toScreen(170 / 200, 20 / 150),
            toScreen(100 / 200, 70 / 150),
            toScreen(170 / 200, 70 / 150),
        ];
        const xs = corners.map(c => c.x);
        const ys = corners.map(c => c.y);
        const expected = {
            x: Math.min(...xs),
            y: Math.min(...ys),
            right: Math.max(...xs),
            bottom: Math.max(...ys),
        };
        const outline = polygon.getBoundingClientRect();
        return Math.max(
            Math.abs(outline.x - expected.x),
            Math.abs(outline.y - expected.y),
            Math.abs(outline.right - expected.right),
            Math.abs(outline.bottom - expected.bottom),
        );
    });
}

function storedEntryCount(page: Page): Promise<number> {
    return page.evaluate(key => Object.keys(JSON.parse(window.localStorage.getItem(key) ?? "{}")).length, STORE_KEY);
}

function expectCentre(actual: Fraction, expected: Fraction, label: string): void {
    // 1 % of the map: well under a room, far above sub-pixel rounding.
    expect(Math.abs(actual.x - expected.x), `${label}: centre x ${actual.x.toFixed(3)}`).toBeLessThanOrEqual(0.01);
    expect(Math.abs(actual.y - expected.y), `${label}: centre y ${actual.y.toFixed(3)}`).toBeLessThanOrEqual(0.01);
}

/** Replaces the camera state the way a new camera snapshot does, optionally with new attributes. */
async function updateCamera(page: Page, token: string, attributes: Record<string, unknown> = {}): Promise<void> {
    await page.evaluate(
        input => {
            const harness = (window as unknown as VisualWindow).visualHarness;
            const camera = harness.hass.states["camera.vacuum_map"];
            const nextCamera = {
                ...camera,
                last_updated: new Date().toISOString(),
                attributes: {
                    ...(camera.attributes as Record<string, unknown>),
                    entity_picture: `/api/camera_proxy/camera.vacuum_map?token=${input.token}`,
                    ...input.attributes,
                },
            };
            harness.hass = { ...harness.hass, states: { ...harness.hass.states, "camera.vacuum_map": nextCamera } };
            (document.querySelector("xiaomi-vacuum-map-card") as unknown as { hass: unknown }).hass = harness.hass;
        },
        { token, attributes },
    );
}

async function waitForImageLoad(page: Page, token: string): Promise<void> {
    await page.waitForFunction(expected => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement | null;
        const image = card?.shadowRoot?.getElementById("map-image-source") as HTMLImageElement | null;
        return !!image && image.src.includes(`token=${expected}`) && image.complete && image.naturalWidth > 0;
    }, token);
    await page.waitForTimeout(250);
    await nextLayout(page);
}

test.describe("persisted map view across card widths", () => {
    // A stored view is in the browser's localStorage, so the same view is reopened at whatever
    // width the card has now: a rotated phone, a resized window, a sections column change.
    for (const rotation of [0, 90] as const) {
        test(`a view stored at 800 px reopens on the same map point at 400 px (rotation ${rotation})`, async ({
            page,
        }) => {
            const config = cardConfig({ map_rotation: rotation });
            await setContainerWidth(page, 800);
            await mount(page, config);
            await setZoom(page, 2.5, { x: 0.3, y: 0.6 });
            const saved = await viewCentre(page);
            expectCentre(saved, { x: 0.3, y: 0.6 }, "zoomed at 800 px");
            await expect.poll(() => storedEntryCount(page)).toBeGreaterThan(0);

            await setContainerWidth(page, 400);
            await mount(page, config);
            expect((await cardState(page)).mapScale).toBeCloseTo(2.5, 5);
            expectCentre(await viewCentre(page), saved, "reopened at 400 px");
        });
    }

    test("resizing the card while zoomed keeps the same map point in view", async ({ page }) => {
        await setContainerWidth(page, 800);
        await mount(page, cardConfig({ map_rotation: 90 }));
        await setZoom(page, 2.5, { x: 0.7, y: 0.35 });
        const before = await viewCentre(page);

        await setContainerWidth(page, 400);
        await nextLayout(page);
        await expect.poll(async () => Math.abs((await viewCentre(page)).x - before.x)).toBeLessThanOrEqual(0.01);
        expectCentre(await viewCentre(page), before, "after shrinking to 400 px");
        await expect.poll(() => livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);

        await setContainerWidth(page, 1000);
        await nextLayout(page);
        await expect.poll(async () => Math.abs((await viewCentre(page)).x - before.x)).toBeLessThanOrEqual(0.01);
        expectCentre(await viewCentre(page), before, "after growing to 1000 px");

        // The rescaled view is what is stored, so a reload at the new width still frames it.
        await expect.poll(() => storedEntryCount(page)).toBeGreaterThan(0);
        await mount(page, cardConfig({ map_rotation: 90 }));
        expectCentre(await viewCentre(page), before, "reopened at 1000 px");
    });
});

test.describe("camera image reloads", () => {
    test("a new snapshot while zoomed and rotated keeps the view and the overlay aligned", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig({ map_rotation: 90 }));
        await setZoom(page, 2.5, { x: 0.65, y: 0.3 });
        const before = await viewCentre(page);
        const { realScale } = await cardState(page);
        expect(await livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);

        for (const token of ["one", "two", "three"]) {
            await updateCamera(page, token);
            await waitForImageLoad(page, token);
        }

        const after = await cardState(page);
        expect(after.mapScale).toBeCloseTo(2.5, 5);
        expect(after.mapRotation).toBe(90);
        // A transformed measurement would fold the zoom into the base scale on every load.
        expect(after.realScale).toBeCloseTo(realScale, 5);
        expectCentre(await viewCentre(page), before, "after three reloads");
        expect(await livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);
    });

    test("a camera image that changes size mid-session keeps the overlay on its room", async ({ page }) => {
        // Serve a 2x copy of the fixture for the "big" snapshot, with calibration doubled to match,
        // as a camera does when it renders the map at a new resolution.
        await page.route("**/api/camera_proxy/**", async route => {
            if (!route.request().url().includes("token=big")) return route.continue();
            const body = await page.evaluate(async () => {
                const source = new Image();
                source.src = "/fixtures/synthetic/map.png";
                await source.decode();
                const canvas = document.createElement("canvas");
                canvas.width = source.naturalWidth * 2;
                canvas.height = source.naturalHeight * 2;
                const context = canvas.getContext("2d") as CanvasRenderingContext2D;
                context.imageSmoothingEnabled = false;
                context.drawImage(source, 0, 0, canvas.width, canvas.height);
                return canvas.toDataURL("image/png").split(",")[1];
            });
            await route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from(body, "base64") });
        });
        await setContainerWidth(page, 400);
        await mount(page, cardConfig());
        await setZoom(page, 2, { x: 0.6, y: 0.3 });
        const before = await viewCentre(page);
        const small = await cardState(page);

        await updateCamera(page, "big", {
            calibration_points: [
                { map: { x: 0, y: 0 }, vacuum: { x: 0, y: 0 } },
                { map: { x: 400, y: 0 }, vacuum: { x: 2000, y: 0 } },
                { map: { x: 0, y: 300 }, vacuum: { x: 0, y: 1500 } },
            ],
        });
        await waitForImageLoad(page, "big");

        const big = await cardState(page);
        expect(big.realScale).toBeCloseTo(small.realScale / 2, 5);
        expectCentre(await viewCentre(page), before, "after the image doubled");
        await expect.poll(() => livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);
    });
});

test.describe("re-attach", () => {
    test("a card detached and re-attached during its delayed work keeps its view and overlay", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig({ map_rotation: 90 }));
        await setZoom(page, 2, { x: 0.4, y: 0.4 });
        const before = await viewCentre(page);

        // What a Lovelace re-layout does: remove the element and add it back, here inside the
        // 100 ms window of the delayed restore and while a camera snapshot is loading.
        await updateCamera(page, "reattach");
        await page.evaluate(() => {
            const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
            const root = document.getElementById("card-root") as HTMLElement;
            card.remove();
            setTimeout(() => root.appendChild(card), 30);
        });
        await waitForImageLoad(page, "reattach");
        await page.waitForTimeout(400);

        expectCentre(await viewCentre(page), before, "after re-attach");
        expect((await cardState(page)).mapScale).toBeCloseTo(2, 5);
        expect(await livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);
        const transition = await page.evaluate(() => {
            const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
            const content = card.shadowRoot?.getElementById("map-zoomer-content") as HTMLElement;
            return getComputedStyle(content).transitionDuration;
        });
        expect(transition).toBe("0s");
    });
});

interface TouchPoint {
    x: number;
    y: number;
}

/**
 * Drives real touch input through the Chromium DevTools protocol, so pinch-zoom, the rotation
 * gesture and the tap guard receive the pointer events a phone produces, not synthetic ones.
 * `frames` is a list of touch-point sets; the first starts the gesture and the last ends it.
 */
async function touchGesture(page: Page, frames: TouchPoint[][]): Promise<void> {
    const session = await page.context().newCDPSession(page);
    const points = (frame: TouchPoint[]) => frame.map((point, id) => ({ x: point.x, y: point.y, id }));
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(frames[0]) });
    for (const frame of frames.slice(1)) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(frame) });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await session.detach();
    await nextLayout(page);
}

/** Two fingers on either side of `centre`, `radius` px apart from it, turned by `degrees` in steps. */
function twist(centre: TouchPoint, radius: number, degrees: number, steps = 12): TouchPoint[][] {
    const frames: TouchPoint[][] = [];
    for (let step = 0; step <= steps; step++) {
        const angle = ((degrees * step) / steps) * (Math.PI / 180);
        const dx = Math.cos(angle) * radius;
        const dy = Math.sin(angle) * radius;
        frames.push([
            { x: centre.x - dx, y: centre.y - dy },
            { x: centre.x + dx, y: centre.y + dy },
        ]);
    }
    return frames;
}

/** Fingers moving together by (dx, dy) in steps. */
function drag(starts: TouchPoint[], dx: number, dy: number, steps = 10): TouchPoint[][] {
    const frames: TouchPoint[][] = [];
    for (let step = 0; step <= steps; step++) {
        frames.push(starts.map(start => ({ x: start.x + (dx * step) / steps, y: start.y + (dy * step) / steps })));
    }
    return frames;
}

async function mapCentre(page: Page): Promise<TouchPoint> {
    const box = await page.locator(`${CARD} #map-zoomer`).boundingBox();
    expect(box).not.toBeNull();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

function transformOf(page: Page): Promise<string> {
    return page.evaluate(() => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
        return getComputedStyle(card.shadowRoot?.getElementById("map-zoomer-content") as HTMLElement).transform;
    });
}

function selectedRooms(page: Page): Promise<string[]> {
    return page.evaluate(() => {
        const card = document.querySelector("xiaomi-vacuum-map-card") as unknown as {
            selectedRooms: Array<{ toVacuum: () => unknown }>;
        };
        return (card.selectedRooms ?? []).map(room => String(room.toVacuum()));
    });
}

test.describe("touch gestures", () => {
    test.use({ hasTouch: true });

    test("a two-finger twist rotates the map, keeps the overlay aligned and is remembered", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig());
        const centre = await mapCentre(page);

        await touchGesture(page, twist(centre, 70, 40));
        const rotated = await cardState(page);
        // The deadzone eats the first few degrees; what remains is a clear, unsnapped rotation.
        expect(rotated.mapRotation).toBeGreaterThan(20);
        expect(rotated.mapRotation).toBeLessThan(45);
        await expect.poll(() => livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);
        // The fingers lifting over a room is the end of a rotation, not a room tap.
        expect(await selectedRooms(page)).toEqual([]);

        await expect.poll(() => storedEntryCount(page)).toBeGreaterThan(0);
        await page.waitForTimeout(500);
        await mount(page, cardConfig());
        expect((await cardState(page)).mapRotation).toBeCloseTo(rotated.mapRotation, 5);
    });

    test("a twist that ends near a right angle snaps to it", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig());
        await touchGesture(page, twist(await mapCentre(page), 70, 95, 19));
        const rotation = (await cardState(page)).mapRotation;
        expect([90, 450, -270]).toContain(Math.round(rotation));
    });

    test("a locked map ignores one-finger pans and two-finger twists", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig());
        await page.locator(`${CARD} ha-icon[icon="mdi:lock-open"]`).click();
        await expect(page.locator(`${CARD} ha-icon[icon="mdi:lock"]`)).toHaveCount(1);
        const before = await transformOf(page);
        const centre = await mapCentre(page);

        await touchGesture(page, drag([centre], 80, 40));
        await touchGesture(page, twist(centre, 70, 60));
        await touchGesture(page, drag([{ x: centre.x - 40, y: centre.y }, { x: centre.x + 40, y: centre.y }], 60, 0));

        expect(await transformOf(page)).toBe(before);
        expect((await cardState(page)).mapRotation).toBe(0);
    });

    test("with two_finger_pan one finger leaves the map alone and two fingers pan it", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig({ two_finger_pan: true, map_rotation_gesture: false }));
        await setZoom(page, 2, { x: 0.5, y: 0.5 });
        const before = await viewCentre(page);
        const centre = await mapCentre(page);

        await touchGesture(page, drag([centre], 60, 0));
        expectCentre(await viewCentre(page), before, "after a one-finger drag");

        await touchGesture(page, drag([{ x: centre.x - 40, y: centre.y }, { x: centre.x + 40, y: centre.y }], 60, 0));
        const after = await viewCentre(page);
        // Dragging right by 60 px at zoom 2 moves the view 30 content px left: 7.5 % of 400 px.
        expect(before.x - after.x).toBeGreaterThan(0.05);
        expect((await cardState(page)).mapRotation).toBe(0);
    });

    test("a one-finger tap on a room still selects it", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig());
        const point = await page.evaluate(() => {
            const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
            const box = card.shadowRoot?.querySelector(".room-1-wrapper polygon")?.getBoundingClientRect() as DOMRect;
            return { x: box.x + box.width * 0.25, y: box.y + box.height * 0.75 };
        });
        await page.touchscreen.tap(point.x, point.y);
        await expect.poll(() => selectedRooms(page)).toEqual(["1"]);
    });
});

test.describe("map appearance", () => {
    test("transparent_background clears the white map background in a dark theme and keeps rooms detected", async ({
        page,
    }) => {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.evaluate(() => {
            const style = document.documentElement.style;
            style.setProperty("--card-background-color", "#1c1c1c");
            style.setProperty("--primary-text-color", "#e1e1e1");
            document.body.style.background = "#111111";
        });
        await setContainerWidth(page, 400);
        await mount(page, cardConfig({ map_source: { camera: "camera.vacuum_map", transparent_background: true } }));

        const pixels = await page.evaluate(() => {
            const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
            const canvas = card.shadowRoot?.getElementById("map-image") as HTMLCanvasElement;
            const context = canvas.getContext("2d") as CanvasRenderingContext2D;
            const at = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data);
            return { background: at(5, 5), room: at(130, 40) };
        });
        expect(pixels.background[3], "the white background is transparent").toBe(0);
        expect(pixels.room).toEqual([60, 180, 75, 255]);

        // Room detection still finds the rooms on the processed canvas, aligned with the image.
        await expect.poll(() => livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);

        // Labels stay readable on any room colour: a light fill with a dark outline.
        const label = await page.evaluate(() => {
            const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
            const text = card.shadowRoot?.querySelector(".room-1-wrapper text.room-label-text, .room-1-wrapper text");
            const style = getComputedStyle(text as Element);
            return { fill: style.fill, stroke: style.stroke };
        });
        const luminance = (colour: string): number => {
            const [r, g, b] = (colour.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(Number);
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        expect(luminance(label.fill)).toBeGreaterThan(200);
        expect(luminance(label.stroke)).toBeLessThan(80);
    });
});

test.describe("horizontal layout at phone widths", () => {
    for (const width of [320, 360, 412] as const) {
        test(`stays inside a ${width} px card and keeps the map usable`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await page.evaluate(cardWidth => {
                const root = document.getElementById("card-root");
                if (root) root.style.width = `${cardWidth}px`;
            }, width);
            await mount(
                page,
                cardConfig({
                    layout: "horizontal",
                    map_modes: [
                        { template: "vacuum_clean_segment" },
                        { template: "vacuum_clean_zone" },
                        { template: "vacuum_goto" },
                    ],
                }),
            );
            const metrics = await page.evaluate(() => {
                const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement;
                const root = card.shadowRoot as ShadowRoot;
                const haCard = root.querySelector("ha-card") as HTMLElement;
                const map = (root.getElementById("map-zoomer") as HTMLElement).getBoundingClientRect();
                const controls = (root.querySelector(".controls-column") as HTMLElement).getBoundingClientRect();
                return {
                    pageScroll: document.documentElement.scrollWidth,
                    cardScroll: haCard.scrollWidth,
                    cardWidth: haCard.clientWidth,
                    map: { x: map.x, width: map.width, right: map.right },
                    controls: { x: controls.x, right: controls.right },
                };
            });
            expect(metrics.pageScroll, "no horizontal page scroll").toBeLessThanOrEqual(width);
            expect(metrics.cardScroll, "nothing overflows the card sideways").toBeLessThanOrEqual(metrics.cardWidth + 1);
            expect(metrics.controls.right).toBeLessThanOrEqual(width + 0.5);
            expect(metrics.map.right).toBeLessThanOrEqual(metrics.controls.x + 0.5);
            // The map keeps at least 40 % of a phone-width card; the controls column is clamped.
            expect(metrics.map.width).toBeGreaterThanOrEqual(width * 0.4);
            await expect.poll(() => livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);
        });
    }
});

test.describe("cards mounted while hidden", () => {
    test("a card mounted inside a hidden container applies its stored view and scale when shown", async ({ page }) => {
        const config = cardConfig({ map_rotation: 90 });
        await setContainerWidth(page, 400);
        await mount(page, config);
        await setZoom(page, 2.5, { x: 0.3, y: 0.6 });
        const saved = await viewCentre(page);
        await expect.poll(() => storedEntryCount(page)).toBeGreaterThan(0);
        await page.waitForTimeout(500);

        // A popup, a tab card or a closed conditional container: the card is created, gets its
        // config and hass and loads its map while the container is display: none.
        await page.evaluate(() => {
            const root = document.getElementById("card-root") as HTMLElement;
            root.style.display = "none";
        });
        await page.evaluate(input => {
            const harness = (window as unknown as VisualWindow).visualHarness;
            const root = document.getElementById("card-root") as HTMLElement;
            root.replaceChildren();
            const card = document.createElement("xiaomi-vacuum-map-card") as HTMLElement & {
                setConfig: (config: unknown) => void;
                hass: unknown;
            };
            card.setConfig(input);
            card.hass = harness.hass;
            root.appendChild(card);
        }, config);
        await page.waitForFunction(() => {
            const card = document.querySelector("xiaomi-vacuum-map-card") as HTMLElement | null;
            const image = card?.shadowRoot?.getElementById("map-image-source") as HTMLImageElement | null;
            return !!image && image.complete && image.naturalWidth > 0;
        });
        await page.waitForTimeout(500);

        // Shown again with nothing else happening: no hass update, no camera change.
        await page.evaluate(() => {
            (document.getElementById("card-root") as HTMLElement).style.display = "";
        });
        await expect.poll(async () => (await cardState(page)).mapScale, { timeout: 3000 }).toBeCloseTo(2.5, 5);
        expect((await cardState(page)).mapRotation).toBe(90);
        expectCentre(await viewCentre(page), saved, "shown after a hidden mount");
        await expect.poll(() => livingRoomAlignmentError(page)).toBeLessThanOrEqual(1.5);
    });
});

test.describe("map lock persistence", () => {
    function locked(page: Page): Promise<boolean> {
        return page.evaluate(
            () => (document.querySelector("xiaomi-vacuum-map-card") as unknown as { mapLocked: boolean }).mapLocked,
        );
    }

    test("the lock state and the locked view are remembered across a reload", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig());
        await setZoom(page, 2, { x: 0.6, y: 0.4 });
        const view = await viewCentre(page);
        await page.locator(`${CARD} ha-icon[icon="mdi:lock-open"]`).click();
        expect(await locked(page)).toBe(true);
        await page.waitForTimeout(500);

        await mount(page, cardConfig());
        expect(await locked(page)).toBe(true);
        expectCentre(await viewCentre(page), view, "locked view after reload");
        await expect(page.locator(`${CARD} .map-zoom-icons`)).toBeHidden();
    });

    test("persist_map_lock: false keeps the view but not the lock", async ({ page }) => {
        await setContainerWidth(page, 400);
        await mount(page, cardConfig({ persist_map_lock: false }));
        await setZoom(page, 2, { x: 0.6, y: 0.4 });
        await page.locator(`${CARD} ha-icon[icon="mdi:lock-open"]`).click();
        await page.waitForTimeout(500);

        await mount(page, cardConfig({ persist_map_lock: false }));
        expect(await locked(page)).toBe(false);
        expect((await cardState(page)).mapScale).toBeCloseTo(2, 5);
    });
});
