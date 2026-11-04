# streamdeck-plugins
Collection of my custom Elgato Stream Deck plugins

## Builds and releases

Each plugin has its own workflow in `.github/workflows/`, filtered to its project
folder and workflow file. Updating one plugin builds only that plugin. A commit
touching multiple plugin folders runs each affected plugin's workflow.

| Plugin | Folder | Workflow |
| --- | --- | --- |
| PandaDesk | [`pandadesk/`](pandadesk/) | [`build-pandadesk-streamdeck.yaml`](.github/workflows/build-pandadesk-streamdeck.yaml) |

Pushes and pull requests build, test, validate, and upload the plugin installer
as an artifact. Successful pushes to `main` also publish it to
[GitHub Releases](https://github.com/derDeno/streamdeck-plugins/releases).
**Run workflow** builds the selected plugin; selecting `main` also publishes it.

Release titles use the plugin manifest's `Name` and `Version`, for example
`PandaDesk v1.1.1.0`. Tags include the project folder, for example
`pandadesk/v1.1.1.0`, so plugin versions remain independent. An existing release
is preserved: bump the manifest's `Version` before publishing a new version.
Keep the project's `package.json` and lockfile versions aligned: npm version
`1.1.1` corresponds to manifest version `1.1.1.0`.

When adding a plugin, copy an existing workflow and update its name, folder
filters, working directory, lockfile and manifest paths, artifact name, release
tag prefix, and concurrency group. Keep its build commands in the plugin's own
`package.json` (`npm test` and `npm run pack`). The workflow uses the built-in
`GITHUB_TOKEN`; no additional secrets are required.
