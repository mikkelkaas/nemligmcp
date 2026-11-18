# Upstream patch proposal: add a recipe card to the basket

Tested against the live account on 2026-11-11. One POST, two known arguments, both
required. Nothing here needs a new auth flow: it uses the existing `client.call`, so
the session, cookie jar, XSRF token and bearer token are already handled.

## Contract found by probing

    GET  /webapi/basket/AddRecipeToBasket      -> 405, allow: POST        (route exists)
    POST /webapi/basket/AddRecipeToBasket      -> 400 Missing arguement,
         DeveloperMessage: "Id couldn't be converted to GUID: RecipeId"  (name + type)
    POST { RecipeId: "<guid>" }                -> 400 Missing arguement,
         DeveloperMessage: "Number needs to be greather than 1, NumberOfPeople"
    POST { RecipeId: "<guid>", NumberOfPeople: 5 } -> 200, returns the full basket

`GetBasket` then carries the card:

    "Recipes": [ { "Id": "<guid>", "Title": "Kålruller med kylling og frisk grønt",
                   "RecipeLineItems": [ { "ProductId": ..., "ProductName": ...,
                                          "Quantity": ... } ] } ]

## Where the GUID comes from

The recipe page only exposes the Umbraco number (`/opskrifter/kaalruller-saeson-98002578`),
which this endpoint rejects. `search_products` already returns the GUID: its response has a
`Recipes` array of `recipelistitem` entries with `Id`, `Name`, `Url`, `TotalTime`. So the
lookup needs no new endpoint — match on `Url` and take `Id`.

## Patch for `src/api/basket.ts`

```ts
/** Add a whole recipe to the basket at the given number of portions.
 *  RecipeId is the GUID from the search response's `Recipes[].Id`, not the
 *  number in the recipe URL. NumberOfPeople must be greater than 1. */
export async function addRecipeToBasket(client: HttpClient, recipeId: string, numberOfPeople: number) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipeId)) {
    throw new NemligUsageError(`RecipeId must be a GUID, got "${recipeId}" (the number in a recipe URL is not a GUID)`);
  }
  if (!Number.isInteger(numberOfPeople) || numberOfPeople < 2) {
    throw new NemligUsageError(`numberOfPeople must be an integer greater than 1, got ${numberOfPeople}`);
  }
  return client.call(`${BASE_URL}/webapi/basket/AddRecipeToBasket`, {
    method: "POST",
    requireLogin: true,
    json: { RecipeId: recipeId, NumberOfPeople: numberOfPeople },
  });
}
```

Register a tool next to `add_to_basket` (`add_recipe_to_basket`, two schema fields:
`recipeId: z.string().uuid()`, `numberOfPeople: z.number().int().min(2).max(20)`), and let
`search_products` surface `Recipes[].Id` so a caller can go from a recipe name to a card
without scraping the HTML.

## Why the family planner needs it

`AddToBasket` sets an absolute quantity, so the plan can add the card first and then
overwrite every line the family wants different: their own brand, their own amount, and
quantity 0 for the fresh herbs and pantry items they never buy. The card stays visible in
the app while cooking; the products are the ones they actually use.
