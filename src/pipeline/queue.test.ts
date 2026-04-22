import { describe, it, expect, beforeEach } from "vitest";
import { AsyncQueue } from "./queue.js";

describe("AsyncQueue", () => {
  let queue: AsyncQueue<string>;

  beforeEach(() => {
    queue = new AsyncQueue<string>();
  });

  it("should push and pop in FIFO order", async () => {
    queue.push("A");
    queue.push("B");
    expect(queue.length).toBe(2);
    
    expect(await queue.pop()).toBe("A");
    expect(await queue.pop()).toBe("B");
    expect(queue.length).toBe(0);
  });

  it("should support priority unshift (LIFO front insertion)", async () => {
    queue.push("Voice 1");
    queue.push("Voice 2");
    
    // Inject a high priority tone
    queue.unshift("Standby Beep");
    
    expect(queue.length).toBe(3);
    expect(await queue.pop()).toBe("Standby Beep"); // Jumped the queue!
    expect(await queue.pop()).toBe("Voice 1");
    expect(await queue.pop()).toBe("Voice 2");
  });

  it("should resolve pending pops when item is pushed or unshifted", async () => {
    const p1 = queue.pop();
    queue.push("Delayed 1");
    expect(await p1).toBe("Delayed 1");

    const p2 = queue.pop();
    queue.unshift("Delayed Priority");
    expect(await p2).toBe("Delayed Priority");
  });

  it("drainSync returns buffered items and empties the queue", () => {
    queue.push("A");
    queue.push("B");
    queue.push("C");
    expect(queue.length).toBe(3);

    const drained = queue.drainSync();
    expect(drained).toEqual(["A", "B", "C"]);
    expect(queue.length).toBe(0);
  });
});
