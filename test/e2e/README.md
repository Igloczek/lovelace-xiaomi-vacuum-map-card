# End-to-end suite (real Home Assistant)

These tests drive a real Home Assistant instance in Docker, install the card the way a user does,
and exercise the behaviours the mock harness cannot prove. A release is published only after this
suite passes against the release candidate; screenshots are written to the gitignored
`test/e2e/artifacts/`.

## What it covers

| Spec | What it proves |
|---|---|
| `render.spec.ts` | The card renders from the installed Lovelace resource against a real camera entity. |
| `editor.spec.ts` | The visual editor opens in edit mode on a card whose ROOM mode starts empty; the Title field is the element the frontend provides and real keyboard typing reaches Home Assistant's edit-dialog config; **Generate rooms config** is the only way the room ids appear, and it does. The four switch labels are visible even though this frontend no longer defines `ha-formfield`. |
| `map-view.spec.ts` | `map_view` opens at the configured view, a real wheel gesture changes scale and offsets, the reset control returns to the default, and the view persists across reloads. |
| `layout.spec.ts` | `layout: horizontal` places the map beside the controls in a real **sections** view, a long mode name ellipsizes inside the column, and changing the card's grid options (what the resize handle causes) resizes the card. The vertical layout stays stacked. |
| `zoom-rotation.spec.ts` | At zoom 2.5 and rotation 90, the painted room colour's screen box must match the outline's screen box within 4 px in all four directions (set `E2E_OVERLAY_SHIFT="20,0"` to prove the check fails on a shifted overlay), and clicking each outline selects that room. |
| `view-switch-resize.spec.ts` | A zoomed map in the sections view keeps the same map point in view and its camera snapshot after switching to another view and back, and after the window narrows to phone width. |
| `camera-rate.spec.ts` | Vacuum state changes cause no snapshot request inside the refresh window (at most the one interval refresh); a camera change causes exactly one; a hidden tab causes none; becoming visible again causes one. |
| `yaml-y-key.spec.ts` | A YAML dashboard with an unquoted `y:` key applies the offset, so Home Assistant 2026.11 does not reproduce the boolean-key bug (upstream #952). |
| `config-defaults.spec.ts` | Against the real `hass`: the card-picker stub is built from the real display registry and states, a preset without `map_modes` gains the room mode from the camera's `rooms`, and malformed YAML (`map_modes` as a string) shows Home Assistant's own error card naming the field. The cards are created in the page and removed; no dashboard changes. |
| `selection-lifecycle.spec.ts` | Two rooms are tapped in a non-id order; turning the third room's `state_entity` (`input_boolean.e2e_clean_living_room`) on adds it at the end, a camera bump keeps the order, and turning the boolean off removes only that room, with the badges renumbered to match. |
| `service-call-contract.spec.ts` | Every platform template × map mode × string/number room id is built with the card's `MapMode` in Node and checked against the integration's service schema (`test/contract/service-contracts.ts`); modes with `evaluate_data_as_template` are rendered by this Home Assistant's `render_template`, the setup platforms' `persistent_notification.create` and every `vacuum.send_command` template are called for real (on the demo vacuum), and a template error rejects instead of hanging. |
| `stale-rooms.spec.ts` | The fixture renumbers its segments while keeping the geometry: the card marks the configured rooms stale, warns with their ids, refuses to select them, and still selects the new live id. |
| `run-lifecycle.spec.ts` | Against a fake vacuum that reports late, plans its own route, ignores a command while heading home, docks, fails a call and goes unavailable: the run is on the map from Start, the play icon is hidden while the start is pending, rooms lock only once the start is reported, the run ends when the vacuum docks, a failed call gives the selection back, `unavailable` keeps the run without locking, a stale `returning` is not taken as the start, a second tab shows the run, and the card does not number rooms for a vacuum that ignores the order. |

## What it does not cover

- HACS itself: Home Assistant 2026.11 blocks the HACS custom integration and ships the Marketplace.
  The card's `hacs.json` metadata is unchanged and the HACS action in CI still validates it, but the
  HACS UI install can only be exercised on an older Home Assistant release.
- Hardware-specific behaviour: the Roborock status/battery templates need the integration's
  runtime registry, and vendor service semantics need the device. Those stay postponed.
- Real phone scrolling and a real drag-resize: the resize uses the grid options the handle writes,
  and the hidden-tab check overrides `document.hidden` rather than moving the page to a background
  window. Both are documented limitations of a headless run.
- Two worktrees side by side by default: the container name and port can be overridden with
  `E2E_CONTAINER` and `E2E_HA_PORT`, but `connect-github.cjs --restart` still targets the default
  compose project unless `COMPOSE_PROJECT_NAME` is set.

## Install path

Home Assistant 2026.11 ships the core **marketplace** integration and blocks the `hacs` custom
integration (`loader.py`: built into Home Assistant as the Marketplace); upgrading migrates an
existing HACS install. `marketplace-install.cjs` therefore installs from the repository URL through
Marketplace, and `install-local-build.cjs` then overlays the branch build so the behaviour specs test
the pull request rather than the last release (it also removes the installer's stale `.gz`/`.br`
siblings, which Home Assistant would otherwise serve instead).

## Running it

```sh
npm run build
docker compose -f test/e2e/compose.yaml up -d      # Home Assistant 2026.11.0 on :8123
node test/e2e/setup.cjs                            # onboarding + storage dashboards
node test/e2e/connect-github.cjs --restart         # Marketplace GitHub token (GITHUB_TOKEN or gh auth)
node test/e2e/marketplace-install.cjs              # install from the repository URL (proves the path)
node test/e2e/install-local-build.cjs              # put this checkout's build in front of the specs
npm run test:e2e
```

Screenshots are written to `test/e2e/artifacts/` (gitignored); attach the relevant ones to a pull
request or release when a behaviour changes.

## Fixture camera

`test/e2e/ha/config/custom_components/map_fixture` is a test-only integration: it serves the
committed synthetic map through `/api/map_fixture/image`, counts every request, exposes the room
metadata the card reads, and offers `map_fixture.bump` (a new map, like an integration would push)
and `map_fixture.set_image`. It is never part of the released card.

The same integration provides `vacuum.fake_vacuum` (`map_fixture/vacuum.py`), a vacuum that behaves
the way real ones misbehave: it reports each change `lag` seconds late (a polling integration such
as xiaomi_miot lags ~30 s), cleans a multi-room `app_segment_clean` in its own order (recorded in
`cleaned_rooms`), ignores a command while returning, docks after a job, and can fail the next call
or go unavailable. `map_fixture.vacuum_configure` sets `lag`, `room_seconds`, `return_seconds`,
`fail_next` and `available`; `map_fixture.vacuum_reset` puts it into an activity at once.

`connect-github.cjs` writes the token into the ignored Home Assistant state file
(`test/e2e/ha/config/.storage`), because the Marketplace device flow cannot run headless. Nothing
under `.storage`, `.auth` or `artifacts` is committed.
