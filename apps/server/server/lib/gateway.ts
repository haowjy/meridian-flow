import { createGatewayFromEnv, type Gateway } from "../domains/runtime/index.js";

let gatewayPromise: Promise<Gateway> | undefined;

export async function getModelGateway(): Promise<Gateway> {
  if (!gatewayPromise) {
    gatewayPromise = createGatewayFromEnv(process.env).then(({ gateway }) => gateway);
  }
  return gatewayPromise;
}
