/**
 * 显示格式化工具。
 * Display formatting helpers.
 */
import dayjs from 'dayjs';

/** 日期时间 / Date-time */
export const fmtDateTime = (v: string | null | undefined): string => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '');

/** 日期 / Date */
export const fmtDate = (v: string | null | undefined): string => (v ? dayjs(v).format('YYYY-MM-DD') : '');

/**
 * 金额（字符串十进制，避免浮点误差）。
 * Money (decimal string, avoiding float rounding).
 */
export function fmtMoney(v: string | number | null | undefined, currency = 'CNY'): string {
  if (v === null || v === undefined || v === '') return '';
  const [int = '0', frac = '00'] = String(v).split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = int.replace('-', '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const symbol = currency === 'CNY' ? '¥' : `${currency} `;
  return `${sign}${symbol}${digits}.${frac.padEnd(2, '0').slice(0, 2)}`;
}
