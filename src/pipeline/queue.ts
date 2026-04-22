export class AsyncQueue<T> {
  private queue: T[] = [];
  private resolvers: ((value: T) => void)[] = [];

  push(item: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  unshift(item: T) {
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve(item);
    } else {
      this.queue.unshift(item);
    }
  }

  async pop(): Promise<T> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<T>((resolve) => {
      this.resolvers.push(resolve);
    });
  }

  /** Removes and returns every currently-buffered item. Pending `pop()` callers are unaffected. */
  drainSync(): T[] {
    const items = this.queue;
    this.queue = [];
    return items;
  }

  get length(): number {
    return this.queue.length;
  }
}