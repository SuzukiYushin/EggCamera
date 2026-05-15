import { createContext, useContext, useState, type ReactNode } from 'react';
import { translations, type Lang } from './i18n';

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  T: typeof translations.ja;
}

const LangContext = createContext<LangCtx>({
  lang: 'ja',
  setLang: () => {},
  T: translations.ja,
});

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>('ja');
  return (
    <LangContext.Provider value={{ lang, setLang, T: translations[lang] as typeof translations.ja }}>
      {children}
    </LangContext.Provider>
  );
}

export const useLang = () => useContext(LangContext);
