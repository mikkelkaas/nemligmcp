import { z } from "zod";

/**
 * Tool input schemas as zod *raw shapes* (plain objects of zod fields), which is
 * what McpServer.registerTool expects for `inputSchema`.
 */

export const searchProductsShape = {
  query: z.string().min(1).describe("Search term, e.g. 'mælk' or 'økologiske bananer'."),
  take: z.number().int().min(1).max(100).default(20).describe("Max number of products to return."),
  skip: z.number().int().min(0).default(0).describe("Offset for pagination."),
  recipeCount: z.number().int().min(0).max(20).default(3).describe("Number of recipe results to include."),
};

export const quickSearchShape = {
  query: z.string().min(1).describe("Partial search term for autocomplete suggestions."),
};

export const getProductDetailsShape = {
  productUrl: z
    .string()
    .min(1)
    .describe("Product URL or path from a search result (e.g. '/5012345/oekologisk-letmaelk')."),
};

export const getBasketShape = {};

export const clearBasketShape = {};

export const addToBasketShape = {
  productId: z.string().min(1).describe("The product id to add."),
  quantity: z.number().int().min(1).default(1).describe("Quantity to add."),
};

export const setBasketQuantityShape = {
  productId: z.string().min(1).describe("The product id to update."),
  quantity: z.number().int().min(0).describe("Absolute quantity to set. 0 removes the product."),
};

export const removeFromBasketShape = {
  productId: z.string().min(1).describe("The product id to remove from the basket."),
};

export const getTimeslotsShape = {
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
    .optional()
    .describe("First day to list (YYYY-MM-DD). Omit to start from today."),
  days: z
    .number()
    .int()
    .min(1)
    .max(14)
    .default(8)
    .describe("Number of days of timeslots to return."),
};

export const selectTimeslotShape = {
  timeslotId: z
    .number()
    .int()
    .describe("The numeric timeslot Id from get_timeslots (the slot's `Id`, not TimeslotUtc)."),
  force: z
    .boolean()
    .default(false)
    .describe(
      "If false (default), refuse the change when it would alter the basket and report the diffs. " +
        "If true, apply the new slot regardless.",
    ),
};
