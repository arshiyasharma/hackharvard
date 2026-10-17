import { airbnbPlace, firstNeighborhood, parseCity } from "../geo.ts";
import { budgetUsd, kindNoun, nightsBetween, type SiteRecipe } from "../recipe.ts";

const ROOM_TYPES: Record<string, string | null> = {
  room: "Private room",
  sublet: "Entire home/apt",
  apartment: "Entire home/apt",
  hotel: null,
};

/** Airbnb for furnished sublets and for the hotel gap. Prices come back as totals; toResults spreads them. */
export const airbnb: SiteRecipe = {
  site: "airbnb",
  label: "Airbnb",
  kinds: ["sublet", "room", "hotel"],
  needsLogin: false,
  hosts: ["airbnb.com"],
  // Airbnb's class names are generated; the main content id has been stable for years. Without it the
  // page is ~1.7M characters of snapshot.
  locator: "#site-content",
  buildUrl(q) {
    const city = parseCity(q.city);
    if (!city || !q.moveIn || !q.moveOut) return null;
    const url = new URL(
      `https://www.airbnb.com/s/${airbnbPlace(city, firstNeighborhood(q.neighborhoods))}/homes`,
    );
    url.searchParams.set("checkin", q.moveIn);
    url.searchParams.set("checkout", q.moveOut);
    url.searchParams.set("adults", "1");
    const nights = nightsBetween(q.moveIn, q.moveOut) ?? 1;
    const max = budgetUsd(q);
    if (max != null) {
      // Airbnb filters on the total for the stay.
      const total = q.priceUnit === "night" ? max * nights : Math.round((max * nights) / 30);
      url.searchParams.set("price_max", String(total));
      url.searchParams.set("price_filter_input_type", "0");
    }
    const roomType = ROOM_TYPES[q.kind];
    if (roomType) url.searchParams.append("room_types[]", roomType);
    return url.toString();
  },
  // No prepare() step: the runner's Escape closes the price/translation dialog; an LLM click here tended to
  // navigate away from the results.
  instruction(q) {
    return (
      `This is Airbnb search results for ${kindNoun(q.kind)}. Each card is one stay. For each return: as the title, ` +
      "the card heading plus its descriptive line (e.g. 'Room in Boston · Stay with Maria · 1 bed'), the id of the " +
      "card or its link as url, the price exactly as shown including any 'for N nights' wording (priceBasis 'total' " +
      "when it is for a stay, 'night' when it says per night), the rating line as location if no area is shown, and " +
      "photoCount 1. Skip 'other places' sections."
    );
  },
};
