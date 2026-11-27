import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useAccountId } from "@/client/account/account-context";
import { useCommandDriver } from "@/client/commands/driver-context";
import { useThreadActions } from "@/client/stores";
import { useChatNavigation } from "../../routing/chat-navigation";
import { ChatDeletes } from "./chat-deletes";

const ChatDeletesContext = createContext<ChatDeletes | null>(null);

export function ChatDeleteProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const accountId = useAccountId();
  const driver = useCommandDriver();
  const navigation = useChatNavigation();
  const actions = useThreadActions();
  const latest = useRef({ navigation, driver, actions });
  latest.current = { navigation, driver, actions };
  const [deletes] = useState(
    () =>
      new ChatDeletes({
        client,
        accountId,
        projectId,
        driver: () => latest.current.driver,
        actions: () => latest.current.actions,
        navigation: () => latest.current.navigation,
      }),
  );
  useEffect(() => {
    deletes.open();
    return () => deletes.close();
  }, [deletes]);
  return <ChatDeletesContext.Provider value={deletes}>{children}</ChatDeletesContext.Provider>;
}

export function useChatDeletes(): ChatDeletes {
  const deletes = useContext(ChatDeletesContext);
  if (!deletes) throw new Error("Chat deletes need a project");
  return deletes;
}

export function useChatDeleteState() {
  const deletes = useChatDeletes();
  const notice = useSyncExternalStore(deletes.subscribe, deletes.notice, () => null);
  const refused = useSyncExternalStore(deletes.subscribe, deletes.refused, () => null);
  return { deletes, notice, refused };
}
