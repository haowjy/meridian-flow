/** Deletes an uninformed resurrection as a fresh human-origin forward mutation. */
import { defineEventHandler } from "nitro/h3";
import { applyForwardAction } from "../_forward-action.js";

export default defineEventHandler((event) => applyForwardAction(event, "delete-again"));
