import type { Session, SessionStatus } from "@opencode-ai/sdk/v2";
import {
  type ChildRecord,
  normalizeStatus,
  observeInitiallyActive,
  retainError,
  updateStatus,
} from "./model";

export type LoadState = "loading" | "ready" | "unavailable";

export type Snapshot = {
  parentID?: string;
  children: ReadonlyMap<string, ChildRecord>;
  loadState: LoadState;
  stale: boolean;
};

export type ControllerOptions = {
  fetchChildren: (parentID: string) => Promise<Session[]>;
  status: (sessionID: string) => SessionStatus | undefined;
  now?: () => number;
  debounceMs?: number;
  onChange?: (snapshot: Snapshot) => void;
  log?: (level: "debug" | "warn", message: string) => void;
};

type LifecycleEvent =
  | { type: "status"; sessionID: string; status: SessionStatus; now: number }
  | { type: "error"; sessionID: string; now: number };

function setRecord(
  records: ReadonlyMap<string, ChildRecord>,
  record: ChildRecord,
): Map<string, ChildRecord> {
  return new Map(records).set(record.session.id, record);
}

function removeRecord(
  records: ReadonlyMap<string, ChildRecord>,
  sessionID: string,
): Map<string, ChildRecord> {
  return new Map([...records].filter(([id]) => id !== sessionID));
}

function applyLifecycle(
  records: ReadonlyMap<string, ChildRecord>,
  event: LifecycleEvent,
): Map<string, ChildRecord> {
  const previous = records.get(event.sessionID);
  if (!previous) return new Map(records);
  const next =
    event.type === "status"
      ? updateStatus(previous, event.status, event.now)
      : retainError(previous, event.now);
  return setRecord(records, next);
}

function reconcile(
  records: ReadonlyMap<string, ChildRecord>,
  parentID: string,
  sessions: readonly Session[],
  statuses: ReadonlyMap<string, SessionStatus>,
  pending: readonly LifecycleEvent[],
  now: number,
): Map<string, ChildRecord> {
  const retained = [...records].filter(([, record]) => record.session.parentID !== parentID);
  const pendingIDs = new Set(pending.map((event) => event.sessionID));
  const fetched = sessions
    .filter((session) => session.parentID === parentID)
    .map((session): [string, ChildRecord] => {
      const previous = records.get(session.id);
      const status = pendingIDs.has(session.id)
        ? (previous?.status ?? { type: "idle" })
        : (statuses.get(session.id) ?? { type: "idle" });
      const currentSession =
        previous && previous.session.time.updated > session.time.updated
          ? previous.session
          : session;
      const base: ChildRecord = previous
        ? { ...previous, session: currentSession }
        : { session, status: normalizeStatus(status) };
      const record = previous ? updateStatus(base, status, now) : observeInitiallyActive(base, now);
      return [session.id, record];
    });
  const baseline = new Map<string, ChildRecord>([...retained, ...fetched]);
  return pending.reduce(applyLifecycle, baseline);
}

function currentChildren(
  records: ReadonlyMap<string, ChildRecord>,
  members: ReadonlySet<string>,
): Map<string, ChildRecord> {
  return new Map(
    [...members]
      .map((id) => records.get(id))
      .filter((record): record is ChildRecord => record !== undefined)
      .map((record) => [record.session.id, record]),
  );
}

export class ChildController {
  private parentID?: string;
  private records = new Map<string, ChildRecord>();
  private members = new Set<string>();
  private pending: LifecycleEvent[] = [];
  private deleted = new Map<string, string>();
  private loadState: LoadState = "loading";
  private stale = false;
  private parentGeneration = 0;
  private listGeneration = 0;
  private fetching = false;
  private trailing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private readonly now: () => number;
  private readonly debounceMs: number;

  constructor(private readonly options: ControllerOptions) {
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? 100;
  }

  snapshot(): Snapshot {
    return {
      parentID: this.parentID,
      children: currentChildren(this.records, this.members),
      loadState: this.loadState,
      stale: this.stale,
    };
  }

  setParent(parentID: string): void {
    if (this.parentID === parentID) return;
    this.parentGeneration++;
    this.listGeneration++;
    this.parentID = parentID;
    this.members = new Set();
    this.pending = [];
    this.loadState = "loading";
    this.stale = false;
    this.trailing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.emit();
    void this.refresh();
  }

  scheduleRefresh(): void {
    if (!this.parentID || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, this.debounceMs);
  }

  async refresh(): Promise<void> {
    const parentID = this.parentID;
    if (!parentID || this.disposed) return;
    if (this.fetching) {
      this.trailing = true;
      return;
    }

    const parentGeneration = this.parentGeneration;
    const listGeneration = this.listGeneration;
    this.fetching = true;
    try {
      const sessions = await this.options.fetchChildren(parentID);
      const staleParent = parentGeneration !== this.parentGeneration || parentID !== this.parentID;
      const staleList = listGeneration !== this.listGeneration;
      if (this.disposed || staleParent || staleList) {
        this.options.log?.("debug", "ignored stale child-session response");
        if (!this.disposed) this.trailing = true;
        return;
      }

      const fetched = sessions.filter((session) => session.parentID === parentID);
      const fetchedIDs = new Set(fetched.map((session) => session.id));
      const direct = fetched.filter((session) => this.deleted.get(session.id) !== parentID);
      const statuses = new Map(
        direct.map((session) => [session.id, normalizeStatus(this.options.status(session.id))]),
      );
      this.records = reconcile(this.records, parentID, direct, statuses, this.pending, this.now());
      this.members = new Set(direct.map((session) => session.id));
      this.pending = [];
      this.deleted = new Map(
        [...this.deleted].filter(
          ([sessionID, ownerID]) => ownerID !== parentID || fetchedIDs.has(sessionID),
        ),
      );
      this.loadState = "ready";
      this.stale = false;
      this.emit();
    } catch {
      if (
        this.disposed ||
        parentGeneration !== this.parentGeneration ||
        listGeneration !== this.listGeneration
      ) {
        if (!this.disposed) this.trailing = true;
        return;
      }
      this.stale = this.loadState === "ready";
      if (!this.stale) this.loadState = "unavailable";
      this.options.log?.("warn", "failed to fetch child sessions");
      this.emit();
    } finally {
      this.fetching = false;
      if (this.trailing && !this.disposed) {
        this.trailing = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        void this.refresh();
      }
    }
  }

  onCreated(session: Session): void {
    this.onSessionChanged(session, true);
  }

  onUpdated(session: Session): void {
    this.onSessionChanged(session, false);
  }

  private onSessionChanged(session: Session, membershipChanged: boolean): void {
    const previous = this.records.get(session.id);
    if (session.parentID !== this.parentID && !previous) return;
    if (membershipChanged) this.listGeneration++;
    const status = this.options.status(session.id);
    const now = this.now();
    const base: ChildRecord = previous
      ? { ...previous, session }
      : { session, status: normalizeStatus(status) };
    const identified = previous
      ? updateStatus(base, status, now)
      : observeInitiallyActive(base, now);
    const related = this.pending.filter((event) => event.sessionID === session.id);
    this.records = related.reduce(applyLifecycle, setRecord(this.records, identified));
    this.pending = this.pending.filter((event) => event.sessionID !== session.id);
    this.members =
      session.parentID === this.parentID
        ? new Set(this.members).add(session.id)
        : new Set([...this.members].filter((id) => id !== session.id));
    this.emit();
    this.scheduleRefresh();
  }

  onDeleted(session: Session): void {
    const relevant = session.parentID === this.parentID || this.records.has(session.id);
    if (!relevant) return;
    const visible = this.members.has(session.id);
    this.listGeneration++;
    if (session.parentID) this.deleted = new Map(this.deleted).set(session.id, session.parentID);
    this.records = removeRecord(this.records, session.id);
    this.members = new Set([...this.members].filter((id) => id !== session.id));
    if (visible) this.emit();
    this.scheduleRefresh();
  }

  onStatus(sessionID: string, status: SessionStatus): void {
    const record = this.records.get(sessionID);
    const event: LifecycleEvent = { type: "status", sessionID, status, now: this.now() };
    if (record) {
      this.records = applyLifecycle(this.records, event);
      if (this.members.has(sessionID)) this.emit();
      if (this.fetching) this.pending = [...this.pending, event];
      return;
    }
    if (this.loadState !== "ready" || this.fetching) {
      this.pending = [...this.pending, event];
      this.scheduleRefresh();
    }
  }

  onError(sessionID: string | undefined, error: unknown): void {
    if (!sessionID || error === undefined) {
      this.options.log?.("warn", "ignored incomplete session.error event");
      return;
    }

    const record = this.records.get(sessionID);
    const event: LifecycleEvent = { type: "error", sessionID, now: this.now() };
    if (record) {
      this.records = applyLifecycle(this.records, event);
      if (this.members.has(sessionID)) this.emit();
      if (this.fetching) this.pending = [...this.pending, event];
      return;
    }
    if (this.loadState !== "ready" || this.fetching) {
      this.pending = [...this.pending, event];
      this.scheduleRefresh();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.parentGeneration++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }
}
