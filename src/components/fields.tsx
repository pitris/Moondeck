import { DropdownItem, TextField, ToggleField } from "@decky/ui";
import { toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { DeepPartial, Settings } from "../backend";
import { settingsStore } from "../store";

export async function saveOrToast(patch: DeepPartial<Settings>): Promise<boolean> {
  const err = await settingsStore.save(patch);
  if (err) {
    toaster.toast({ title: "Moondeck Apollo", body: err });
    return false;
  }
  return true;
}

interface TextProps {
  label: string;
  description?: string;
  value: string;
  password?: boolean;
  placeholder?: string;
  toPatch: (v: string) => DeepPartial<Settings>;
}

/** Text setting that saves when focus leaves the field (works with the on-screen keyboard). */
export const SettingText = ({ label, description, value, password, placeholder, toPatch }: TextProps) => {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <TextField
      label={label}
      description={description}
      value={v}
      bIsPassword={password}
      placeholder={placeholder}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v !== value) saveOrToast(toPatch(v)).then((ok) => { if (!ok) setV(value); });
      }}
    />
  );
};

export const SettingToggle = ({ label, description, value, toPatch }: {
  label: string; description?: string; value: boolean; toPatch: (v: boolean) => DeepPartial<Settings>;
}) => (
  <ToggleField label={label} description={description} checked={value} onChange={(v) => saveOrToast(toPatch(v))} />
);

export function SettingChoice<T extends string>({ label, description, value, options, toPatch }: {
  label: string; description?: string; value: T; options: [T, string][]; toPatch: (v: T) => DeepPartial<Settings>;
}) {
  return (
    <DropdownItem
      label={label}
      description={description}
      rgOptions={options.map(([data, l]) => ({ data, label: l }))}
      selectedOption={value}
      onChange={(o) => saveOrToast(toPatch(o.data as T))}
    />
  );
}
