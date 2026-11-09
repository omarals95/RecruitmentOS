"use client";

import { useEffect, useId, useRef, useState } from "react";
import { humanError } from "@/components/workspace/client";
import type { Requester } from "@/components/workspace/optimistic";
import type { OrgUnit } from "@/lib/org";

interface Page<T> {
  data: T[];
  pagination: { page: number; pageSize: number; hasMore: boolean };
}
/** One select of the picker: the current units below `parentId` (null for the top level). */
export interface PickerLevel {
  parentId: string | null;
  parentName: string;
  units: OrgUnit[];
  hasMore: boolean;
  chosen: string;
}

export const PICKER_PAGE_SIZE = 200;
/** One chart level, the route's page cap; architecture section 12 expects at most 2,000 units. */
export const pickerPath = (parentId: string | null) =>
  `/api/v1/org-units?${parentId ? `parentId=${parentId}&` : ""}page=1&pageSize=${PICKER_PAGE_SIZE}`;

/**
 * Cascading labelled selects that load one level at a time: the top level first, then the units
 * below each choice. `onChange` gets the deepest chosen unit, or null when none is chosen.
 */
export function UnitPicker({
  request,
  label,
  emptyLabel,
  disabled = false,
  onChange,
}: {
  request: Requester;
  label: string;
  /** The empty option of the top select, such as "Any unit" or "Top level". */
  emptyLabel: string;
  disabled?: boolean;
  onChange: (unit: OrgUnit | null) => void;
}) {
  const [levels, setLevels] = useState<PickerLevel[] | null>(null);
  const [error, setError] = useState("");
  // Only the answer to the latest choice is applied.
  const latest = useRef(0);
  const loaded = (parent: OrgUnit | null, page: Page<OrgUnit>) => ({
    parentId: parent?.id ?? null,
    parentName: parent?.name ?? "",
    units: page.data,
    hasMore: page.pagination.hasMore,
    chosen: "",
  });
  // The top level once, when the picker opens.
  useEffect(() => {
    let active = true;
    request<Page<OrgUnit>>(pickerPath(null))
      .then((page) => {
        if (active) setLevels([loaded(null, page)]);
      })
      .catch((e) => {
        if (active) setError(humanError(e));
      });
    return () => {
      active = false;
    };
  }, [request]);
  const load = (parent: OrgUnit, depth: number) => {
    const seq = ++latest.current;
    setError("");
    request<Page<OrgUnit>>(pickerPath(parent.id))
      .then((page) => {
        if (seq === latest.current)
          setLevels((list) => [
            ...(list ?? []).slice(0, depth),
            loaded(parent, page),
          ]);
      })
      .catch((e) => {
        if (seq === latest.current) setError(humanError(e));
      });
  };
  function choose(depth: number, id: string) {
    if (!levels) return;
    const unit = levels[depth].units.find((item) => item.id === id) ?? null;
    const parent =
      depth > 0
        ? (levels[depth - 1].units.find(
            (item) => item.id === levels[depth - 1].chosen,
          ) ?? null)
        : null;
    latest.current++;
    setLevels(
      levels
        .slice(0, depth + 1)
        .map((level, index) =>
          index === depth ? { ...level, chosen: id } : level,
        ),
    );
    onChange(unit ?? parent);
    if (unit?.hasChildren) load(unit, depth + 1);
  }
  return (
    <UnitPickerView
      levels={levels}
      label={label}
      emptyLabel={emptyLabel}
      error={error}
      disabled={disabled}
      onChoose={choose}
    />
  );
}

export function UnitPickerView({
  levels,
  label,
  emptyLabel,
  error,
  disabled = false,
  onChoose = () => {},
}: {
  levels: PickerLevel[] | null;
  label: string;
  emptyLabel: string;
  error: string;
  disabled?: boolean;
  onChoose?: (depth: number, id: string) => void;
}) {
  const id = useId();
  return (
    <div className="stack" style={{ gap: 10 }}>
      {!levels && !error && <p role="status">Loading units…</p>}
      {levels &&
        levels.map((level, depth) => (
          <label key={level.parentId ?? "top"} className="field">
            <span>
              {depth === 0 ? label : `Unit below ${level.parentName}`}
            </span>
            <select
              value={level.chosen}
              disabled={disabled}
              aria-describedby={level.hasMore ? `${id}-${depth}` : undefined}
              onChange={(event) => onChoose(depth, event.target.value)}
            >
              <option value="">
                {depth === 0
                  ? emptyLabel
                  : `Choose a unit below ${level.parentName} (optional)`}
              </option>
              {level.units.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.name} ({unit.code})
                </option>
              ))}
            </select>
            {level.hasMore && (
              <small id={`${id}-${depth}`}>
                Only the first {PICKER_PAGE_SIZE} units at this level are
                listed.
              </small>
            )}
          </label>
        ))}
      {error && (
        <p className="notice error" role="alert">
          Could not load the units. {error}
        </p>
      )}
    </div>
  );
}
