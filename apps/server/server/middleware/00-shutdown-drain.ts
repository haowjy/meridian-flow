/** Rejects requests srvx accepted just before it began closing the listener. */
import { defineEventHandler, setResponseHeader, setResponseStatus } from "nitro/h3";
import { isHttpRequestAdmissionStopped, isHttpRequestAdmitted } from "../lib/http-drain.js";

export default defineEventHandler((event) => {
  if (!isHttpRequestAdmissionStopped() || isHttpRequestAdmitted(event)) return;

  setResponseStatus(event, 503);
  setResponseHeader(event, "connection", "close");
  return { error: "server_restarting" };
});
