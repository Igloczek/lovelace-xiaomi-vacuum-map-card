# Supported vacuum platforms

*Better Xiaomi Vacuum Map Card* carries the upstream platform templates with two fixes: duration
tiles convert from the unit the sensor reports, and the Deebot total cleaning time has its own
`tile_id` (`total_cleaning_time`) so it is no longer dropped. A platform page lists the templates it
provides, the entities the card discovers and the service calls it uses. Set the platform in a
preset with `vacuum_platform` and leave everything else as the page shows.

## Supported vacuum platforms

Following vacuum platforms are supported out of the box at this moment:

- [`Xiaomi Miio`](templates/xiaomiMiio.md)
- [`Roborock`](templates/Roborock.md)
- [`humbertogontijo/homeassistant-roborock`](templates/humbertogontijoHomeassistantRoborock.md)
- [`Tasshack/dreame-vacuum`](templates/tasshackDreameVacuum.md)
- [`rand256/ValetudoRE`](templates/rand256ValetudoRe.md)
- [`Hypfer/Valetudo`](templates/hypferValetudo.md)
- [`marotoweb/viomi SE`](templates/marotowebViomise.md)
- [`tykarol/ViomiVacuumV8`](templates/tykarolViomiVacuumV8.md)
- [`KrzysztofHajdamowicz/miio2`](templates/krzysztofHajdamowiczMiio2.md)
- [`send_command`](templates/sendCommand.md)
- [`al-one/Xiaomi MIoT`](templates/alOneHassXiaomiMiot.md) (additional manual configuration required)
- [`Neato`](templates/neato.md)
- [`Roomba`](templates/roomba.md)
- [`DeebotUniverse/Deebot-4-Home-Assistant`](templates/DeebotUniverseDeebot4homeAssistant.md)
- [`romedtino/simple-wyze-vac`](templates/romedtinoSimpleWyze.md)
- [`BenjaminPaap/home-assistant-myneato`](templates/BenjaminPaapMyNeato.md)
- [`CoderAS-ru/hass-neatsvor`](templates/CoderASruNeatsvor.md)
- [`johnnyh1975/ha_roomba_plus`](templates/johnnyh1975RoombaPlus.md)

## Platform detection

A card added from the card picker takes its `vacuum_platform` from the vacuum's integration:

| Integration       | `vacuum_platform`                        |
|-------------------|------------------------------------------|
| `xiaomi_miio`     | `Xiaomi Miio`                            |
| `roborock`        | `Roborock`                               |
| `dreame_vacuum`   | `Tasshack/dreame-vacuum`                 |
| `xiaomi_miot`     | `al-one/hass-xiaomi-miot`                |
| `neato`           | `Neato`                                  |
| `roomba`          | `Roomba`                                 |
| `deebot`          | `DeebotUniverse/Deebot-4-Home-Assistant` |

The `roborock` domain is used both by the core Roborock integration and by the older custom
`humbertogontijo/homeassistant-roborock` integration, and Home Assistant does not tell them apart;
the card picks the core `Roborock` template, so a user of the custom integration switches the
platform in the editor. Any other integration, including Valetudo over MQTT, gets `Xiaomi Miio` as
before; change it in the editor. The setting is only a starting point and is written into the card's configuration.

## Cleaning order per platform

The card numbers the selected rooms in the order you tap them on every platform, and sends them in
that order. Whether the vacuum cleans them in that order depends on what the integration sends:

| Template | Follows the order | Why |
|---|---|---|
| `rand256/ValetudoRE` segments | yes | `segmented_cleanup` sends Roborock's `clean_order_mode: 1` |
| `Hypfer/Valetudo` | yes | Sends `customOrder: true`; Valetudo follows it on Roborock and Dreame robots, not on Viomi or Midea |
| `johnnyh1975/ha_roomba_plus` clean room | yes | Sends `ordered: true` |
| `Xiaomi Miio`, `Roborock`, `send_command`, `humbertogontijo/homeassistant-roborock` | no | `app_segment_clean` without `clean_order_mode`: the robot plans its own route |
| `Tasshack/dreame-vacuum` | no | Newer models clean in the sequence stored on the robot, not the order sent |
| `marotoweb/viomi SE`, `tykarol/ViomiVacuumV8`, `KrzysztofHajdamowicz/miio2` | no | Viomi has no order field; the V8 cleans in its own order |
| `romedtino/simple-wyze-vac` | no | The integration sorts the rooms into map order |
| `DeebotUniverse/Deebot-4-Home-Assistant`, `Roomba`, `Neato`, `BenjaminPaap/home-assistant-myneato` | unknown | No evidence either way (Roomba core omits iRobot's `ordered`) |
| `al-one/Xiaomi MIoT`, ValetudoRE go-to | n/a | One room per call |

[Adding a new platform](../CONTRIBUTING.md#adding-new-platform). Platform templates are shared with
upstream, so platform requests go to the
[upstream tracker](https://github.com/PiotrMachowski/lovelace-xiaomi-vacuum-map-card/issues/new?labels=new+platform&template=new_platform_request.yml).

## Getting coordinates

Setup platforms make it easier to retrieve vacuum coordinates for zones, points and room outlines
without a separate coordinate tool. The [setup platforms guide](templates/setup.md#getting-coordinates)
walks through the editor picker and the copy button.

The platform pages themselves are unchanged from upstream. A template is only claimed as tested
when a fixture or a real instance backs it; see [how work is planned and
verified](../ROADMAP.md#how-to-propose-work) for what that means for hardware-specific features.
