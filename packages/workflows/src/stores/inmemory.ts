import type { Deal, EngineStore, LastCallRow } from "../types.ts";

export class InMemoryEngineStore implements EngineStore {
  readonly kind = "memory" as const;
  private deals = new Map<string, Deal>();
  private lastCalls = new Map<string, LastCallRow>();
  private seq = 0;
  private order = new Map<string, number>();

  async getDeal(id: string) {
    return this.deals.get(id) ?? null;
  }
  async saveDeal(deal: Deal) {
    if (!this.order.has(deal.id)) this.order.set(deal.id, ++this.seq);
    this.deals.set(deal.id, deal);
    return deal;
  }
  private sorted(pred: (d: Deal) => boolean) {
    return [...this.deals.values()].filter(pred).sort((a, b) => (this.order.get(a.id) ?? 0) - (this.order.get(b.id) ?? 0));
  }
  async listDeals(moveId: string) {
    return this.sorted((d) => d.moveId === moveId);
  }
  async dealsForItem(itemId: string) {
    return this.sorted((d) => d.itemId === itemId);
  }
  async dealForBuyerSpace(spaceId: string) {
    const all = this.sorted((d) => d.buyerSpaceId === spaceId);
    return all[all.length - 1] ?? null;
  }
  async getLastCall(moveId: string) {
    return this.lastCalls.get(moveId) ?? null;
  }
  async saveLastCall(row: LastCallRow) {
    this.lastCalls.set(row.moveId, row);
    return row;
  }
  async listWaitingLastCalls() {
    return [...this.lastCalls.values()].filter((r) => r.status === "waiting");
  }
}
