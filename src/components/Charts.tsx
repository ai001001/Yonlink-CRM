/**
 * 轻量图表（无第三方依赖）：横向条形图（HTML）、纵向柱状图（SVG）。每个条形带标题提示，整体带无障碍标签。
 * Lightweight charts (no third-party dependency): horizontal bars (HTML) and vertical columns (SVG); each bar
 * has a tooltip title and the chart has an accessible label.
 */
'use client';

import { Empty } from 'antd';
import { t } from '@/i18n';

const COLORS = { primary: '#1f5fbf', secondary: '#91b4e6', danger: '#e05b5b', grid: '#e8ecf2', text: '#5b6475' };

/** 横向条形数据 / Horizontal bar datum */
export interface HBar {
  key: string;
  label: string;
  value: number;
  /** 条形右侧显示的文字 / text shown after the bar */
  display: string;
}

/**
 * 横向条形图（如销售漏斗、线索来源）。用 HTML 布局，文字在窄列中仍保持正常字号。
 * Horizontal bar chart (e.g. the funnel, lead sources); HTML layout keeps text readable in narrow columns.
 */
export function HBarChart({ data, label, testId }: { data: HBar[]; label: string; testId?: string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  if (!data.length || max === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.empty')} data-testid={testId} />;
  return (
    <div role="list" aria-label={label} data-testid={testId} style={{ display: 'grid', gap: 8 }}>
      {data.map((d, i) => (
        <div key={d.key} role="listitem" data-key={d.key} title={`${d.label}${t('common.colon')}${d.display}`} style={{ display: 'grid', gridTemplateColumns: '88px 1fr', alignItems: 'center', gap: 8 }}>
          <span style={{ color: COLORS.text, fontSize: 13, textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.label}</span>
          <div>
            <div
              style={{
                width: `${Math.max(d.value > 0 ? 1 : 0, (d.value / max) * 100)}%`,
                height: 14,
                borderRadius: 3,
                background: COLORS.primary,
                opacity: 1 - i * (0.5 / Math.max(1, data.length)),
              }}
            />
            <span style={{ color: COLORS.text, fontSize: 12 }}>{d.display}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** 纵向柱状数据 / Column datum */
export interface Column {
  key: string;
  label: string;
  value: number;
  /** 次要值（例如输单数，用浅色小柱显示）/ secondary value drawn as a thin light column */
  secondary?: number;
  title: string;
}

/**
 * 纵向柱状图（如按月赢单金额）。
 * Vertical column chart (e.g. won amount per month).
 */
export function ColumnChart({ data, label, testId }: { data: Column[]; label: string; testId?: string }) {
  const max = Math.max(0, ...data.map((d) => d.value));
  const max2 = Math.max(0, ...data.map((d) => d.secondary ?? 0));
  if (!data.length || (max === 0 && max2 === 0)) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common.empty')} data-testid={testId} />;
  const h = 180;
  const col = 44;
  const top = 10;
  const width = data.length * col + 20;
  return (
    <svg role="img" aria-label={label} data-testid={testId} viewBox={`0 0 ${width} ${h + top + 34}`} style={{ width: '100%', height: 'auto', maxHeight: 280 }}>
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1={10} x2={width - 10} y1={top + h - g * h} y2={top + h - g * h} stroke={COLORS.grid} />
      ))}
      {data.map((d, i) => {
        const x = 10 + i * col;
        const bh = max > 0 ? (d.value / max) * h : 0;
        const sh = max2 > 0 && d.secondary ? (d.secondary / max2) * h * 0.4 : 0;
        return (
          <g key={d.key} data-key={d.key}>
            <title>{d.title}</title>
            <rect x={x + 8} y={top + h - bh} width={col - 22} height={bh} rx={2} fill={COLORS.primary} />
            {sh > 0 && <rect x={x + col - 13} y={top + h - sh} width={5} height={sh} rx={1} fill={COLORS.danger} opacity={0.7} />}
            <text x={x + col / 2} y={top + h + 18} textAnchor="middle" fontSize={11} fill={COLORS.text}>
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
