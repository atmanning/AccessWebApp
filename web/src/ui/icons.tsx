import type { ReactNode } from "react";

type P = { size?: number; className?: string };
const svg = (children: ReactNode, viewBox = "0 0 16 16") =>
  function Icon({ size = 16, className }: P) {
    return (
      <svg width={size} height={size} viewBox={viewBox} className={className} aria-hidden="true" focusable="false">
        {children}
      </svg>
    );
  };

export const TableIcon = svg(
  <>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#fff" stroke="#3b6ea5" />
    <rect x="1.5" y="2.5" width="13" height="3" fill="#3b6ea5" />
    <path d="M1.5 9h13M6 5.5v8M10.5 5.5v8" stroke="#3b6ea5" />
  </>,
);
export const QueryIcon = svg(
  <>
    <rect x="1.5" y="1.5" width="9" height="8" rx="1" fill="#fff" stroke="#6d5aa6" />
    <path d="M1.5 4.5h9M5 4.5v5" stroke="#6d5aa6" />
    <circle cx="10.5" cy="10.5" r="3" fill="#fff" stroke="#6d5aa6" strokeWidth="1.4" />
    <path d="M12.6 12.6l2 2" stroke="#6d5aa6" strokeWidth="1.8" strokeLinecap="round" />
  </>,
);
export const FormIcon = svg(
  <>
    <rect x="1.5" y="1.5" width="13" height="13" rx="1" fill="#fff" stroke="#2e7d4f" />
    <rect x="1.5" y="1.5" width="13" height="3" fill="#2e7d4f" />
    <path d="M3.5 7h3M3.5 10h3M3.5 13h0" stroke="#2e7d4f" />
    <rect x="7.5" y="6" width="5" height="2" fill="none" stroke="#2e7d4f" />
    <rect x="7.5" y="9" width="5" height="2" fill="none" stroke="#2e7d4f" />
  </>,
);
export const ReportIcon = svg(
  <>
    <path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#b5562b" />
    <path d="M10 1.5v3h3" fill="none" stroke="#b5562b" />
    <path d="M5 7h6M5 9h6M5 11h4" stroke="#b5562b" />
  </>,
);
export const KeyIcon = svg(
  <>
    <circle cx="5" cy="8" r="3" fill="#f2c94c" stroke="#9a7a12" />
    <circle cx="4.3" cy="8" r=".9" fill="#9a7a12" />
    <path d="M8 8h6.5M12 8v2.5M14 8v2" stroke="#9a7a12" strokeWidth="1.3" />
  </>,
);
export const DatasheetIcon = TableIcon;
export const DesignIcon = svg(
  <>
    <rect x="1.5" y="2.5" width="9" height="11" fill="#fff" stroke="#555" />
    <path d="M3 5.5h6M3 8h6M3 10.5h4" stroke="#555" />
    <path d="M9.5 13.5l1-3 4-4 2 2-4 4z" fill="#f2c94c" stroke="#7a5d00" strokeWidth=".8" />
  </>,
);
export const SqlIcon = svg(
  <>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#fff" stroke="#555" />
    <text x="8" y="11" textAnchor="middle" fontSize="6" fontFamily="Consolas, monospace" fontWeight="700" fill="#6d5aa6">
      SQL
    </text>
  </>,
);
export const RunIcon = svg(<path d="M8 1.5L5 9h3l-1 5.5L12 6H8.5l1.5-4.5z" fill="#d13438" stroke="#8a1c1f" strokeWidth=".6" />);
export const NewRecordIcon = svg(
  <>
    <rect x="1.5" y="3.5" width="11" height="9" fill="#fff" stroke="#3b6ea5" />
    <path d="M11.5 1v5M9 3.5h5" stroke="#2e7d4f" strokeWidth="1.6" />
  </>,
);
export const DeleteIcon = svg(<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="#c42b1c" strokeWidth="2" strokeLinecap="round" />);
export const SortAscIcon = svg(
  <>
    <text x="1" y="7" fontSize="6" fontWeight="700" fill="#333">A</text>
    <text x="1" y="14.5" fontSize="6" fontWeight="700" fill="#333">Z</text>
    <path d="M11.5 2v11M9 10.5l2.5 2.5 2.5-2.5" stroke="#3b6ea5" strokeWidth="1.4" fill="none" />
  </>,
);
export const SortDescIcon = svg(
  <>
    <text x="1" y="7" fontSize="6" fontWeight="700" fill="#333">Z</text>
    <text x="1" y="14.5" fontSize="6" fontWeight="700" fill="#333">A</text>
    <path d="M11.5 2v11M9 10.5l2.5 2.5 2.5-2.5" stroke="#3b6ea5" strokeWidth="1.4" fill="none" />
  </>,
);
export const RefreshIcon = svg(
  <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2v3h-3" stroke="#2e7d4f" strokeWidth="1.5" fill="none" strokeLinecap="round" />,
);
export const SaveIcon = svg(
  <>
    <path d="M2 2h10l2 2v10H2z" fill="#3b6ea5" />
    <rect x="4.5" y="2" width="6" height="4" fill="#fff" />
    <rect x="4" y="9" width="8" height="5" fill="#fff" />
  </>,
);
export const UndoIcon = svg(<path d="M4 6h6a3.5 3.5 0 0 1 0 7H6M4 6l3-3M4 6l3 3" stroke="#333" strokeWidth="1.4" fill="none" strokeLinecap="round" />);
export const RedoIcon = svg(<path d="M12 6H6a3.5 3.5 0 0 0 0 7h4M12 6L9 3M12 6L9 9" stroke="#333" strokeWidth="1.4" fill="none" strokeLinecap="round" />);
export const AccessIcon = svg(
  <>
    <rect x="3" y="1" width="12" height="14" rx="1.5" fill="#c74634" />
    <ellipse cx="9" cy="4.5" rx="4" ry="1.6" fill="#fff" opacity=".9" />
    <path d="M5 4.5v6c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6v-6" fill="none" stroke="#fff" opacity=".9" />
    <path d="M5 7.5c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6" fill="none" stroke="#fff" opacity=".9" />
    <rect x="0.5" y="4" width="7" height="8" rx="1" fill="#a4373a" />
    <text x="4" y="10.6" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial">A</text>
  </>,
);
export const ExportAccessIcon = svg(
  <>
    <rect x="1" y="3" width="10" height="12" rx="1" fill="#c74634" />
    <text x="6" y="12" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial">A</text>
    <path d="M10 6h5M12.5 3.5L15 6l-2.5 2.5" stroke="#2e7d4f" strokeWidth="1.5" fill="none" />
  </>,
);
export const ImportAccessIcon = svg(
  <>
    <rect x="5" y="3" width="10" height="12" rx="1" fill="#c74634" />
    <text x="10" y="12" textAnchor="middle" fontSize="7" fontWeight="700" fill="#fff" fontFamily="Segoe UI, Arial">A</text>
    <path d="M1 6h5M3.5 3.5L6 6 3.5 8.5" stroke="#2e7d4f" strokeWidth="1.5" fill="none" />
  </>,
);
export const TextFileIcon = svg(
  <>
    <path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#555" />
    <path d="M5 7h6M5 9h6M5 11h6" stroke="#888" />
  </>,
);
export const ImportIcon = svg(
  <>
    <path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#555" />
    <path d="M8 5v6M5.5 8.5L8 11l2.5-2.5" stroke="#2e7d4f" strokeWidth="1.5" fill="none" />
  </>,
);
export const RelationshipsIcon = svg(
  <>
    <rect x="1" y="2" width="5" height="7" fill="#fff" stroke="#3b6ea5" />
    <rect x="10" y="7" width="5" height="7" fill="#fff" stroke="#3b6ea5" />
    <path d="M6 5h2.5v6H10" stroke="#333" fill="none" />
  </>,
);
export const InsertRowIcon = svg(
  <>
    <path d="M1.5 4.5h13M1.5 11.5h13" stroke="#888" />
    <rect x="1.5" y="6" width="13" height="4" fill="#d6e4f5" stroke="#3b6ea5" />
    <path d="M13 1v4M11 3h4" stroke="#2e7d4f" strokeWidth="1.4" />
  </>,
);
export const DeleteRowIcon = svg(
  <>
    <path d="M1.5 4.5h13M1.5 11.5h13" stroke="#888" />
    <rect x="1.5" y="6" width="13" height="4" fill="#f6d5d1" stroke="#c42b1c" />
  </>,
);
export const ShowTableIcon = svg(
  <>
    <rect x="1.5" y="3.5" width="9" height="9" fill="#fff" stroke="#3b6ea5" />
    <path d="M1.5 6.5h9M5.5 6.5v6" stroke="#3b6ea5" />
    <path d="M13 6v6M10 9h6" stroke="#2e7d4f" strokeWidth="1.6" />
  </>,
);
export const PrintIcon = svg(
  <>
    <rect x="4" y="1.5" width="8" height="4" fill="#fff" stroke="#555" />
    <rect x="1.5" y="5.5" width="13" height="6" rx="1" fill="#ddd" stroke="#555" />
    <rect x="4" y="9.5" width="8" height="5" fill="#fff" stroke="#555" />
  </>,
);
export const FindIcon = svg(
  <>
    <circle cx="6.5" cy="6.5" r="4" fill="#fff" stroke="#333" strokeWidth="1.4" />
    <path d="M9.5 9.5l5 5" stroke="#333" strokeWidth="1.8" strokeLinecap="round" />
  </>,
);
export const ChevronIcon = svg(<path d="M5 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" fill="none" />);
export const CloseIcon = svg(<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" />);
export const PlusIcon = svg(<path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="1.6" />);
export const BackIcon = svg(
  <>
    <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
    <path d="M9.5 4.5L6 8l3.5 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" />
  </>,
);
export const FilterIcon = svg(<path d="M1.5 2.5h13L9.5 8.5v5l-3 1.5v-6.5z" fill="#fff" stroke="#333" />);

// Query type icons (Access shows each action query type with its own symbol).
export const MakeTableQueryIcon = svg(
  <>
    <rect x="1.5" y="3.5" width="10" height="9" fill="#fff" stroke="#6d5aa6" />
    <path d="M1.5 6.5h10M5 6.5v6" stroke="#6d5aa6" />
    <path d="M13 1.5l.7 1.5 1.6.2-1.2 1.1.3 1.6-1.4-.8-1.4.8.3-1.6-1.2-1.1 1.6-.2z" fill="#f2c94c" stroke="#9a7a12" strokeWidth=".5" />
  </>,
);
export const AppendQueryIcon = svg(
  <>
    <rect x="1.5" y="3.5" width="10" height="9" fill="#fff" stroke="#6d5aa6" />
    <path d="M1.5 6.5h10M5 6.5v6" stroke="#6d5aa6" />
    <path d="M13 9v6M10 12h6" stroke="#2e7d4f" strokeWidth="1.8" />
  </>,
);
export const UpdateQueryIcon = svg(
  <>
    <rect x="1.5" y="3.5" width="10" height="9" fill="#fff" stroke="#6d5aa6" />
    <path d="M1.5 6.5h10M5 6.5v6" stroke="#6d5aa6" />
    <path d="M9 15l.8-2.6L14 8.2l1.8 1.8-4.2 4.2z" fill="#f2c94c" stroke="#7a5d00" strokeWidth=".7" />
  </>,
);
export const DeleteQueryIcon = svg(
  <>
    <rect x="1.5" y="3.5" width="10" height="9" fill="#fff" stroke="#6d5aa6" />
    <path d="M1.5 6.5h10M5 6.5v6" stroke="#6d5aa6" />
    <path d="M10.5 9.5l5 5M15.5 9.5l-5 5" stroke="#c42b1c" strokeWidth="1.8" strokeLinecap="round" />
  </>,
);
export const CrosstabQueryIcon = svg(
  <>
    <rect x="1.5" y="1.5" width="13" height="13" fill="#fff" stroke="#6d5aa6" />
    <rect x="1.5" y="1.5" width="13" height="3.5" fill="#d9d2ee" stroke="#6d5aa6" />
    <rect x="1.5" y="1.5" width="4" height="13" fill="#d9d2ee" stroke="#6d5aa6" />
    <path d="M5.5 8.5h9M5.5 11.5h9M9.5 5v9.5" stroke="#6d5aa6" />
  </>,
);
export const TotalsIcon = svg(<text x="8" y="13" textAnchor="middle" fontSize="14" fontWeight="700" fill="#333" fontFamily="Segoe UI, Arial">Σ</text>);

export const LinkedTableIcon = svg(
  <>
    <rect x="3.5" y="2.5" width="11" height="10" rx="1" fill="#fff" stroke="#3b6ea5" />
    <rect x="3.5" y="2.5" width="11" height="3" fill="#3b6ea5" />
    <path d="M3.5 8.5h11M8 5.5v7" stroke="#3b6ea5" />
    <path d="M1 15l4.5-4.5M2.5 10.5h3v3" stroke="#2e7d4f" strokeWidth="1.6" fill="none" />
  </>,
);
export const DatabaseServerIcon = svg(
  <>
    <ellipse cx="8" cy="3.5" rx="5.5" ry="2" fill="#e5f1fb" stroke="#0b5cad" />
    <path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9" fill="#e5f1fb" stroke="#0b5cad" />
    <path d="M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2" fill="none" stroke="#0b5cad" />
  </>,
);
export const ConsoleIcon = svg(
  <>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="#1f2d3d" />
    <path d="M4 6l2 2-2 2M7.5 10.5h4" stroke="#7fd47f" strokeWidth="1.3" fill="none" />
  </>,
);
export const CopyIcon = svg(
  <>
    <rect x="5.5" y="1.5" width="9" height="10" fill="#fff" stroke="#555" />
    <rect x="1.5" y="4.5" width="9" height="10" fill="#fff" stroke="#555" />
  </>,
);
export const PasteIcon = svg(
  <>
    <rect x="2.5" y="2.5" width="11" height="12" rx="1" fill="#d9c49a" stroke="#7a5d00" />
    <rect x="5.5" y="1" width="5" height="3" rx="1" fill="#fff" stroke="#555" />
    <rect x="6.5" y="6.5" width="8" height="8.5" fill="#fff" stroke="#555" />
  </>,
);

/** Two stacked databases: another database in this app. */
export const OtherDbIcon = svg(
  <>
    <ellipse cx="6" cy="4" rx="4.5" ry="1.8" fill="#fff" stroke="#a4373a" />
    <path d="M1.5 4v6c0 1 2 1.8 4.5 1.8" fill="none" stroke="#a4373a" />
    <path d="M10.5 4v2.5" stroke="#a4373a" />
    <ellipse cx="10" cy="8.5" rx="4.5" ry="1.8" fill="#fff" stroke="#3b6ea5" />
    <path d="M5.5 8.5v4c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8v-4" fill="#fff" stroke="#3b6ea5" />
  </>,
);

export const OBJECT_ICONS = { table: TableIcon, query: QueryIcon, form: FormIcon, report: ReportIcon, linked: LinkedTableIcon } as const;
