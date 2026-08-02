import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from "react";

import { en } from "./i18n/en";
import { ru } from "./i18n/ru";

export { en, ru };

export type Locale = "ru" | "en";
export type TranslationKey = keyof typeof ru;
export type TranslationCatalog = Record<TranslationKey, string>;

export const LOCALE_STORAGE_KEY = "control-locale";

export const catalogs: Record<Locale, TranslationCatalog> = { ru, en };

function commitLocale(locale: Locale) {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  document.documentElement.lang = locale;
}

export function detectLocale(storage: Pick<Storage, "getItem"> = window.localStorage, languages: readonly string[] = navigator.languages): Locale {
  const saved = storage.getItem(LOCALE_STORAGE_KEY);
  if (saved === "ru" || saved === "en") return saved;
  for (const language of languages) {
    const code = language.toLowerCase().split("-")[0];
    if (code === "ru" || code === "en") return code;
  }
  return "en";
}

export function createTranslator(locale: Locale) {
  return (key: TranslationKey, values: Record<string, string | number> = {}) =>
    Object.entries(values).reduce(
      (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
      catalogs[locale][key],
    );
}

export function getCurrentLocale() {
  return detectLocale();
}

export function translate(key: TranslationKey, values?: Record<string, string | number>) {
  return createTranslator(detectLocale())(key, values);
}

type I18nValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: ReturnType<typeof createTranslator>;
};

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => detectLocale());

  useEffect(() => {
    commitLocale(locale);
  }, [locale]);

  function setLocale(next: Locale) {
    commitLocale(next);
    setLocaleState(next);
  }

  return createElement(I18nContext.Provider, { value: { locale, setLocale, t: createTranslator(locale) } }, children);
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function intlLocale(locale: Locale = detectLocale()) {
  return locale === "ru" ? "ru-RU" : "en-US";
}

export function localizedStatus(value: string, locale: Locale = detectLocale()) {
  const key = `status.${value}` as TranslationKey;
  return key in catalogs[locale] ? catalogs[locale][key] : catalogs[locale]["status.unknown"];
}
