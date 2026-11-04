import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const plugin = "de.pandaboards.pandadesk.sdPlugin";

test("German is selected only for German locales; all other languages use English", async () => {
  const context = {};
  runInNewContext(await readFile(`${plugin}/ui/i18n.js`, "utf8"), context);
  const { setLanguage, t, formatNumber } = context.PandaDeskI18n;
  for (const language of ["de", "de-DE", "de_AT", "DE"]) {
    assert.equal(setLanguage(language), "de");
    assert.equal(t("Saved."), "Gespeichert.");
    assert.equal(formatNumber(78.3, 1), "78,3");
    assert.equal(t("Allowed height range: {min}–{max} cm.", { min: "65", max: "120" }), "Erlaubter Höhenbereich: 65–120 cm.");
  }
  for (const language of ["en", "fr", "ja", "es", "zh_CN", "dev", undefined, null, ""]) {
    assert.equal(setLanguage(language), "en");
    assert.equal(t("Saved."), "Saved.");
    assert.equal(formatNumber(78.3, 1), "78.3");
  }
});

test("native German action localizations cover every action and preserve message placeholders", async () => {
  const manifest = JSON.parse(await readFile(`${plugin}/manifest.json`, "utf8"));
  const german = JSON.parse(await readFile(`${plugin}/de.json`, "utf8"));
  for (const action of manifest.Actions) {
    assert.ok(german[action.UUID]?.Name, `Missing German name for ${action.UUID}`);
    assert.ok(german[action.UUID]?.Tooltip, `Missing German tooltip for ${action.UUID}`);
  }
  assert.equal(manifest.Actions.find((a) => a.UUID.endsWith(".up")).Name, "Up · hold");
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [english, translated] of Object.entries(german.Localization)) {
    assert.deepEqual(placeholders(translated), placeholders(english), `Placeholders differ: ${english}`);
  }
});
