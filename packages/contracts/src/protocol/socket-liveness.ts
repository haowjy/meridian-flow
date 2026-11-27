/**
 * Liveness for the app's sockets (the thread socket and every room socket): the server sends a
 * ping every interval, and a client that hears nothing for the timeout replaces the socket. A
 * half-open connection never closes on its own.
 */
export const SOCKET_PING_INTERVAL_MS = 30_000;
export const SOCKET_PING_TIMEOUT_MS = 45_000;
