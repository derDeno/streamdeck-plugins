import german from "../de.pandaboards.pandadesk.sdPlugin/de.json" with { type: "json" };

let language: "de" | "en" = "en";
const translations: Record<string, string> = german.Localization;

export function setLanguage(value: unknown): "de" | "en" {
  language = typeof value === "string" && /^de(?:[-_]|$)/i.test(value.trim()) ? "de" : "en";
  return language;
}

export function t(message: string, values: Record<string, string | number> = {}): string {
  const template = language === "de" ? translations[message] ?? message : message;
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => String(values[key] ?? placeholder));
}

export function formatNumber(value: number, decimals?: number): string {
  const number = decimals === undefined ? String(value) : value.toFixed(decimals);
  return language === "de" ? number.replace(".", ",") : number;
}
