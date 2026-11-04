# PandaDesk Stream Deck Plugin

PandaDesk Stream Deck is a production-ready Windows plugin for controlling your
height-adjustable desk directly through PandaDesk. Version **1.1.1** supports
everyday desk control, live feedback, sitting/standing positions, and controller
child lock. It has been tested with real PandaDesk hardware.

Communication stays on your local network. No Home Assistant, MQTT broker, cloud
account, or separate background service is required.

The plugin follows the Stream Deck application language: **German for German**
and **English for every other language**. Action names, tooltips, settings,
key feedback, error messages, and decimal formatting follow this choice.
Existing board addresses, target heights, and controller settings are preserved.

## Requirements

- Windows 10 or later.
- Elgato Stream Deck software 7.1 or later and a compatible Stream Deck key device.
- A configured PandaDesk board reachable from the PC by IP address or hostname.
- PandaDesk firmware exposing the HTTP API v1. Available actions depend on the
  capabilities reported by the selected desk profile.

Node.js is supplied by Stream Deck; end users do not need to install it separately.
This plugin supports Windows and key actions. USB connections, automatic board
discovery, and Stream Deck dial actions are not supported.

## Installation

Search for **PandaDesk** in the **Elgato Marketplace** and install it through
Stream Deck. The direct Marketplace link will be added here later.

<!-- Add the PandaDesk Elgato Marketplace listing URL here when available. -->

To install a package produced by a [local build](#local-development):

1. Double-click `de.pandaboards.pandadesk.streamDeckPlugin` and follow the Stream
   Deck installation prompt.
2. Find **PandaDesk** in Stream Deck's action list and drag the desired actions
   onto your keys.

To update, install the newer package using the same procedure.

## Connect your board

Select any PandaDesk key, enter the board's address in **Board address**
(**Board-Adresse**), and click **Save** (**Speichern**). For example, use `http://pandadesk.local`, the board's fallback
hostname, or its IP address.

The address is shared across all PandaDesk keys and profiles, including keys you
add later. Changing it on one key updates the whole plugin. Target heights and
child-lock modes and preset slots are saved separately
for each key.

Leave Stream Deck's custom title field empty to see live height/status text. Add a
dedicated **Stop** key alongside your movement and target-height keys.

## Actions

| Action | What it does |
| --- | --- |
| **Up · hold / Hoch · gedrückt halten** | Moves up while held. Releasing the key sends stop. |
| **Down · hold / Runter · gedrückt halten** | Moves down while held. Releasing the key sends stop. |
| **Stop / Stopp** | Stops movement and cancels held-key repetition. |
| **Target height · Sit / Stand / Zielhöhe · Sitzen / Stehen** | Moves to a configured height in cm. The movement continues after releasing the key. |
| **Child lock / Kindersicherung** | Locks, unlocks, or toggles the controller child lock. The icon shows its reported state. |
| **Preset · Recall / Preset · Abrufen** | Recalls the selected desk memory 1–4 on key press. |
| **Height & status / Höhe & Status** | Displays measured height and movement status. Pressing refreshes the display. |

### Sitting and standing positions

Add a **Target height** (**Zielhöhe**) key for each position. The settings panel queries PandaDesk and
displays its configured minimum and maximum heights. Enter a value such as `72,0`
or `110.5` and click **Save**.

The plugin checks the current limits when saving and again before sending a
target-height command. Values outside that range are rejected. These limits come
from the board's configuration. If the selected desk profile does not support
target heights, the key is marked **Not supported** (**Nicht unterstützt**) and its height field is
disabled. If limits cannot be read, saving a target height is blocked.

### Saved desk presets

Add **Preset · Recall** (**Preset · Abrufen**), select a slot from **1–4**, and
click **Save** to assign it to the key. Pressing the key sends the desk's native
memory recall command. Use a separate key for each preset you want to recall,
and keep a **Stop** key available. The plugin only recalls existing presets;
it does not create or overwrite desk memories.

The key displays the controller-reported saved height. Recall checks PandaDesk's
current height limits; empty, unreadable, and out-of-range memories are blocked.
A reported child lock blocks recall. The desk retains its own memory movement
mode. Existing recall keys keep working. Keys previously configured to save a
preset are blocked until you open their settings and save the preset selection
again, explicitly configuring them for recall.

Presets require updated firmware exposing `capabilities.presets`, the four-entry
`state.presets` array (heights in cm, `null` when unavailable), and
`POST /api/v1/commands/preset`. Support currently requires Jiecang RJ12 memory
reports; older firmware and other profiles show **Not supported**. Preset
recall has automated coverage but still requires testing on your desk.

### Child lock

Add **Child lock** (**Kindersicherung**) and select its mode:

- **Lock (Sperren):** requests the locked state.
- **Unlock (Entsperren):** requests the unlocked state.
- **Toggle (Umschalten):** reads the current controller state and requests its inverse.

The icon follows the controller's reported state. Commands require confirmation
from the board; an unknown state is never guessed for Toggle. While a lock change
is pending, additional lock presses show an alert instead of queuing changes.
**Stop** remains available during confirmation.

Child lock requires firmware reporting `capabilities.child_lock` and `state.locked`,
with the `/api/v1/commands/child-lock` endpoint. Unsupported profiles or older
firmware show **Not supported** (**Nicht unterstützt**).

## Status and troubleshooting

| Display | Meaning and next step |
| --- | --- |
| **Set up / Einrichten** | Enter and save a valid board address. |
| **Offline** | Check board power, address, network access, and firmware API availability. |
| **Not ready / Nicht bereit** | Configure or check the selected desk profile on the board. |
| **Not supported / Nicht unterstützt** | The selected profile does not provide this action. |
| **State unknown / Status unbekannt** | The controller has not supplied a usable lock state; Toggle is blocked. |
| **Please wait / Bitte warten** | A child-lock command is awaiting confirmation. |
| Alert triangle | The command failed. Details are recorded in `logs/plugin.log` inside the installed plugin folder. |

Visible keys share a state/capabilities poll roughly once per second after the
previous poll finishes. Up/down requests have a 750 ms duration in the firmware
and are renewed while held. Release, page changes, address changes, and connection
loss cancel renewal and attempt to send stop. Network, queue, and wake delays
affect when a stop reaches the controller. Target-height movements continue to
their target unless stopped.

When upgrading from the initial per-key-address version, the first valid address
on a visible legacy key is adopted if no shared address exists. A saved shared
address takes precedence over legacy settings.

## GitHub Actions builds

The build workflow is `build-pandadesk-streamdeck.yaml`.
It runs for pushes and pull requests affecting this plugin or the workflow, and
can also be started manually with **Run workflow**.

Each build uses a Windows runner and Node.js 24 to:

1. Install the locked dependencies with `npm ci`.
2. Compile TypeScript and run the automated tests with `npm test`.
3. Build, validate with Elgato's CLI, and package the installer with `npm run pack`.
4. Upload `de.pandaboards.pandadesk.streamDeckPlugin` as a downloadable artifact.

Artifacts are retained for 30 days. The workflow requires no project secrets and
does not publish to the Elgato Marketplace or create GitHub releases.

## Local development

Use Node.js 24 or later. From the plugin directory containing `package.json`:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run pack
```

The installer is written to
`dist/de.pandaboards.pandadesk.streamDeckPlugin`. `npm run pack` includes Elgato
validation; `npm run validate` runs validation separately after building.

Tests run the compiled plugin against simulated Stream Deck and PandaDesk servers.
They cover movement/stop ordering, shared settings, capability checks, height
limits, lock modes and confirmation, and connection recovery without moving a desk.

To work against the desk simulator, run `npm.cmd run mock` and temporarily set the
shared address to `http://127.0.0.1:18787`. It starts at 72 cm with limits of
60–125 cm. For a different port, use `npm.cmd run mock -- 18788`.

For live plugin development:

```powershell
npx.cmd streamdeck dev
npx.cmd streamdeck link de.pandaboards.pandadesk.sdPlugin
npx.cmd streamdeck restart de.pandaboards.pandadesk
```

Restart Stream Deck once if it was already running when you first linked the
plugin. Rebuild before restarting the plugin after code changes.

The runtime uses Node.js built-ins and the official
[Stream Deck WebSocket protocol](https://docs.elgato.com/streamdeck/sdk/references/websocket/plugin/).
The settings panel is bundled locally.

## License

The [PandaDesk project license](../README.md#license) applies to this plugin.
