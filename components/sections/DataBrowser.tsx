'use client';

import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Input';
import { Panel } from '@/components/ui/Panel';
import {
    Table,
    TableBody,
    TableCell,
    TableEmpty,
    TableHead,
    TableHeader,
    TableRow,
    TableWrap,
} from '@/components/ui/Table';
import { useCallback, useEffect, useState } from 'react';

interface StreamEvent {
  clientId: string;
  eventId: string;
  timestamp: string;
  payload: string;
  status: 'stored' | 'buffered';
}

interface Client {
  clientId: string;
  name: string;
}

const PAGE_SIZE = 12;

export function DataBrowser() {
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [total, setTotal] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [clientFilter, setClientFilter] = useState('all');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({
    clientId: 'all',
    from: '',
    to: '',
    search: '',
  });
  const [page, setPage] = useState(1);
  const [filtersReady, setFiltersReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const fetchEvents = useCallback(async () => {
    try {
      const params = new URLSearchParams({
        clientId: appliedFilters.clientId,
        from: appliedFilters.from,
        to: appliedFilters.to,
        search: appliedFilters.search,
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      const response = await fetch(`/api/data?${params}`);
      if (!response.ok) throw new Error('Unable to load events');
      const data = await response.json();
      setEvents(data.events || []);
      setTotal(data.total || 0);
      setPageCount(data.pageCount || 1);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load events');
    }
  }, [appliedFilters, page]);

  useEffect(() => {
    fetch('/api/clients')
      .then((response) => (response.ok ? response.json() : { clients: [] }))
      .then((data) => setClients(data.clients || []))
      .catch(() => setClients([]));
  }, []);

  useEffect(() => {
    const clientId = new URLSearchParams(window.location.search).get('clientId');
    if (clientId) {
      setClientFilter(clientId);
      setAppliedFilters((current) => ({ ...current, clientId }));
    }
    setFiltersReady(true);
  }, []);

  useEffect(() => {
    if (!filtersReady) return;
    fetchEvents();
  }, [fetchEvents, filtersReady]);

  const firstVisible = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastVisible = Math.min(page * PAGE_SIZE, total);
  const firstPage = Math.max(1, Math.min(page - 1, pageCount - 2));
  const visiblePages = Array.from(
    { length: Math.min(3, pageCount) },
    (_, index) => firstPage + index
  );

  const applyFilters = () => {
    setAppliedFilters({
      clientId: clientFilter,
      from: fromFilter,
      to: toFilter,
      search: searchFilter,
    });
    setPage(1);
  };

  const resetFilters = () => {
    setClientFilter('all');
    setFromFilter('');
    setToFilter('');
    setSearchFilter('');
    setAppliedFilters({ clientId: 'all', from: '', to: '', search: '' });
    setPage(1);
  };

  const refresh = async () => {
    setRefreshing(true);
    await fetchEvents();
    setRefreshing(false);
  };

  return (
    <section className="mx-auto flex w-full max-w-[var(--console-width)] flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-medium tracking-[-0.3px] text-[var(--text)]">Data</h1>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">Collected events across all clients</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="icon"
            size="icon"
            icon="RefreshCw"
            className="h-8 w-8 border border-[var(--border)]"
            title="Refresh events"
            aria-label="Refresh events"
            loading={refreshing}
            onClick={refresh}
          />
          <Button
            type="button"
            variant="primary"
            size="sm"
            icon="Download"
            onClick={() => window.location.assign('/vcon/export')}
          >
            Export CSV
          </Button>
        </div>
      </header>

      <Card compact className="!p-0">
        <div className="grid grid-cols-1 gap-px bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-5">
          <div className="bg-[var(--surface)] p-3">
            <Select
              label="Client"
              compact
              value={clientFilter}
              onChange={(event) => setClientFilter(event.target.value)}
            >
              <option value="all">All clients</option>
              {clients.map((client) => (
                <option key={client.clientId} value={client.clientId}>
                  {client.name || client.clientId}
                </option>
              ))}
            </Select>
          </div>
          <div className="bg-[var(--surface)] p-3">
            <Input
              label="From"
              compact
              type="date"
              value={fromFilter}
              onChange={(event) => setFromFilter(event.target.value)}
            />
          </div>
          <div className="bg-[var(--surface)] p-3">
            <Input
              label="To"
              compact
              type="date"
              value={toFilter}
              onChange={(event) => setToFilter(event.target.value)}
            />
          </div>
          <div className="bg-[var(--surface)] p-3">
            <Input
              label="Search payload"
              compact
              placeholder="e.g. sensor, user_id"
              icon="Search"
              value={searchFilter}
              onChange={(event) => setSearchFilter(event.target.value)}
            />
          </div>
          <div className="flex items-end justify-end gap-2 bg-[var(--surface)] p-3">
            <Button type="button" size="xs" icon="X" onClick={resetFilters}>
              Reset
            </Button>
            <Button type="button" size="xs" variant="primary" onClick={applyFilters}>
              Apply
            </Button>
          </div>
        </div>
      </Card>

      <Panel
        title="Events"
        meta={`${total.toLocaleString()} results · page ${page} of ${pageCount}`}
        bodyClassName="overflow-hidden"
      >
        <TableWrap className="border-0">
          <Table className="min-w-[760px] text-xs">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Client</TableHead>
                <TableHead className="hidden sm:table-cell">Event ID</TableHead>
                <TableHead>Payload</TableHead>
                <TableHead className="hidden md:table-cell">Size</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {errorMessage ? (
                <TableEmpty colSpan={6} message={errorMessage} />
              ) : events.length === 0 ? (
                <TableEmpty colSpan={6} message="No events match these filters." />
              ) : (
                events.map((event) => (
                  <TableRow key={event.eventId}>
                    <TableCell className="font-mono text-[var(--text)]">
                      {new Date(event.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                      })}
                    </TableCell>
                    <TableCell className="font-mono text-[var(--accent)]">{event.clientId}</TableCell>
                    <TableCell className="hidden font-mono text-[var(--text-faint)] sm:table-cell">
                      {event.eventId}
                    </TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-[var(--text)]">
                      {event.payload}
                    </TableCell>
                    <TableCell className="hidden font-mono md:table-cell">
                      {new TextEncoder().encode(event.payload).length} B
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                        <span className="h-1.5 w-1.5 bg-[var(--accent)]" />{event.status}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableWrap>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-2.5">
          <p className="text-xs text-[var(--text-muted)]">
            Showing <strong className="font-medium text-[var(--text)]">{firstVisible}–{lastVisible}</strong> of{' '}
            <strong className="font-medium text-[var(--text)]">{total.toLocaleString()}</strong> events
          </p>
          <nav className="flex items-center gap-1" aria-label="Event pages">
            <Button
              type="button"
              variant="icon"
              size="icon"
              icon="ChevronLeft"
              className="h-7 w-7 border border-[var(--border)]"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            />
            {firstPage > 1 && (
              <>
                <PageButton pageNumber={1} active={page === 1} onSelect={setPage} />
                {firstPage > 2 && <span className="px-1 text-xs text-[var(--text-faint)]">…</span>}
              </>
            )}
            {visiblePages.map((pageNumber) => (
              <PageButton
                key={pageNumber}
                pageNumber={pageNumber}
                active={page === pageNumber}
                onSelect={setPage}
              />
            ))}
            {firstPage + visiblePages.length - 1 < pageCount && (
              <>
                {firstPage + visiblePages.length < pageCount && (
                  <span className="px-1 text-xs text-[var(--text-faint)]">…</span>
                )}
                <PageButton
                  pageNumber={pageCount}
                  active={page === pageCount}
                  onSelect={setPage}
                />
              </>
            )}
            <Button
              type="button"
              variant="icon"
              size="icon"
              icon="ChevronRight"
              className="h-7 w-7 border border-[var(--border)]"
              aria-label="Next page"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            />
          </nav>
        </footer>
      </Panel>
    </section>
  );
}

function PageButton({
  pageNumber,
  active,
  onSelect,
}: {
  pageNumber: number;
  active: boolean;
  onSelect: (page: number) => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? 'page' : undefined}
      className={`grid h-7 min-w-7 place-items-center border px-2 text-xs transition-colors ${
        active
          ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)]'
          : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
      }`}
      onClick={() => onSelect(pageNumber)}
    >
      {pageNumber}
    </button>
  );
}
