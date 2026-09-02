import * as React from "react";
import { sanitizeProcessName } from "@lantern/reporter";
import { ArrowDownIcon } from "./icons/ArrowDownIcon";

interface Data {
  name: string;
  averageCpuUsage: number;
  currentCpuUsage: number;
}

function descendingComparator<T>(a: T, b: T, orderBy: keyof T) {
  if (b[orderBy] < a[orderBy]) {
    return -1;
  }
  if (b[orderBy] > a[orderBy]) {
    return 1;
  }
  return 0;
}

type Order = "asc" | "desc";

function getComparator<Key extends string>(
  order: Order,
  orderBy: Key
): (a: { [key in Key]: number | string }, b: { [key in Key]: number | string }) => number {
  return order === "desc"
    ? (a, b) => descendingComparator(a, b, orderBy)
    : (a, b) => -descendingComparator(a, b, orderBy);
}

export interface HeadCell {
  disablePadding: boolean;
  id: keyof Data;
  label: string;
  numeric: boolean;
}

const CELL_CLASS_NAME = "text-neutral-300 border-b border-neutral-500 px-2 py-1.5 text-sm";

interface EnhancedTableProps {
  headCells: HeadCell[];
  onRequestSort: (event: React.MouseEvent<unknown>, property: keyof Data) => void;
  order: Order;
  orderBy: string;
}

function EnhancedTableHead({ headCells, order, orderBy, onRequestSort }: EnhancedTableProps) {
  return (
    <thead>
      <tr>
        <th className={`${CELL_CLASS_NAME} sticky top-0 bg-dark-charcoal w-12`} />
        {headCells.map((headCell) => {
          const active = orderBy === headCell.id;
          const direction = active ? order : "asc";

          return (
            <th
              key={headCell.id}
              scope="col"
              aria-sort={active ? (order === "desc" ? "descending" : "ascending") : undefined}
              className={`${CELL_CLASS_NAME} sticky top-0 bg-dark-charcoal ${
                headCell.numeric ? "text-right" : "text-left"
              } ${headCell.disablePadding ? "px-0" : ""}`}
            >
              <button
                type="button"
                onClick={(event) => onRequestSort(event, headCell.id)}
                className="group inline-flex items-center text-white"
                style={{ fontWeight: active ? 700 : 400 }}
              >
                {headCell.label}
                {/* Hidden until hovered on inactive columns, like MUI's sort label; points down
                    for descending and is flipped for ascending */}
                <ArrowDownIcon
                  size={18}
                  className={`ml-1 transition-transform ${direction === "asc" ? "rotate-180" : ""} ${
                    active ? "opacity-100" : "opacity-0 group-hover:opacity-50"
                  }`}
                />
                {active ? (
                  <span className="sr-only">
                    {order === "desc" ? "sorted descending" : "sorted ascending"}
                  </span>
                ) : null}
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}

export default function EnhancedTable({
  rows,
  selected,
  setSelected,
  headCells,
}: {
  rows: Data[];
  selected: string[];
  setSelected: (threads: string[]) => void;
  headCells: HeadCell[];
}) {
  const [order, setOrder] = React.useState<Order>("desc");
  const [orderBy, setOrderBy] = React.useState<keyof Data>(headCells[1].id);

  const handleRequestSort = (event: React.MouseEvent<unknown>, property: keyof Data) => {
    const isAsc = orderBy === property && order === "asc";
    setOrder(isAsc ? "desc" : "asc");
    setOrderBy(property);
  };

  const toggle = (name: string) => {
    setSelected(
      selected.includes(name) ? selected.filter((thread) => thread !== name) : [...selected, name]
    );
  };

  const isSelected = (name: string) => selected.indexOf(name) !== -1;

  return (
    <div className="max-h-[400px] overflow-auto">
      <table className="w-full border-collapse">
        <EnhancedTableHead
          headCells={headCells}
          order={order}
          orderBy={orderBy}
          onRequestSort={handleRequestSort}
        />
        <tbody>
          {/* `Array.prototype.sort` is stable; the copy keeps the `rows` prop untouched. */}
          {[...rows].sort(getComparator(order, orderBy)).map((row, index) => {
            const isItemSelected = isSelected(row.name);
            const labelId = `enhanced-table-checkbox-${index}`;

            return (
              <tr
                onClick={() => toggle(row.name)}
                role="checkbox"
                aria-checked={isItemSelected}
                tabIndex={-1}
                key={row.name}
                className={`cursor-pointer hover:bg-white/5 ${isItemSelected ? "bg-white/10" : ""}`}
              >
                <td className={`${CELL_CLASS_NAME} text-center`}>
                  <input
                    type="checkbox"
                    checked={isItemSelected}
                    aria-labelledby={labelId}
                    // The row handles the toggle: a change event still fires on the input so
                    // keyboard users get the same behaviour, without toggling twice on click
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => toggle(row.name)}
                    className="accent-theme-color"
                  />
                </td>
                <th
                  scope="row"
                  id={labelId}
                  className={`${CELL_CLASS_NAME} px-0 text-left font-normal`}
                >
                  {sanitizeProcessName(row.name)}
                </th>
                {headCells.slice(1).map((headCell) => (
                  <td key={headCell.id} className={`${CELL_CLASS_NAME} text-right`}>
                    {row[headCell.id]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
