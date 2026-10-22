"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown, Search, X } from "lucide-react";

export type SortDirection = "asc" | "desc";

export function TableSearch({
  value,
  onChange,
  placeholder,
  label = placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <label className="table-search">
      <Search size={14} aria-hidden="true" />
      <input
        aria-label={label}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
      {value ? (
        <button type="button" onClick={() => onChange("")} aria-label={`Clear ${label.toLowerCase()}`}>
          <X size={13} />
        </button>
      ) : null}
    </label>
  );
}

export function SortHeader<T extends string>({
  label,
  field,
  activeField,
  direction,
  onSort,
}: {
  label: string;
  field: T;
  activeField: T;
  direction: SortDirection;
  onSort: (field: T) => void;
}) {
  const active = activeField === field;
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <button
      className={`sort-header ${active ? "active" : ""}`}
      type="button"
      onClick={() => onSort(field)}
      aria-label={`Sort by ${label}${active ? `, currently ${direction === "asc" ? "ascending" : "descending"}` : ""}`}
    >
      <span>{label}</span>
      <Icon size={12} aria-hidden="true" />
    </button>
  );
}

export function nextSort<T extends string>(
  currentField: T,
  currentDirection: SortDirection,
  field: T,
): { field: T; direction: SortDirection } {
  return {
    field,
    direction: currentField === field && currentDirection === "asc" ? "desc" : "asc",
  };
}

export function compareValues(left: string | number, right: string | number, direction: SortDirection): number {
  const multiplier = direction === "asc" ? 1 : -1;
  if (typeof left === "number" && typeof right === "number") return (left - right) * multiplier;
  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }) * multiplier;
}

export function TablePagination({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (page: number) => void }) {
  if (pageCount <= 1) return null;
  return <nav className="table-pagination" aria-label="Table pages"><button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button><span>Page {page} of {pageCount}</span><button type="button" disabled={page >= pageCount} onClick={() => onPage(page + 1)}>Next</button></nav>;
}
