import { parseCity } from "../geo.ts";
import type { SiteRecipe } from "../recipe.ts";

/** SpareFoot aggregates storage facilities with monthly unit prices. */
export const sparefoot: SiteRecipe = {
  site: "sparefoot",
  label: "SpareFoot",
  kinds: ["storage"],
  needsLogin: false,
  hosts: ["sparefoot.com"],
  buildUrl(q) {
    const city = parseCity(q.city);
    if (!city) return null;
    const slug = [city.name, city.state].filter(Boolean).join("-").replace(/\s+/g, "-");
    return `https://www.sparefoot.com/${slug}-self-storage.html`;
  },
  instruction() {
    return (
      "This is a SpareFoot storage search. Each facility card is one listing. For each return: the facility name " +
      "and address as the title, the card link, the cheapest unit's monthly price as shown with priceBasis 'month', " +
      "the address as location, the cheapest unit size (e.g. '5x10') in the snippet, and photoCount 1."
    );
  },
};
