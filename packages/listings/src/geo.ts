/** City strings ("Boston, MA") -> the pieces each site's URL wants. */

export interface City {
  name: string;
  state: string | null;
}

export function parseCity(city: string | null | undefined): City | null {
  const t = (city ?? "").trim();
  if (!t) return null;
  const [name, state] = t.split(",").map((s) => s.trim());
  if (!name) return null;
  return { name, state: state ? state.toUpperCase().slice(0, 2) : null };
}

/** "Boston, MA" -> "boston-ma"; "Allston" + city -> "allston-boston-ma" */
export function areaSlug(city: City, neighborhood?: string | null): string {
  const parts = [neighborhood, city.name, city.state].filter((p): p is string => !!p);
  return parts
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Craigslist subdomain + area path. Greater Boston towns all live under boston/gbs. */
const CRAIGSLIST: Record<string, { subdomain: string; area: string | null }> = {
  boston: { subdomain: "boston", area: "gbs" },
  cambridge: { subdomain: "boston", area: "gbs" },
  somerville: { subdomain: "boston", area: "gbs" },
  brookline: { subdomain: "boston", area: "gbs" },
  "new york": { subdomain: "newyork", area: null },
  brooklyn: { subdomain: "newyork", area: "brk" },
  "san francisco": { subdomain: "sfbay", area: "sfc" },
  "los angeles": { subdomain: "losangeles", area: null },
  chicago: { subdomain: "chicago", area: "chc" },
};

export function craigslistSite(city: City): { subdomain: string; area: string | null } {
  const known = CRAIGSLIST[city.name.toLowerCase()];
  if (known) return known;
  return { subdomain: city.name.toLowerCase().replace(/[^a-z]/g, ""), area: null };
}

/** Airbnb location path segment: "Allston--Boston--MA" */
export function airbnbPlace(city: City, neighborhood?: string | null): string {
  return [neighborhood, city.name, city.state]
    .filter((p): p is string => !!p)
    .map((p) => p.replace(/\s+/g, "-"))
    .join("--");
}

export function firstNeighborhood(neighborhoods: string[]): string | null {
  return neighborhoods[0]?.trim() || null;
}
