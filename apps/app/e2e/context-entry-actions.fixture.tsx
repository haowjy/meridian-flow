import { setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { createRoot } from "react-dom/client";

import { ContextEntryMenu } from "@/features/project/context/ContextEntryActions";
import { messages } from "@/locales/en/messages";

const i18n = setupI18n({ locale: "en", messages: { en: messages } });

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <I18nProvider i18n={i18n}>
    <ContextEntryMenu
      allowCreate
      onAction={(action) => {
        (window as Window & { selectedAction?: string }).selectedAction = action;
      }}
    >
      <button type="button">Chapter one</button>
    </ContextEntryMenu>
  </I18nProvider>,
);
