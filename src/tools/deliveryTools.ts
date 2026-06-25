import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "../api/client.js";
import { getDeliveryDays, reserveTimeslot } from "../api/delivery.js";
import { getTimeslotsShape, selectTimeslotShape } from "../types/schemas.js";
import { tool } from "./helpers.js";

export function registerDeliveryTools(server: McpServer, client: ApiClient): void {
  server.registerTool(
    "get_timeslots",
    {
      title: "Get delivery timeslots",
      description:
        "List bookable delivery timeslots for the coming days, grouped by day. Each slot has a " +
        "numeric `Id` (pass to select_timeslot), date, start/end hour, delivery price, order " +
        "deadline and an `Availability` code (0 = available, 1 = past deadline, 2 = sold out, " +
        "3 = not active). `SelectedTimeSlotId` shows the slot currently reserved. Works without login.",
      inputSchema: getTimeslotsShape,
    },
    tool("get_timeslots", ({ startDate, days }) => getDeliveryDays(client, { startDate, days })),
  );

  server.registerTool(
    "select_timeslot",
    {
      title: "Select delivery timeslot",
      description:
        "Reserve a delivery timeslot for the current basket by its numeric id (from get_timeslots). " +
        "Check `IsReserved` on the response. By default the change is refused if it would alter the " +
        "basket (the response then lists the diffs); set force=true to apply it anyway. " +
        "To confirm, call get_basket — the reserved delivery time/spot appears on the basket. " +
        "Requires login.",
      inputSchema: selectTimeslotShape,
    },
    tool("select_timeslot", ({ timeslotId, force }) => reserveTimeslot(client, timeslotId, force)),
  );
}
