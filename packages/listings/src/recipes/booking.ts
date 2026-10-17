import { parseCity } from "../geo.ts";
import { budgetUsd, type SiteRecipe } from "../recipe.ts";

/** Booking.com for the nights between move-out and move-in. */
export const booking: SiteRecipe = {
  site: "booking",
  label: "Booking.com",
  kinds: ["hotel"],
  needsLogin: false,
  hosts: ["booking.com"],
  buildUrl(q) {
    const city = parseCity(q.city);
    if (!city || !q.moveIn || !q.moveOut) return null;
    const url = new URL("https://www.booking.com/searchresults.html");
    url.searchParams.set("ss", [city.name, city.state].filter(Boolean).join(", "));
    url.searchParams.set("checkin", q.moveIn);
    url.searchParams.set("checkout", q.moveOut);
    url.searchParams.set("group_adults", "1");
    url.searchParams.set("no_rooms", "1");
    url.searchParams.set("order", "price");
    const max = budgetUsd(q);
    if (max != null) url.searchParams.set("nflt", `price=USD-min-${max}-1`);
    return url.toString();
  },
  prepare() {
    return ["If a sign-in or Genius popup is showing, close it."];
  },
  instruction() {
    return (
      "This is Booking.com hotel results. Each property card is one hotel. For each return: the hotel name as the " +
      "title, the card link, the price as shown with priceBasis 'total' (it covers the whole stay) unless it says " +
      "per night, the distance-from-center or neighborhood line as location, and photoCount 1."
    );
  },
};
