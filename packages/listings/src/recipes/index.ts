import type { SiteRecipe } from "../recipe.ts";
import { airbnb } from "./airbnb.ts";
import { apartments } from "./apartments.ts";
import { booking } from "./booking.ts";
import { craigslist } from "./craigslist.ts";
import { facebook } from "./facebook.ts";
import { sparefoot } from "./sparefoot.ts";
import { zillow } from "./zillow.ts";

/** Trust order: when the same listing shows up twice, the earlier site's copy wins. */
export const RECIPES: SiteRecipe[] = [craigslist, apartments, zillow, facebook, airbnb, booking, sparefoot];

/**
 * Sites verified live from a plain headless Chrome: Craigslist and Airbnb (rooms, sublets and the hotel gap).
 * Apartments.com (Akamai block), SpareFoot (Cloudflare challenge), Booking.com (drops URL search params), Zillow
 * (PerimeterX) and Facebook (login) are enabled per deployment once `bun run browser search` passes there.
 */
export const DEFAULT_SITES = ["craigslist", "airbnb"];

export { airbnb, apartments, booking, craigslist, facebook, sparefoot, zillow };
