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
import { useAccountId } from "../../context/account-feature-context";
import { useChatNavigation } from "../../routing/chat-navigation";
import { ChatDeletes } from "./chat-deletes";

const ChatDeletesContext = createContext<ChatDeletes | null>(null);

/** One project's chat deletes; mount it keyed by the project, so leaving the project ends them. */
export function ChatDeleteProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const accountId = useAccountId();
  const navigation = useChatNavigation();
  const latest = useRef(navigation);
  latest.current = navigation;
  const [deletes] = useState(
    () => new ChatDeletes({ client, accountId, projectId, navigation: () => latest.current }),
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
