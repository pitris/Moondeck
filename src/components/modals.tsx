import {
  ConfirmModal,
  DialogButton,
  DropdownItem,
  Focusable,
  ModalRoot,
  SteamSpinner,
  TextField,
  showModal,
} from "@decky/ui";
import { addEventListener, removeEventListener } from "@decky/api";
import { ReactElement, useEffect, useState } from "react";
import { refreshApps } from "../backend";

/** Show a modal and resolve with the value passed to `done` (or `cancelValue` on B/close). */
export function ask<T>(build: (done: (v: T) => void) => ReactElement, cancelValue: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    let handle: { Close: () => void } | null = null;
    const done = (v: T) => {
      if (settled) return;
      settled = true;
      handle?.Close();
      resolve(v);
    };
    handle = showModal(build(done), undefined, { fnOnClose: () => done(cancelValue) });
  });
}

export function alertModal(title: string, description: ReactElement | string): Promise<void> {
  return ask<void>((done) => (
    <ConfirmModal
      strTitle={title}
      strDescription={description}
      bAlertDialog
      strOKButtonText="OK"
      onOK={() => done()}
      onCancel={() => done()}
    />
  ), undefined);
}

export type OfflineChoice = "retry" | "wake" | "cancel";

export function offlineModal(message: string, canWake: boolean): Promise<OfflineChoice> {
  return ask<OfflineChoice>((done) => (
    <ConfirmModal
      strTitle="Gaming PC is offline"
      strDescription={message}
      strOKButtonText={canWake ? "Wake PC and retry" : "Retry"}
      strCancelButtonText="Cancel"
      onOK={() => done(canWake ? "wake" : "retry")}
      onCancel={() => done("cancel")}
    />
  ), "cancel");
}

export type PickResult = { kind: "map"; name: string } | { kind: "create" } | null;

interface PickerProps {
  gameName: string;
  reason: string;
  candidates: string[];
  apps: string[];
  canCreate: boolean;
  done: (r: PickResult) => void;
}

export const AppPicker = ({ gameName, reason, candidates, apps: initialApps, canCreate, done }: PickerProps) => {
  const [apps, setApps] = useState(initialApps);
  const [selected, setSelected] = useState<string | null>(candidates[0] ?? null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const reload = async () => {
    setBusy(true);
    setNote(null);
    const r = await refreshApps();
    setBusy(false);
    if (r.ok) {
      setApps(r.apps.filter((a) => !a.hidden).map((a) => a.name));
      setNote(`Loaded ${r.apps.length} apps from ${r.source === "apollo_web" ? "Apollo web UI" : "Moonlight"}.`);
    } else {
      setNote(r.message);
    }
  };

  const others = apps.filter((a) => !candidates.includes(a));

  return (
    <ModalRoot onCancel={() => done(null)} bAllowFullSize>
      <div style={{ fontSize: "1.4em", fontWeight: 700, marginBottom: 6 }}>Moonlight: choose the Apollo app</div>
      <div style={{ opacity: 0.8, marginBottom: 12 }}>
        Which app on your PC should be streamed for <b>{gameName}</b>? {reason}. Your choice is remembered.
      </div>
      <Focusable style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {canCreate && (
          <DialogButton onClick={() => done({ kind: "create" })}>
            ➕ Add “{gameName}” to Apollo on the PC (or repair it)
          </DialogButton>
        )}
        {candidates.map((c) => (
          <DialogButton key={c} onClick={() => done({ kind: "map", name: c })}>
            Stream “{c}”
          </DialogButton>
        ))}
        {others.length > 0 && (
          <DropdownItem
            label={candidates.length ? "Other Apollo apps" : "Apollo apps"}
            rgOptions={others.map((a) => ({ data: a, label: a }))}
            selectedOption={selected && others.includes(selected) ? selected : null}
            strDefaultLabel="Select an app…"
            onChange={(o) => setSelected(o.data as string)}
          />
        )}
        {selected && others.includes(selected) && (
          <DialogButton onClick={() => done({ kind: "map", name: selected })}>Stream “{selected}”</DialogButton>
        )}
        <TextField
          label="Or type the exact Apollo app name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        {typed.trim() && (
          <DialogButton onClick={() => done({ kind: "map", name: typed.trim() })}>Use “{typed.trim()}”</DialogButton>
        )}
        <DialogButton disabled={busy} onClick={reload}>{busy ? "Loading…" : "Reload app list from PC"}</DialogButton>
        {note && <div style={{ opacity: 0.8 }}>{note}</div>}
        <DialogButton onClick={() => done(null)}>Cancel</DialogButton>
      </Focusable>
    </ModalRoot>
  );
};

export function pickApp(props: Omit<PickerProps, "done">): Promise<PickResult> {
  return ask<PickResult>((done) => <AppPicker {...props} done={done} />, null);
}

interface ProgressPayload { stage: string; message: string }

const ProgressBody = ({ title, initial, onCancel }: { title: string; initial: string; onCancel: () => void }) => {
  const [msg, setMsg] = useState(initial);
  useEffect(() => {
    const listener = addEventListener<[ProgressPayload]>("launch_progress", (p) => setMsg(p.message));
    return () => removeEventListener("launch_progress", listener);
  }, []);
  return (
    <ModalRoot onCancel={onCancel} bHideCloseIcon>
      <div style={{ display: "flex", alignItems: "center", gap: 16, minHeight: 80 }}>
        <div style={{ width: 48, height: 48 }}><SteamSpinner background="transparent" /></div>
        <div>
          <div style={{ fontSize: "1.3em", fontWeight: 700 }}>{title}</div>
          <div style={{ opacity: 0.8 }}>{msg}</div>
        </div>
      </div>
    </ModalRoot>
  );
};

/** Non-blocking progress dialog. Returns a function that closes it. */
export function showProgress(title: string, initial: string, onCancel: () => void): () => void {
  let closed = false;
  const handle = showModal(
    <ProgressBody title={title} initial={initial} onCancel={() => { if (!closed) { closed = true; onCancel(); } }} />,
    undefined,
    { fnOnClose: () => { if (!closed) { closed = true; onCancel(); } } },
  );
  return () => {
    if (!closed) {
      closed = true;
      handle.Close();
    }
  };
}
