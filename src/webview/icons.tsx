import React from 'react';

type P = { size?: number; className?: string; title?: string };

const svg = (path: React.ReactNode, { size = 13, className, title }: P, viewBox = '0 0 16 16') => (
  <svg width={size} height={size} viewBox={viewBox} className={className} aria-hidden={!title} role={title ? 'img' : undefined}>
    {title ? <title>{title}</title> : null}
    {path}
  </svg>
);

export const KeyIcon = (p: P) =>
  svg(
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="5" cy="11" r="3" />
      <path d="M7.2 8.8 13.5 2.5M11 5l2 2M12.6 3.4l1.6 1.6" />
    </g>,
    p,
  );

export const LinkIcon = (p: P) =>
  svg(
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6.5 9.5l3-3" />
      <path d="M7.5 4.5 9 3a2.8 2.8 0 0 1 4 4l-1.5 1.5" />
      <path d="M8.5 11.5 7 13a2.8 2.8 0 0 1-4-4l1.5-1.5" />
    </g>,
    p,
  );

export const DiamondIcon = ({ filled, ...p }: P & { filled?: boolean }) =>
  svg(
    <path
      d="M8 2.5 13.5 8 8 13.5 2.5 8Z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
    />,
    p,
  );

export const HashIcon = (p: P) =>
  svg(
    <path d="M6 2.5 4.8 13.5M11.2 2.5 10 13.5M2.8 6h11M2.2 10.5h11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
    p,
  );

export const UniqueIcon = (p: P) =>
  svg(
    <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6 5.5v3.2a2 2 0 0 0 4 0V5.5" />
    </g>,
    p,
  );

export const EditIcon = (p: P) =>
  svg(
    <path d="M10.8 2.7a1.6 1.6 0 0 1 2.3 2.3L5.5 12.6l-3 .7.7-3Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />,
    p,
  );

export const PlusIcon = (p: P) =>
  svg(<path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />, p);

export const CloseIcon = (p: P) =>
  svg(<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />, p);

export const TrashIcon = (p: P) =>
  svg(
    <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5M4 4.5l.7 9h6.6l.7-9" />
    </g>,
    p,
  );

export const TableIcon = (p: P) =>
  svg(
    <g fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6.5h12M6.5 6.5V13" />
    </g>,
    p,
  );

export const ChevronIcon = ({ open, ...p }: P & { open?: boolean }) =>
  svg(
    <path
      d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />,
    p,
  );

export const UpIcon = (p: P) =>
  svg(<path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />, p);
export const DownIcon = (p: P) =>
  svg(<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />, p);
