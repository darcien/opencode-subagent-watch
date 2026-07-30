/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import type { BoxRenderable, RGBA } from "@opentui/core";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { clearActivity, observeActivity, touchActivity, type ActivityMap } from "./activity";
import { ChildController, type Snapshot } from "./controller";
import {
  displayStatus,
  headerLine,
  isActive,
  resolveSessionModel,
  rowLines,
  sortAndPrune,
  summarize,
  truncateWidth,
} from "./model";

const PLUGIN_ID = "opencode-subagent-watch";
const COLLAPSED_KEY = `${PLUGIN_ID}.collapsed`;

function log(api: TuiPluginApi, level: "debug" | "warn", message: string): void {
  void api.client.app.log({ service: PLUGIN_ID, level, message }).catch(() => {});
}

function navigate(api: TuiPluginApi, sessionID: string): void {
  api.ui.dialog.clear();
  api.route.navigate("session", { sessionID });
}

function statusColor(api: TuiPluginApi, status: ReturnType<typeof displayStatus>): RGBA {
  if (status === "error") return api.theme.current.error;
  if (status === "retry") return api.theme.current.warning;
  if (status === "busy") return api.theme.current.success;
  return api.theme.current.textMuted;
}

function View(props: {
  api: TuiPluginApi;
  sessionID: string;
  controller: ChildController;
  snapshot: () => Snapshot;
  collapsed: () => boolean;
  activities: () => ActivityMap;
  toggle: () => void;
  ensureKV: () => void;
}) {
  const [width, setWidth] = createSignal(40);
  const [now, setNow] = createSignal(Date.now());
  let root: BoxRenderable | undefined;

  createEffect(() => props.ensureKV());
  if (props.snapshot().parentID === props.sessionID) void props.controller.refresh();
  else void props.controller.setParent(props.sessionID);

  const list = createMemo(() => sortAndPrune(props.snapshot().children.values()));
  const parentModel = createMemo(() =>
    resolveSessionModel(
      props.api.state.session.get(props.sessionID),
      props.api.state.session.messages(props.sessionID),
    ),
  );

  createEffect(() => {
    const hasVisibleActive = list().visible.some((child) => isActive(child.status));
    if (!hasVisibleActive || props.collapsed()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  const measure = () => {
    if (root?.width) setWidth(Math.max(1, root.width));
  };

  return (
    <box
      ref={(value) => {
        root = value;
        queueMicrotask(measure);
      }}
      onSizeChange={measure}
      width="100%"
      flexDirection="column"
    >
      <box width="100%" onMouseUp={props.toggle}>
        <text fg={props.api.theme.current.text}>
          <b>
            {props.snapshot().loadState === "ready"
              ? headerLine(
                  summarize(props.snapshot().children.values()),
                  props.collapsed(),
                  width(),
                  props.snapshot().stale,
                )
              : truncateWidth(`${props.collapsed() ? "▶" : "▼"} Subagents`, width())}
          </b>
        </text>
      </box>

      <Show when={!props.collapsed()}>
        <Show when={props.snapshot().loadState === "loading"}>
          <text fg={props.api.theme.current.textMuted}>
            {truncateWidth("  Loading subagents…", width())}
          </text>
        </Show>
        <Show when={props.snapshot().loadState === "unavailable"}>
          <text fg={props.api.theme.current.error}>
            {truncateWidth("  Subagents unavailable", width())}
          </text>
        </Show>
        <Show when={props.snapshot().loadState === "ready" && props.snapshot().children.size === 0}>
          <text fg={props.api.theme.current.textMuted}>
            {truncateWidth("  No subagents", width())}
          </text>
        </Show>

        <For each={list().visible}>
          {(child) => {
            const lines = () =>
              rowLines(
                child,
                parentModel(),
                width(),
                now(),
                props.activities().get(child.session.id),
              );
            return (
              <box
                width="100%"
                flexDirection="column"
                onMouseUp={() => navigate(props.api, child.session.id)}
              >
                <text>
                  <span style={{ fg: statusColor(props.api, displayStatus(child)) }}>
                    {lines().prefix}
                  </span>
                  <span style={{ fg: props.api.theme.current.text }}>{lines().title}</span>
                </text>
                <Show when={lines().second} keyed>
                  {(second: string) => <text fg={props.api.theme.current.textMuted}>{second}</text>}
                </Show>
                <Show when={lines().third} keyed>
                  {(third: string) => <text fg={props.api.theme.current.textMuted}>{third}</text>}
                </Show>
              </box>
            );
          }}
        </For>

        <Show when={list().omitted > 0}>
          <text fg={props.api.theme.current.textMuted}>
            {truncateWidth(`  ${list().omitted} more subagents omitted`, width())}
          </text>
        </Show>
      </Show>
    </box>
  );
}

const tui: TuiPlugin = async (api) => {
  const [snapshot, setSnapshot] = createSignal<Snapshot>({
    children: new Map(),
    loadState: "loading",
    stale: false,
  });
  const [collapsed, setCollapsed] = createSignal(false);
  const [activities, setActivities] = createSignal<ActivityMap>(new Map());
  let kvLoaded = false;

  const controller = new ChildController({
    fetchChildren: async (parentID) => {
      const response = await api.client.session.children({ sessionID: parentID });
      if (response.error) throw response.error;
      return response.data ?? [];
    },
    status: (sessionID) => api.state.session.status(sessionID),
    onChange: setSnapshot,
    log: (level, message) => log(api, level, message),
  });
  const ensureKV = () => {
    if (kvLoaded || !api.kv.ready) return;
    kvLoaded = true;
    setCollapsed(api.kv.get<boolean>(COLLAPSED_KEY, false));
  };
  const toggle = () => {
    ensureKV();
    if (!api.kv.ready) {
      setCollapsed(false);
      return;
    }
    const next = !collapsed();
    setCollapsed(next);
    if (api.kv.ready) api.kv.set(COLLAPSED_KEY, next);
  };

  api.lifecycle.onDispose(() => controller.dispose());

  api.event.on("session.created", (event) => controller.onCreated(event.properties.info));
  api.event.on("session.updated", (event) => controller.onUpdated(event.properties.info));
  api.event.on("session.deleted", (event) => {
    controller.onDeleted(event.properties.info);
    setActivities((value) => clearActivity(value, event.properties.sessionID));
  });
  api.event.on("session.status", (event) => {
    controller.onStatus(event.properties.sessionID, event.properties.status);
    if (event.properties.status.type === "idle") {
      setActivities((value) => clearActivity(value, event.properties.sessionID));
    }
  });
  api.event.on("session.error", (event) => {
    controller.onError(event.properties.sessionID, event.properties.error);
    if (event.properties.sessionID && event.properties.error) {
      setActivities((value) => clearActivity(value, event.properties.sessionID!));
    }
  });

  const observe = (sessionID: string, label: string, timestamp: number) => {
    if (!snapshot().children.has(sessionID)) return;
    setActivities((value) => observeActivity(value, sessionID, label, timestamp));
  };
  const touch = (sessionID: string, timestamp: number) => {
    if (!snapshot().children.has(sessionID)) return;
    const previous = activities().get(sessionID);
    if (!previous || !Number.isFinite(timestamp) || timestamp - previous.observedAt < 1_000) return;
    setActivities((value) => touchActivity(value, sessionID, timestamp));
  };

  api.event.on("session.next.step.started", (event) =>
    observe(event.properties.sessionID, "thinking", event.properties.timestamp),
  );
  api.event.on("session.next.reasoning.started", (event) =>
    observe(event.properties.sessionID, "thinking", event.properties.timestamp),
  );
  api.event.on("session.next.text.started", (event) =>
    observe(event.properties.sessionID, "writing", event.properties.timestamp),
  );
  api.event.on("session.next.tool.input.started", (event) =>
    observe(event.properties.sessionID, event.properties.name, event.properties.timestamp),
  );
  api.event.on("session.next.tool.called", (event) =>
    observe(event.properties.sessionID, event.properties.tool, event.properties.timestamp),
  );
  api.event.on("session.next.shell.started", (event) =>
    observe(event.properties.sessionID, "shell", event.properties.timestamp),
  );
  api.event.on("session.next.reasoning.delta", (event) =>
    touch(event.properties.sessionID, event.properties.timestamp),
  );
  api.event.on("session.next.text.delta", (event) =>
    touch(event.properties.sessionID, event.properties.timestamp),
  );
  api.event.on("session.next.tool.input.delta", (event) =>
    touch(event.properties.sessionID, event.properties.timestamp),
  );
  api.event.on("session.next.tool.progress", (event) =>
    touch(event.properties.sessionID, event.properties.timestamp),
  );

  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_context, props) {
        return (
          <View
            api={api}
            sessionID={props.session_id}
            controller={controller}
            snapshot={snapshot}
            collapsed={collapsed}
            activities={activities}
            toggle={toggle}
            ensureKV={ensureKV}
          />
        );
      },
    },
  });

  log(api, "debug", "activated");
};

const plugin: TuiPluginModule & { id: string } = {
  id: PLUGIN_ID,
  tui,
};

export default plugin;
