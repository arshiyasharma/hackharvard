import { areaSlug, firstNeighborhood, parseCity } from "../geo.ts";
import { budgetUsd, kindNoun, type SiteRecipe } from "../recipe.ts";

export const apartments: SiteRecipe = {
  site: "apartments",
  label: "Apartments.com",
  kinds: ["apartment", "sublet"],
  needsLogin: false,
  hosts: ["apartments.com"],
  locator: "#placardContainer",
  buildUrl(q) {
    const city = parseCity(q.city);
    if (!city) return null;
    const area = areaSlug(city, firstNeighborhood(q.neighborhoods));
    const max = budgetUsd(q);
    const beds = q.bedrooms == null ? null : q.bedrooms === 0 ? "studios" : `${q.bedrooms}-bedrooms`;
    const filter = [beds, max != null ? `under-${max}` : null].filter(Boolean).join("-");
    return `https://www.apartments.com/${area}/${filter ? `${filter}/` : ""}`;
  },
  instruction(q) {
    return (
      `This is Apartments.com results for ${kindNoun(q.kind)}. Each placard is one property. For each return: the ` +
      "property name and address as the title, the placard link, the rent or rent range as shown with priceBasis " +
      "'month', beds, the phone number if shown as contactPhone, and photoCount 1."
    );
  },
};
