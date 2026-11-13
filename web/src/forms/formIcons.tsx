import type { ReactNode } from "react";
import type { FormControlType } from "../../../shared/model";

type P = { size?: number };
const svg = (children: ReactNode) =>
  function Icon({ size = 16 }: P) {
    return (
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {children}
      </svg>
    );
  };

const C = "#3b6ea5";
export const CONTROL_ICONS: Record<FormControlType, (p: P) => ReactNode> = {
  label: svg(<text x="2" y="12.5" fontSize="11" fontWeight="700" fill={C} fontFamily="Segoe UI, Arial">Aa</text>),
  textbox: svg(
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" fill="#fff" stroke={C} />
      <path d="M4 6.5v3" stroke="#222" />
    </>,
  ),
  combobox: svg(
    <>
      <rect x="1.5" y="4.5" width="13" height="7" rx="1.5" fill="#fff" stroke={C} />
      <path d="M10.5 4.5v7" stroke={C} />
      <path d="M11.6 7l1.4 1.6L14.4 7" fill="none" stroke="#222" transform="translate(-0.8 0)" />
    </>,
  ),
  listbox: svg(
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="1.5" fill="#fff" stroke={C} />
      <rect x="2.5" y="5.5" width="11" height="3" fill="#cfe0f3" />
      <path d="M4 4h7M4 7h7M4 10h7M4 12.5h5" stroke="#555" />
    </>,
  ),
  checkbox: svg(
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="#fff" stroke={C} />
      <path d="M4.8 8.2l2.2 2.2 4.2-4.6" fill="none" stroke="#2e7d4f" strokeWidth="1.8" />
    </>,
  ),
  button: svg(
    <>
      <rect x="1" y="4" width="14" height="8" rx="2.5" fill={C} />
      <path d="M5 8h6" stroke="#fff" strokeWidth="1.4" />
    </>,
  ),
  image: svg(
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="#fff" stroke={C} />
      <circle cx="5.5" cy="6" r="1.4" fill="#f2c94c" />
      <path d="M2.5 12.5l4-4 2.5 2.5 2-2 3 3.5" fill="none" stroke="#2e7d4f" strokeWidth="1.2" />
    </>,
  ),
  rectangle: svg(<rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke={C} strokeWidth="1.3" />),
  line: svg(<path d="M2 13L14 3" stroke={C} strokeWidth="1.6" />),
};

const A = "#444";
export const AlignLeftIcon = svg(<><path d="M2 1v14" stroke={A} /><rect x="3" y="3" width="9" height="3" fill={C} /><rect x="3" y="9" width="6" height="3" fill={C} /></>);
export const AlignRightIcon = svg(<><path d="M14 1v14" stroke={A} /><rect x="4" y="3" width="9" height="3" fill={C} /><rect x="7" y="9" width="6" height="3" fill={C} /></>);
export const AlignTopIcon = svg(<><path d="M1 2h14" stroke={A} /><rect x="3" y="3" width="3" height="9" fill={C} /><rect x="9" y="3" width="3" height="6" fill={C} /></>);
export const AlignBottomIcon = svg(<><path d="M1 14h14" stroke={A} /><rect x="3" y="4" width="3" height="9" fill={C} /><rect x="9" y="7" width="3" height="6" fill={C} /></>);
export const SameWidthIcon = svg(<><rect x="2" y="2" width="12" height="4" fill="#fff" stroke={C} /><rect x="2" y="10" width="12" height="4" fill="#fff" stroke={C} /><path d="M2 8h12" stroke={A} strokeDasharray="2 1" /></>);
export const SameHeightIcon = svg(<><rect x="2" y="2" width="4" height="12" fill="#fff" stroke={C} /><rect x="10" y="2" width="4" height="12" fill="#fff" stroke={C} /><path d="M8 2v12" stroke={A} strokeDasharray="2 1" /></>);
export const FrontIcon = svg(<><rect x="1.5" y="1.5" width="8" height="8" fill="#ddd" stroke="#888" /><rect x="6.5" y="6.5" width="8" height="8" fill={C} stroke={C} /></>);
export const BackIcon = svg(<><rect x="6.5" y="6.5" width="8" height="8" fill="#ddd" stroke="#888" /><rect x="1.5" y="1.5" width="8" height="8" fill="#fff" stroke={C} /></>);
export const StackedIcon = svg(<><rect x="2" y="2" width="12" height="3" fill="#fff" stroke={C} /><rect x="2" y="6.5" width="12" height="3" fill="#fff" stroke={C} /><rect x="2" y="11" width="12" height="3" fill="#fff" stroke={C} /></>);
export const ColumnsIcon = svg(<><rect x="1.5" y="2" width="5.5" height="3" fill="#fff" stroke={C} /><rect x="9" y="2" width="5.5" height="3" fill="#fff" stroke={C} /><rect x="1.5" y="6.5" width="5.5" height="3" fill="#fff" stroke={C} /><rect x="9" y="6.5" width="5.5" height="3" fill="#fff" stroke={C} /><rect x="1.5" y="11" width="13" height="3" fill="#fff" stroke={C} /></>);
export const FieldListIcon = svg(<><rect x="2" y="1.5" width="12" height="13" fill="#fff" stroke={C} /><path d="M4 4.5h8M4 7.5h8M4 10.5h6" stroke={A} /></>);
export const PropertySheetIcon = svg(<><rect x="2" y="1.5" width="12" height="13" fill="#fff" stroke={C} /><path d="M2 5h12M7 5v9.5" stroke={C} /><path d="M3.5 7.5h2M3.5 10.5h2M8.5 7.5h4M8.5 10.5h3" stroke={A} /></>);
export const ThemeIcon = svg(<><circle cx="8" cy="8" r="6.5" fill="#fff" stroke={C} /><circle cx="5.5" cy="6" r="1.4" fill="#e11d48" /><circle cx="9" cy="4.8" r="1.4" fill="#4f46e5" /><circle cx="11.3" cy="8" r="1.4" fill="#16a34a" /><circle cx="6" cy="10" r="1.4" fill="#ea580c" /></>);

export const TabOrderIcon = svg(
  <>
    <rect x="1.5" y="2" width="9" height="3" rx="1" fill="#fff" stroke={C} />
    <rect x="1.5" y="6.5" width="9" height="3" rx="1" fill="#fff" stroke={C} />
    <rect x="1.5" y="11" width="9" height="3" rx="1" fill="#fff" stroke={C} />
    <path d="M13 3.5v9m-1.6-1.6L13 12.5l1.6-1.6" fill="none" stroke="#c42b1c" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </>,
);
