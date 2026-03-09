import type { MockArc, MockEvent, MockItem } from "./mock-arc-data.js";

const baseItem: MockItem = {
  id: "item",
  name: "Item",
  value: 10,
  workbench: null,
  loot_area: null,
  components: null,
  recycle_components: null,
  recycle_from: null,
  dropped_by: null,
};

export function item(overrides: Partial<MockItem> = {}): MockItem {
  return { ...baseItem, ...overrides };
}

const baseArc: MockArc = {
  id: "bastion",
  name: "Bastion",
  loot: [{ item: { id: "x", name: "Item X" } }],
};

export function arc(overrides: Partial<MockArc> = {}): MockArc {
  return { ...baseArc, ...overrides };
}

const baseEvent: MockEvent = {
  name: "Prospecting Probes",
  map: "Bastion",
  startTime: 1000,
  endTime: 2000,
};

export function event(overrides: Partial<MockEvent> = {}): MockEvent {
  return { ...baseEvent, ...overrides };
}
