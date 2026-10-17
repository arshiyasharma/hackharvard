import { areaSlug, firstNeighborhood, parseCity } from "../geo.ts";
import { budgetUsd, kindNoun, type SiteRecipe } from "../recipe.ts";

/** Zillow rentals. Sits behind PerimeterX: run through Browserbase with proxies, and verify the query state. */
export const zillow: SiteRecipe = {
  site: "zillow",
  label: "Zillow",
  kinds: ["apartment", "sublet"],
  needsLogin: false,
  hosts: ["zillow.com"],
  buildUrl(q) {
    const city = parseCity(q.city);
    if (!city) return null;
    const url = new URL(
      `https://www.zillow.com/${areaSlug(city, firstNeighborhood(q.neighborhoods))}/rentals/`,
    );
    const filterState: Record<string, unknown> = {
      fr: { value: true },
      fsba: { value: false },
      fsbo: { value: false },
    };
    const max = budgetUsd(q);
    if (max != null) filterState.mp = { max };
    if (q.bedrooms != null) filterState.beds = { min: q.bedrooms };
    url.searchParams.set("searchQueryState", JSON.stringify({ filterState }));
    return url.toString();
  },
  prepare(q) {
    const max = budgetUsd(q);
    return max != null
      ? [
          `If the results do not already show a max rent filter of $${max}, set the max monthly rent to $${max}.`,
        ]
      : [];
  },
  instruction(q) {
    return (
      `This is Zillow rental results for ${kindNoun(q.kind)}. Each property card is one listing. For each return: ` +
      "the address as the title, the card link, the rent as shown with priceBasis 'month', beds, the 'available' " +
      "date if shown, and photoCount 1."
    );
  },
};
