import type { HandlerMap } from "../../jobs";
import { DISPATCH_EVENT } from "./bus";

/**
 * Handlers for the `events` queue. dispatch_event has no subscribers yet;
 * webhook fan-out plugs in here when webhook endpoints are added.
 */
export function eventJobHandlers(): HandlerMap {
  return {
    [DISPATCH_EVENT]: async () => {},
  };
}
