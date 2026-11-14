import type { Page } from "@playwright/test";
import { card, type CardHandle, expect, login, openDashboard, serviceCall, shot, test, waitForCard } from "./helpers";

/**
 * What happens after Start, against a real Home Assistant and a vacuum that misbehaves the way real
 * ones do (`map_fixture/vacuum.py`): it reports its state late, cleans a multi-room command in its
 * own order, ignores a command while it heads home, docks after a job, can fail a call and can go
 * unavailable. Its `cleaned_rooms` records that it cleans in its own order, not the order sent.
 */

const VACUUM = "vacuum.fake_vacuum";
const DASHBOARD = "/e2e-run/run";

async function configure(data: Record<string, unknown>): Promise<void> {
    await serviceCall("map_fixture", "vacuum_configure", data);
}

async function resetVacuum(activity = "docked"): Promise<void> {
    await serviceCall("map_fixture", "vacuum_reset", { activity });
    await configure({ lag: 0, room_seconds: 4, return_seconds: 3, fail_next: false, available: true, poll_seconds: 2 });
}

async function openRunCard(page: Page): Promise<CardHandle> {
    await openDashboard(page, DASHBOARD);
    await waitForCard(page);
    const target = await card(page);
    await expect.poll(() => target.evaluate(element => element.shadowRoot.querySelectorAll(".room-wrapper").length)).toBeGreaterThanOrEqual(3);
    return target;
}

/** The vacuum state Home Assistant's frontend currently shows. */
function shownState(page: Page): Promise<string | undefined> {
    return page.evaluate(entity => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.state, VACUUM);
}

function attribute(page: Page, name: string): Promise<unknown> {
    return page.evaluate(
        ([entity, key]) => (document.querySelector("home-assistant") as any)?.hass?.states[entity]?.attributes[key],
        [VACUUM, name] as const,
    );
}

/** A point inside room `id`, off its centre (the centre carries the label). */
async function roomPoint(target: CardHandle, id: string): Promise<{ x: number; y: number }> {
    const point = await target.evaluate((element, roomId: string) => {
        const outline = element.shadowRoot.querySelector(`.room-${roomId}-wrapper .room-outline`) as SVGPolygonElement | null;
        const matrix = outline?.getScreenCTM();
        if (!outline || !matrix || outline.points.numberOfItems === 0) return null;
        const svg = outline.ownerSVGElement!;
        const screen: Array<{ x: number; y: number }> = [];
        for (let index = 0; index < outline.points.numberOfItems; index++) {
            const p = svg.createSVGPoint();
            p.x = outline.points.getItem(index).x;
            p.y = outline.points.getItem(index).y;
            screen.push(p.matrixTransform(matrix));
        }
        const centre = screen.reduce((acc, p) => ({ x: acc.x + p.x / screen.length, y: acc.y + p.y / screen.length }), { x: 0, y: 0 });
        return { x: centre.x + (screen[0].x - centre.x) * 0.6, y: centre.y + (screen[0].y - centre.y) * 0.6 };
    }, id);
    if (!point) throw new Error(`room ${id} has no outline on screen`);
    return point;
}

async function tapRoom(page: Page, target: CardHandle, id: string): Promise<void> {
    const point = await roomPoint(target, id);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(200);
}

function selected(target: CardHandle): Promise<string[]> {
    return target.evaluate(element => element.selectedRooms.map((room: any) => String(room.toVacuum())));
}

/** Rooms drawn as part of the run in progress. */
function running(target: CardHandle): Promise<string[]> {
    return target.evaluate(element =>
        ["0", "1", "2"].filter(id => element.shadowRoot.querySelector(`.room-${id}-wrapper`)?.classList.contains("running")),
    );
}

function numbers(target: CardHandle): Promise<number> {
    return target.evaluate(element => element.shadowRoot.querySelectorAll(".room-order").length);
}

function playIcons(target: CardHandle): Promise<number> {
    // The card's icon list, not the run button, which shows a play icon too.
    return target.locator.locator('.icons-wrapper ha-icon[icon="mdi:play"]').count();
}

async function pressStart(page: Page, target: CardHandle): Promise<void> {
    const box = await target.locator.locator(".map-actions-item.main").boundingBox();
    if (!box) throw new Error("the card has no run button");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // The run control waits 250 ms for a possible double tap.
    await page.waitForTimeout(600);
}

test.describe("the run after Start, with a misbehaving vacuum", () => {
    test.afterEach(async () => {
        await resetVacuum();
    });

    test("a lagging vacuum that plans its own route", async ({ loggedIn: page }) => {
        test.setTimeout(120_000);
        await resetVacuum();
        await configure({ lag: 6 });
        const target = await openRunCard(page);
        expect(await playIcons(target)).toBe(1);

        await tapRoom(page, target, "2");
        await tapRoom(page, target, "0");
        expect(await selected(target)).toEqual(["2", "0"]);
        // The numbers show the order tapped and sent, on every platform.
        expect(await numbers(target)).toBe(2);

        await pressStart(page, target);
        // Home Assistant still says docked, but the run is already on the map, and the play icon
        // (a full clean) is gone while the start is pending.
        expect(await shownState(page)).toBe("docked");
        expect(await running(target)).toEqual(["0", "2"]);
        expect(await playIcons(target)).toBe(0);
        await shot(page, "16-run-pending");

        // Once the start is reported, the rooms are locked.
        await expect.poll(() => shownState(page), { timeout: 20_000 }).toBe("cleaning");
        await tapRoom(page, target, "1");
        expect(await selected(target)).toEqual([]);
        expect(await running(target)).toEqual(["0", "2"]);

        // It cleans in its own order and docks; the run ends with it.
        await expect.poll(() => shownState(page), { timeout: 40_000 }).toBe("docked");
        expect(await attribute(page, "cleaned_rooms")).toEqual(["0", "2"]);
        await expect.poll(() => running(target)).toEqual([]);
        await tapRoom(page, target, "1");
        expect(await selected(target)).toEqual(["1"]);
    });

    test("a failed call gives the selection back", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ fail_next: true });
        const target = await openRunCard(page);
        await tapRoom(page, target, "2");
        await tapRoom(page, target, "0");
        await pressStart(page, target);

        await expect.poll(() => selected(target)).toEqual(["2", "0"]);
        expect(await running(target)).toEqual([]);
        expect(await page.evaluate(() => window.localStorage.getItem("xiaomi-vacuum-map-card.active-room-run"))).toBeNull();
        expect(await shownState(page)).toBe("docked");
    });

    test("an unavailable vacuum keeps the run on the map without locking the rooms", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ room_seconds: 60 });
        const target = await openRunCard(page);
        await tapRoom(page, target, "1");
        await pressStart(page, target);
        await expect.poll(() => shownState(page)).toBe("cleaning");

        await configure({ available: false });
        await expect.poll(() => shownState(page)).toBe("unavailable");
        await page.waitForTimeout(3_000);
        expect(await running(target)).toEqual(["1"]);

        // Unknown is not working: a tap starts a new selection.
        await tapRoom(page, target, "2");
        expect(await selected(target)).toEqual(["2"]);
        expect(await running(target)).toEqual([]);
    });

    test("a room command the vacuum ignores while heading home does not lock the rooms", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ return_seconds: 25 });
        const target = await openRunCard(page);
        await serviceCall("vacuum", "return_to_base", { entity_id: VACUUM });
        await expect.poll(() => shownState(page)).toBe("returning");

        await tapRoom(page, target, "1");
        await pressStart(page, target);
        // The fake vacuum rewrites its state every 2 s with a new attribute and the same
        // `returning`, as a polling integration does; let a few of those arrive.
        await page.waitForTimeout(5_000);
        // `returning` was shown before Start: it is not the start of this run.
        expect(await running(target)).toEqual(["1"]);
        await tapRoom(page, target, "2");
        expect(await selected(target)).toEqual(["2"]);

        await expect.poll(() => shownState(page), { timeout: 40_000 }).toBe("docked");
        expect(await attribute(page, "job_rooms")).toEqual([]);
    });

    test("a second tab shows the run the first started", async ({ loggedIn: page }) => {
        await resetVacuum();
        await configure({ lag: 6 });
        const first = await openRunCard(page);

        const secondPage = await page.context().newPage();
        await login(secondPage);
        const second = await openRunCard(secondPage);

        await tapRoom(page, first, "2");
        await tapRoom(page, first, "0");
        await pressStart(page, first);

        await expect.poll(() => running(second)).toEqual(["0", "2"]);
        await expect.poll(() => shownState(secondPage), { timeout: 20_000 }).toBe("cleaning");
        await tapRoom(secondPage, second, "1");
        expect(await selected(second)).toEqual([]);
        await secondPage.close();
    });
});
