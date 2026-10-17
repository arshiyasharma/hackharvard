import { describe, expect, test } from "bun:test";
import { chooseToApprove, moveReport, reportText } from "@elves/elves";
import { type Deal, type Item, MemoryStore } from "@elves/shared";

const base: Omit<Item, "id" | "name" | "category" | "weightLb" | "listPriceCents" | "outcome"> = {
  moveId: "m",
  title: null,
  description: null,
  condition: null,
  priceLowCents: null,
  priceHighCents: null,
  floorPriceCents: 1000,
  photoAttachmentIds: [],
  listingApproved: false,
  createdAt: "",
};
const item = (
  id: string,
  name: string,
  category: string,
  weightLb: number,
  outcome: Item["outcome"],
  list: number | null = null,
) => ({ ...base, id, name, category, weightLb, outcome, listPriceCents: list }) as Item;

describe("a yes covers only the item it answers", () => {
  const couch = item("a", "gray couch", "couch", 150, "listed");
  const lamp = item("b", "lamp", "small", 10, "listed");
  const floorSet = (id: string) => ({ type: "item.floor_set", payload: { itemId: id } });

  test("names the item", () => {
    expect(chooseToApprove("yes list the couch", [couch, lamp], [floorSet("a"), floorSet("b")])).toEqual([
      couch,
    ]);
  });
  test("both / all of them", () => {
    expect(chooseToApprove("yes list both", [couch, lamp], [])).toEqual([couch, lamp]);
    expect(chooseToApprove("yes, all of them", [couch, lamp], [])).toEqual([couch, lamp]);
  });
  test("a bare yes answers the last item whose floor was set", () => {
    expect(chooseToApprove("yes", [couch, lamp], [floorSet("a"), floorSet("b")])).toEqual([lamp]);
    expect(chooseToApprove("yes", [couch, lamp], [floorSet("b"), floorSet("a")])).toEqual([couch]);
  });
  test("a single pending item, or none", () => {
    expect(chooseToApprove("yes", [lamp], [])).toEqual([lamp]);
    expect(chooseToApprove("yes", [], [])).toEqual([]);
  });
});

describe("Move Report", () => {
  test("diverted counts sold, given and donated; dumped counts against; open items are listed apart", () => {
    const items = [
      item("a", "couch", "couch", 150, "sold", 9000),
      item("b", "lamp", "small", 10, "given", 0),
      item("c", "mattress", "mattress", 60, "dumped"),
      item("d", "desk", "desk_table", 70, "donated"),
      item("e", "chair", "chair", 20, "listed", 3000),
    ];
    const deals = [
      { mode: "sell_item", subjectId: "a", agreedCents: 7000 },
      { mode: "buy_item", subjectId: "a", agreedCents: 1 },
    ] as Deal[];
    const r = moveReport(items, deals);
    expect(r.lbDiverted).toBe(230);
    expect(r.lbDumped).toBe(60);
    expect(r.open).toBe(1);
    expect(r.kgCo2eAvoided).toBe(Math.round(150 * 1.915 + 10 * 1.01 + 70 * 1.115));
    expect(r.dollarsRecoveredCents).toBe(7000); // the agreed price, not the list price
    const text = reportText(r);
    expect(text).toContain("230 lb");
    expect(text).toContain("approximate");
    expect(text).toContain("counts against");
  });

  test("a sale with no recorded deal falls back to the list price; an empty move reports nothing diverted", () => {
    expect(moveReport([item("a", "couch", "couch", 150, "sold", 9000)]).dollarsRecoveredCents).toBe(9000);
    expect(reportText(moveReport([]))).toContain("no pounds diverted");
  });

  test("works against the in-memory store", async () => {
    const store = new MemoryStore();
    const move = await store.createMove({ ownerHandle: "+1", ownerSpaceId: "s", platform: "imessage" });
    await store.upsertItem({
      moveId: move.id,
      name: "couch",
      category: "couch",
      weightLb: 150,
      outcome: "donated",
    });
    const r = moveReport(await store.listItems(move.id), await store.listDeals(move.id));
    expect(r.byOutcome.donated).toBe(1);
    expect(r.lbDiverted).toBe(150);
  });
});
