/** Test-environment repairs that must run before any suite touches the DOM. */
import { installJsdomLayoutFallbacks } from "./src/test-support/jsdom-layout";

installJsdomLayoutFallbacks();
