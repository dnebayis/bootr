/**
 * A sender for layer c's tests: the four dataset reads of apps/sender/src/dataset-x.ts, played in memory, with the
 * same metering (a post returned 1 unit, a post checked 1, a user read 2, claimed before and given back after) and the
 * same cap. Nothing leaves the machine. The accounts answer as the note's rows say unless a test changes them.
 */
import { SenderXError, type XBudget, type XPost, type XUser } from '../src/dataset/sender-x.js';
import { sinceIdAt } from '../src/dataset/x-build.js';
import { followersOf, X_SOURCES } from '../src/dataset/x-sources.js';

export class FakeSenderX {
  limit: number;
  units = 0;
  posts_ = 0;
  userReads = 0;
  checks = 0;
  calls: string[] = [];
  /** By handle in lowercase: the account X has under that handle now. */
  users = new Map<string, XUser>();
  /** Posts by user id, any order. */
  timelines = new Map<string, XPost[]>();
  /** Post ids X no longer shows. */
  gone = new Set<string>();
  /** When set, every read of a timeline makes `flood` new posts first, timed at the clock's moment. */
  flood = 0;
  private seq = 0;

  constructor(
    limit: number,
    readonly clock: () => Date,
  ) {
    this.limit = limit;
    X_SOURCES.forEach((s, i) => this.users.set(s.handle.toLowerCase(), { id: String(9_000 + i), username: s.handle, followers: followersOf(s.followers)!, protected: false }));
  }

  idOf(handle: string): string {
    return this.users.get(handle.toLowerCase())!.id;
  }

  /** A new post id at the clock's moment, unique. */
  newId(at: Date = this.clock()): string {
    return (BigInt(sinceIdAt(at)) + BigInt(++this.seq)).toString();
  }

  add(userId: string, text: string, over: Partial<XPost> = {}): XPost {
    const at = this.clock();
    const post: XPost = { id: this.newId(at), text, createdAt: at.toISOString(), urls: [], quotedId: null, ...over };
    this.timelines.set(userId, [...(this.timelines.get(userId) ?? []), post]);
    return post;
  }

  get cost(): number {
    return Math.round(this.units * 0.005 * 1000) / 1000;
  }

  private day(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  private budgetNow(): XBudget {
    return { day: this.day(), limit: this.limit, units: this.units, posts: this.posts_, userReads: this.userReads, checks: this.checks };
  }

  private claim(units: number): void {
    if (this.limit <= 0) throw new SenderXError(409, 'dataset_x_off');
    if (this.units + units > this.limit) throw new SenderXError(429, 'dataset_x_cap_reached');
    this.units += units;
  }

  async budget(): Promise<XBudget> {
    this.calls.push('budget');
    return this.budgetNow();
  }

  async resolve(handle: string): Promise<{ user: XUser | null; budget: XBudget }> {
    this.calls.push(`resolve:${handle}`);
    this.claim(2);
    const user = this.users.get(handle.toLowerCase()) ?? null;
    if (user) this.userReads++;
    else this.units -= 2;
    return { user, budget: this.budgetNow() };
  }

  async user(userId: string): Promise<{ user: XUser | null; budget: XBudget }> {
    this.calls.push(`user:${userId}`);
    this.claim(2);
    const user = [...this.users.values()].find((u) => u.id === userId) ?? null;
    if (user) this.userReads++;
    else this.units -= 2;
    return { user, budget: this.budgetNow() };
  }

  async posts(userId: string, sinceId: string, max: number): Promise<{ posts: XPost[]; more: boolean; budget: XBudget }> {
    this.calls.push(`posts:${userId}`);
    this.claim(max);
    for (let i = 0; i < this.flood; i++) this.add(userId, `Base mainnet upgrade number ${++this.seq} ships today for builders`);
    const newer = (this.timelines.get(userId) ?? []).filter((p) => BigInt(p.id) > BigInt(sinceId)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
    const page = newer.slice(0, max);
    this.units -= max - page.length;
    this.posts_ += page.length;
    return { posts: page, more: newer.length > max, budget: this.budgetNow() };
  }

  async check(ids: readonly string[]): Promise<{ present: string[]; gone: string[]; budget: XBudget }> {
    this.calls.push(`check:${ids.length}`);
    this.claim(ids.length);
    const present = ids.filter((id) => !this.gone.has(id));
    this.units -= ids.length - present.length;
    this.checks += present.length;
    return { present, gone: ids.filter((id) => this.gone.has(id)), budget: this.budgetNow() };
  }

  /** A new UTC day on the sender's side. */
  newDay(): void {
    this.units = 0;
    this.posts_ = 0;
    this.userReads = 0;
    this.checks = 0;
  }
}
