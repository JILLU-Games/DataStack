import React from 'react';
import { Card } from './Card';

interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
  meta: string;
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, unit, meta }) => (
  <Card compact className="bg-[var(--surface)]">
    <div className="mb-1.5 text-[10px] uppercase text-[var(--text-faint)]">{label}</div>
    <div className="text-[22px] font-medium leading-tight text-[var(--text)]">
      {value}
      {unit && <span className="ml-1 text-[11px] font-normal text-[var(--text-muted)]">{unit}</span>}
    </div>
    <div className="mt-2 text-[11px] text-[var(--text-muted)]">{meta}</div>
  </Card>
);

export default StatCard;
