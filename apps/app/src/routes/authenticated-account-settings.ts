/** Bounded auxiliary account-settings read for the authenticated route loader. */
import type { AccountSettings } from "@meridian/contracts/protocol";

export async function loadAccountSettingsWithDeadline(
  load: (signal: AbortSignal) => Promise<AccountSettings>,
  timeoutMs = 2_000,
): Promise<AccountSettings | null> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`Account settings request exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return await Promise.race([load(controller.signal), deadline]);
  } catch (error) {
    console.error("Failed to load account settings during SSR:", error);
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
