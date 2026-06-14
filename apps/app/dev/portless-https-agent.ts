import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";

const PORTLESS_CA_PATH = path.join(os.homedir(), ".portless", "ca.pem");

export function createPortlessHttpsAgent(): https.Agent | undefined {
  if (!fs.existsSync(PORTLESS_CA_PATH)) {
    return undefined;
  }
  const ca = fs.readFileSync(PORTLESS_CA_PATH, "utf8");
  return new https.Agent({ ca: [...tls.rootCertificates, ca] });
}
