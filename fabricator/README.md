# Fabricator for Stream Deck

Monitor and control a Minecraft server managed by [Fabricator](https://fabricator.site/). The plugin requires Stream Deck 7.1 or newer on Windows 10+ or macOS 13+. It targets the [Fabricator 1.7.0 API](https://github.com/philderks/Fabricator/blob/v1.7.0/API_DOCS.md).

## Setup

1. Install `de.derdeno.fabricator.streamDeckPlugin` and drag any Fabricator action onto a key.
2. Under **Fabricator Server Settings**, enter the panel address, such as `http://192.168.1.10:5000` or `https://minecraft.example.com`. A bare IP address or hostname uses HTTP on port 5000. Use HTTPS when connecting across an untrusted network.
3. Enter the Fabricator operator password. Leave the field blank if your panel has authentication disabled.
4. Click **Load servers**, select your Minecraft server, then click **Save**. You can also enter the Fabricator server ID shown in the panel URL, such as `srv_1234abcd`.

Stream Deck saves the address, password and server ID in its local global settings. The section opens collapsed once a panel address and server ID are saved. These settings apply to every Fabricator key, including keys on other profiles and devices in the same Stream Deck app. Changing the server switches all Fabricator keys to it.

## Keys

| Key | Behavior |
| --- | --- |
| Players Online | Shows the number of players connected. |
| Uptime | Shows how long the server has been running. |
| TPS | Shows ticks per second when Fabricator has a reading. |
| Server State | Shows the current state. The icon turns green when running and red when stopped. |
| CPU Usage | Shows Minecraft process CPU usage. Multicore usage can exceed 100%. |
| Heap Usage | Shows used JVM heap when Fabricator's `jcmd` probe can report it. |
| Start Server, Stop Server, Restart Server | Sends the corresponding action to Fabricator. The Server State key shows progress as Fabricator reports it. |
| Open Admin Panel | Opens the selected server's overview in your default browser. The browser uses its own Fabricator login. |
| Console Command | Sends the command saved above **Fabricator Server Settings** on this key. Add one key per command, for example `save-all` or `say Server restart in 5 minutes`. |

Visible metric keys refresh together about every five seconds. Press any metric key for an immediate refresh. `--` means that Fabricator has no reading for that metric. Keep the default Stream Deck title settings to see live values.

## Build locally

From the `fabricator` directory with Node.js 24 or newer:

```sh
npm ci
npm test
npm run validate
npm run pack
```

Double-click the `.streamDeckPlugin` file in `dist/` to install it.

## Icon credits

The plugin and action category icons use the [Fabricator logo](https://github.com/philderks/Fabricator/blob/v1.7.0/frontend/public/favicon.svg), copyright © 2026 Philipp Noél Derks and Linus Sommermeyer. The installer includes the original SVG and its [AGPL-3.0 license](de.derdeno.fabricator.sdPlugin/LICENSE.fabricator.txt). The Stream Deck variants were resized and the category icon was rendered in white.
