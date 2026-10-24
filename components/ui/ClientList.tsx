import React from 'react';

export interface ClientListItem {
  clientId: string;
  name: string;
  status: 'active' | 'revoked';
  totalEvents: number;
}

interface ClientListProps {
  clients: ClientListItem[];
  limit?: number;
}

export const ClientList: React.FC<ClientListProps> = ({ clients, limit = 4 }) => (
  <div className="divide-y divide-[var(--border)]">
    {clients.slice(0, limit).map((client) => (
      <div key={client.clientId} className="flex min-w-0 items-center justify-between gap-3 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={client.status === 'active' ? 'h-1.5 w-1.5 shrink-0 bg-[var(--accent)]' : 'h-1.5 w-1.5 shrink-0 bg-[var(--text-faint)]'} />
          <div className="min-w-0">
            <p className="truncate text-[12px] font-medium text-[var(--text)]">{client.name}</p>
            <p className="truncate font-mono text-[10px] text-[var(--text-faint)]">{client.clientId}</p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)]">
          {client.totalEvents.toLocaleString()}
        </span>
      </div>
    ))}
    {clients.length === 0 && (
      <p className="px-4 py-5 text-[12px] text-[var(--text-faint)]">No registered clients.</p>
    )}
  </div>
);

export default ClientList;
