"""A fake vacuum that misbehaves the way real integrations and robots do.

It exists only for `test/e2e` and is never part of the released card. Each behaviour is one that a
real setup showed and that the card has to survive:

- State is reported late (`lag` seconds, ~30 s on a polling integration such as xiaomi_miot): the
  state Home Assistant shows is a snapshot of what the robot did `lag` seconds ago.
- A multi-room command is cleaned in the robot's own order (sorted ids), not the order sent, like
  the Viomi V8 with `set_mode_withroom`. `cleaned_rooms` records the real order.
- A command sent while the robot heads home is ignored.
- After a job the robot returns and docks.
- `fail_next` makes the next command raise, like a device that does not answer.
- `available: false` makes the entity unavailable, like a polling integration losing the device.
"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.vacuum import StateVacuumEntity, VacuumActivity, VacuumEntityFeature
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.typing import ConfigType, DiscoveryInfoType

from . import FIXTURE_ROOMS

_LOGGER = logging.getLogger(__name__)

DATA_VACUUMS = "map_fixture_vacuums"


async def async_setup_platform(
    hass: HomeAssistant,
    config: ConfigType,
    async_add_entities: AddEntitiesCallback,
    discovery_info: DiscoveryInfoType | None = None,
) -> None:
    """Set up the fake vacuum."""
    entity = FakeVacuum(hass, name=config.get("name", "Fake Vacuum"))
    hass.data.setdefault(DATA_VACUUMS, []).append(entity)
    async_add_entities([entity])


class FakeVacuum(StateVacuumEntity):
    """The robot's true activity runs on timers; Home Assistant sees it `lag` seconds late."""

    _attr_should_poll = False
    _attr_supported_features = (
        VacuumEntityFeature.START
        | VacuumEntityFeature.PAUSE
        | VacuumEntityFeature.STOP
        | VacuumEntityFeature.RETURN_HOME
        | VacuumEntityFeature.SEND_COMMAND
        | VacuumEntityFeature.STATE
    )

    def __init__(self, hass: HomeAssistant, name: str) -> None:
        self.hass = hass
        self._attr_name = name
        self._attr_unique_id = "map_fixture_fake_vacuum"
        self.lag = 0.0
        self.room_seconds = 4.0
        self.return_seconds = 3.0
        self.fail_next = False
        self._true_activity = VacuumActivity.DOCKED
        self._job: list[str] = []
        self._cleaned: list[str] = []
        self._current_room: str | None = None
        self._job_timer: Any = None
        self._reported: dict[str, Any] = self._snapshot()
        self._available = True
        self._sequence = 0

    # Configuration from the `map_fixture.vacuum_configure` service.
    def configure(self, data: dict[str, Any]) -> None:
        for key in ("lag", "room_seconds", "return_seconds"):
            if key in data:
                setattr(self, key, float(data[key]))
        if "fail_next" in data:
            self.fail_next = bool(data["fail_next"])
        if "available" in data:
            self._available = bool(data["available"])
            self.async_write_ha_state()

    def reset(self, activity: str = "docked") -> None:
        """Put robot and reported state into `activity` at once, for a clean test start."""
        self._cancel_job()
        self._job, self._cleaned, self._current_room = [], [], None
        self._true_activity = VacuumActivity(activity)
        self._reported = self._snapshot()
        self._available = True
        self.fail_next = False
        self.async_write_ha_state()

    @property
    def available(self) -> bool:
        return self._available

    @property
    def activity(self) -> VacuumActivity | None:
        return self._reported["activity"]

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {key: value for key, value in self._reported.items() if key != "activity"}

    def _snapshot(self) -> dict[str, Any]:
        return {
            "activity": self._true_activity,
            "current_room": self._current_room,
            "cleaned_rooms": list(self._cleaned),
            "job_rooms": list(self._job),
        }

    @callback
    def _changed(self) -> None:
        """The robot changed; Home Assistant learns about it `lag` seconds later."""
        snapshot = self._snapshot()
        self._sequence += 1

        @callback
        def publish(_now: Any = None) -> None:
            self._reported = snapshot
            self.async_write_ha_state()

        if self.lag <= 0:
            publish()
        else:
            async_call_later(self.hass, self.lag, publish)

    def _cancel_job(self) -> None:
        if self._job_timer is not None:
            self._job_timer()
            self._job_timer = None

    @callback
    def _schedule(self, seconds: float, step: Any) -> None:
        self._cancel_job()
        self._job_timer = async_call_later(self.hass, seconds, step)

    @callback
    def _start_job(self, rooms: list[str]) -> None:
        # The robot plans its own route: it cleans the rooms in id order, whatever order was sent.
        self._job = sorted(rooms, key=lambda room: (len(room), room))
        self._cleaned = []
        self._current_room = None
        self._next_room()

    @callback
    def _next_room(self, _now: Any = None) -> None:
        remaining = [room for room in self._job if room not in self._cleaned]
        if self._current_room is not None and self._current_room not in self._cleaned:
            self._cleaned.append(self._current_room)
            remaining = [room for room in self._job if room not in self._cleaned]
        if not remaining:
            self._current_room = None
            self._true_activity = VacuumActivity.RETURNING
            self._changed()
            self._schedule(self.return_seconds, self._dock)
            return
        self._current_room = remaining[0]
        self._true_activity = VacuumActivity.CLEANING
        self._changed()
        self._schedule(self.room_seconds, self._next_room)

    @callback
    def _dock(self, _now: Any = None) -> None:
        self._job_timer = None
        self._true_activity = VacuumActivity.DOCKED
        self._changed()

    def _check_fail(self) -> None:
        if self.fail_next:
            self.fail_next = False
            raise HomeAssistantError("Fake vacuum did not answer")

    async def async_send_command(self, command: str, params: Any = None, **kwargs: Any) -> None:
        self._check_fail()
        if command not in ("app_segment_clean", "clean_rooms"):
            raise HomeAssistantError(f"Unknown command: {command}")
        if self._true_activity == VacuumActivity.RETURNING:
            _LOGGER.info("fake vacuum ignores %s while returning", command)
            return
        rooms = params if isinstance(params, list) else [params]
        self._start_job([str(room) for room in rooms if str(room) in FIXTURE_ROOMS])

    async def async_start(self) -> None:
        self._check_fail()
        if self._true_activity == VacuumActivity.RETURNING:
            return
        if self._true_activity == VacuumActivity.PAUSED and self._job:
            self._true_activity = VacuumActivity.CLEANING
            self._changed()
            self._schedule(self.room_seconds, self._next_room)
            return
        self._start_job(list(FIXTURE_ROOMS))

    async def async_pause(self) -> None:
        self._check_fail()
        if self._true_activity == VacuumActivity.CLEANING:
            self._cancel_job()
            self._true_activity = VacuumActivity.PAUSED
            self._changed()

    async def async_stop(self, **kwargs: Any) -> None:
        self._check_fail()
        self._cancel_job()
        self._job, self._current_room = [], None
        self._true_activity = VacuumActivity.IDLE
        self._changed()

    async def async_return_to_base(self, **kwargs: Any) -> None:
        self._check_fail()
        self._job, self._current_room = [], None
        self._true_activity = VacuumActivity.RETURNING
        self._changed()
        self._schedule(self.return_seconds, self._dock)
