type WsSendPayload = string | Uint8Array;

type WsSendPeer<TPayload extends WsSendPayload = WsSendPayload> = {
  send: (data: TPayload) => void;
  close: (code?: number, reason?: string) => void;
};

type SafeWsSendOptions = {
  onFailure?: () => void;
  closeCode?: number;
  closeReason?: string;
  logPrefix?: string;
};

const loggedSendFailures = new WeakSet<object>();

export function safeWsSend<TPayload extends WsSendPayload>(
  peer: WsSendPeer<TPayload>,
  payload: TPayload,
  options: SafeWsSendOptions = {},
): boolean {
  try {
    peer.send(payload);
    return true;
  } catch (error) {
    if (!loggedSendFailures.has(peer)) {
      loggedSendFailures.add(peer);
      console.error(`${options.logPrefix ?? "ws"}: send failed`, error);
    }

    try {
      peer.close(options.closeCode ?? 1011, options.closeReason ?? "send_failed");
    } catch {
      // ignore
    }

    try {
      options.onFailure?.();
    } catch {
      // ignore
    }
    return false;
  }
}
