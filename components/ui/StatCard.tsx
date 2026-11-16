import React from 'react';
import { Card } from './Card';

interface StatCardProps {
  label: string;
  value: string | number;
  unit?: string;
}

export const StatCard: React.FC<StatCardProps> = ({ label, value, unit }) => (
  <Card compact className="bg-[var(--surface)]">
    <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--text-faint)]">{label}</div>
    <div className="font-mono text-[16px] font-medium leading-tight tabular-nums text-[var(--text)]">
      {value}
      {unit && <span className="ml-1 font-sans text-[10.5px] font-normal text-[var(--text-muted)]">{unit}</span>}
    </div>
  </Card>
);

export default StatCard;
