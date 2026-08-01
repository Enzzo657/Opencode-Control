import { describe, expect, it } from "vitest";
import { catalogs, createTranslator, detectLocale, en, ru } from "../i18n";

describe("typed translation catalog", () => {
  it("keeps complete key parity between locales", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort());
    expect(Object.keys(catalogs.en)).toHaveLength(Object.keys(catalogs.ru).length);
  });

  it("renders copy and placeholders in both locales", () => {
    expect(createTranslator("ru")("dashboard.projectScope", { project: "Control" })).toBe(
      "Проект · Control",
    );
    expect(createTranslator("en")("dashboard.projectScope", { project: "Control" })).toBe(
      "Project · Control",
    );
  });

  it("falls back to English for unsupported browser languages", () => {
    expect(detectLocale({ getItem: () => null }, ["de-DE", "fr"])).toBe("en");
  });

  it("detects Russian and gives persisted locale priority", () => {
    expect(detectLocale({ getItem: () => null }, ["uk", "ru-RU", "en"])).toBe("ru");
    expect(detectLocale({ getItem: () => "en" }, ["ru-RU"])).toBe("en");
  });
});
