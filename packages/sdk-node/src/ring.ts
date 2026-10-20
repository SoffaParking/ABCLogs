/**
 * A fixed-size FIFO. When full, a push overwrites the oldest item, so memory
 * stays bounded however long the server is unreachable: the newest events are
 * the ones worth keeping.
 */
export class Ring<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.length;
  }

  /** Adds an item; returns true when that pushed the oldest one out. */
  push(item: T): boolean {
    const tail = (this.head + this.length) % this.capacity;
    this.items[tail] = item;
    if (this.length < this.capacity) {
      this.length += 1;
      return false;
    }
    this.head = (this.head + 1) % this.capacity;
    return true;
  }

  /** Removes and returns up to `n` of the oldest items. */
  take(n: number): T[] {
    const count = Math.min(n, this.length);
    const out = new Array<T>(count);
    for (let i = 0; i < count; i++) {
      out[i] = this.items[this.head] as T;
      this.items[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
    }
    this.length -= count;
    return out;
  }
}
