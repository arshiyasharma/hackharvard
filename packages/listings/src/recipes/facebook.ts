import { parseCity } from "../geo.ts";
import { budgetUsd, kindNoun, type SiteRecipe } from "../recipe.ts";

/** Facebook Marketplace rentals. Login-walled: only runs inside the owner's persisted browser context. */
export const facebook: SiteRecipe = {
  site: "facebook",
  label: "Facebook Marketplace",
  kinds: ["room", "sublet", "apartment"],
  needsLogin: true,
  hosts: ["facebook.com"],
  buildUrl(q) {
    const city = parseCity(q.city);
    if (!city) return null;
    const url = new URL(
      `https://www.facebook.com/marketplace/${city.name.toLowerCase().replace(/\s+/g, "")}/propertyrentals`,
    );
    const max = budgetUsd(q);
    if (max != null) {
      url.searchParams.set("minPrice", "0");
      url.searchParams.set("maxPrice", String(max));
    }
    const words = [
      q.kind === "room" ? "room" : q.kind === "sublet" ? "sublet" : "",
      ...q.neighborhoods,
    ].filter(Boolean);
    if (words.length) url.searchParams.set("query", words.join(" "));
    url.searchParams.set("exact", "false");
    return url.toString();
  },
  prepare() {
    return ["If a login, notifications or cookies dialog is covering the page, close it."];
  },
  instruction(q) {
    return (
      `This is Facebook Marketplace property rentals, searching for ${kindNoun(q.kind)}. Each card in the grid is one ` +
      "listing. For each return: the title, the card's link (a /marketplace/item/ URL), the price as shown with " +
      "priceBasis 'month', the location line, bedrooms if shown, and photoCount 1 (every card has a photo). " +
      "Skip sponsored cards."
    );
  },
};
