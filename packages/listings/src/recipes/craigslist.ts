import { craigslistSite, parseCity } from "../geo.ts";
import { budgetUsd, kindNoun, type SiteRecipe } from "../recipe.ts";

const SECTIONS: Record<string, string> = { room: "roo", sublet: "sub", apartment: "apa" };

export const craigslist: SiteRecipe = {
  site: "craigslist",
  label: "Craigslist",
  kinds: ["room", "sublet", "apartment"],
  needsLogin: false,
  hosts: ["craigslist.org"],
  locator: ".cl-search-results",
  buildUrl(q) {
    const city = parseCity(q.city);
    const section = SECTIONS[q.kind];
    if (!city || !section) return null;
    const { subdomain, area } = craigslistSite(city);
    const url = new URL(`https://${subdomain}.craigslist.org/search/${area ? `${area}/` : ""}${section}`);
    const max = budgetUsd(q);
    if (max != null) url.searchParams.set("max_price", String(max));
    if (q.bedrooms != null && q.kind === "apartment")
      url.searchParams.set("min_bedrooms", String(q.bedrooms));
    if (q.neighborhoods.length) url.searchParams.set("query", q.neighborhoods.join(" | "));
    url.searchParams.set("hasPic", "1");
    url.searchParams.set("bundleDuplicates", "1");
    url.searchParams.set("sort", "date");
    return url.toString();
  },
  instruction(q) {
    return (
      `This is a Craigslist housing search for ${kindNoun(q.kind)}. Each row in the results list is one post. ` +
      "For each post return: the title, its link, the price exactly as shown with priceBasis 'month', the neighborhood " +
      "shown in parentheses as location, bedrooms if shown, the post date, and whether it has photos (photoCount 1 if " +
      "a thumbnail is shown, 0 if not). Skip ads and 'nearby results'."
    );
  },
};
