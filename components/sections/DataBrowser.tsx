'use client';

import { PageShell } from '@/components/layout/PageShell';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { CodeBlock } from '@/components/ui/CodeBlock';
import { CopyButton } from '@/components/ui/CopyButton';
import { Input, Select } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Panel } from '@/components/ui/Panel';
import { Pill } from '@/components/ui/Pill';
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
import { formatEventTimeLabel } from '@/lib/vconUiHelpers';
import { useRouter } from 'next/navigation';
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

interface CorruptPartitionWarning {
  clientId: string;
  filename: string;
  code?: string;
  error: string;
}

const PAGE_SIZE = 12;

function formatEventPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function getPayloadBytes(raw: string): number {
  return new TextEncoder().encode(raw).length;
}

export function DataBrowser() {
  const router = useRouter();
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
  const [corruptPartitions, setCorruptPartitions] = useState<CorruptPartitionWarning[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<StreamEvent | null>(null);

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
      const response = await fetch(`/api/data?${params}`, { cache: 'no-store' });
      if (response.status === 401) {
        window.location.assign('/vcon/login');
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Unable to load events');
      }
      setEvents(data.events || []);
      setTotal(data.total || 0);
      setPageCount(data.pageCount || 1);
      setCorruptPartitions(
        Array.isArray(data.corruptPartitions) ? data.corruptPartitions : []
      );
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load events');
    }
  }, [appliedFilters, page]);

  useEffect(() => {
    fetch('/api/clients', { cache: 'no-store' })
      .then((response) => {
        if (response.status === 401) {
          window.location.assign('/vcon/login');
          return { clients: [] };
        }
        return response.ok ? response.json() : { clients: [] };
      })
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

  const invalidRange = Boolean(fromFilter && toFilter && fromFilter > toFilter);

  const firstVisible = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastVisible = Math.min(page * PAGE_SIZE, total);
  const firstPage = Math.max(1, Math.min(page - 1, pageCount - 2));
  const visiblePages = Array.from(
    { length: Math.min(3, pageCount) },
    (_, index) => firstPage + index
  );

  const applyFilters = () => {
    if (invalidRange) {
      setErrorMessage('Start date ("From") must be on or before end date ("To").');
      return;
    }
    setErrorMessage('');
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
    setErrorMessage('');
    setAppliedFilters({ clientId: 'all', from: '', to: '', search: '' });
    setPage(1);
  };

  const refresh = async () => {
    setRefreshing(true);
    await fetchEvents();
    setRefreshing(false);
  };

  const formattedSelectedPayload = selectedEvent
    ? formatEventPayload(selectedEvent.payload)
    : '';

  return (
    <PageShell
      title="Events"
      actions={
        <>
          <Button
            type="button"
            variant="secondary"
            size="icon"
            icon="RefreshCw"
            title="Refresh events"
            aria-label="Refresh events"
            loading={refreshing}
            onClick={refresh}
          />
          <Button
            type="button"
            variant="primary"
            size="xs"
            icon="Download"
            onClick={() => router.push('/vcon/export')}
          >
            Export CSV
          </Button>
        </>
      }
    >
      <Card compact className="p-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            applyFilters();
          }}
          className="grid grid-cols-1 gap-px bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-5"
        >
          <div className="bg-[var(--surface)] p-2.5">
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
          <div className="bg-[var(--surface)] p-2.5">
            <Input
              label="From"
              compact
              type="date"
              value={fromFilter}
              onChange={(event) => setFromFilter(event.target.value)}
            />
          </div>
          <div className="bg-[var(--surface)] p-2.5">
            <Input
              label="To"
              compact
              type="date"
              value={toFilter}
              onChange={(event) => setToFilter(event.target.value)}
            />
          </div>
          <div className="bg-[var(--surface)] p-2.5">
            <Input
              label="Search"
              compact
              placeholder="Keyword..."
              icon="Search"
              value={searchFilter}
              onChange={(event) => setSearchFilter(event.target.value)}
            />
          </div>
          <div className="flex items-end justify-end gap-1.5 bg-[var(--surface)] p-2.5">
            <Button type="button" size="xs" icon="X" onClick={resetFilters}>
              Reset
            </Button>
            <Button
              type="submit"
              size="xs"
              variant="primary"
              disabled={invalidRange}
            >
              Apply
            </Button>
          </div>
        </form>
        {invalidRange && (
          <p role="alert" className="border-t border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] text-[var(--danger)]">
            Start date must be on or before end date.
          </p>
        )}
      </Card>

      {corruptPartitions.length > 0 && (
        <div
          role="status"
          data-testid="data-corrupt-partitions-warning"
          className="border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-[11.5px] text-[var(--text)]"
        >
          <div className="font-medium">
            {corruptPartitions.length} corrupt .csv.gz partition
            {corruptPartitions.length === 1 ? '' : 's'} skipped while loading healthy events.
          </div>
          <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[10.5px] text-[var(--text-muted)]">
            {corruptPartitions.slice(0, 5).map((item) => (
              <li key={`${item.clientId}:${item.filename}`}>
                {item.clientId}/{item.filename} — {item.error}
              </li>
            ))}
            {corruptPartitions.length > 5 && (
              <li>+{corruptPartitions.length - 5} more unreadable archive(s)</li>
            )}
          </ul>
        </div>
      )}

      <Panel
        title="Events"
        meta={`${total.toLocaleString()} · ${page}/${pageCount}`}
        bodyClassName="overflow-hidden"
      >
        <TableWrap className="border-0 bg-transparent">
          <Table>
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
                <TableEmpty colSpan={6} message="No matching events" />
              ) : (
                events.map((event) => (
                  <TableRow
                    key={`${event.clientId}:${event.eventId}`}
                    className="cursor-pointer"
                    onClick={() => setSelectedEvent(event)}
                  >
                    <TableCell className="font-mono tabular-nums text-[var(--text)]">
                      {formatEventTimeLabel(event.timestamp)}
                    </TableCell>
                    <TableCell className="font-mono text-[var(--accent)]">
                      {event.clientId}
                    </TableCell>
                    <TableCell className="hidden font-mono text-[var(--text-faint)] sm:table-cell">
                      {event.eventId}
                    </TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-[var(--text)]">
                      {event.payload}
                    </TableCell>
                    <TableCell className="hidden font-mono tabular-nums md:table-cell">
                      {getPayloadBytes(event.payload)} B
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                          <span
                            className={`h-1.5 w-1.5 ${
                              event.status === 'buffered'
                                ? 'bg-[var(--warning)]'
                                : 'bg-[var(--accent)]'
                            }`}
                          />
                          {event.status}
                        </span>
                        <Button
                          type="button"
                          variant="icon"
                          size="icon"
                          icon="Eye"
                          className="h-5 w-5 border border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]"
                          title={`Inspect event ${event.eventId}`}
                          aria-label={`Inspect event ${event.eventId}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedEvent(event);
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableWrap>
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
          <p className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
            {firstVisible}–{lastVisible} of {total.toLocaleString()}
          </p>
          <nav className="flex items-center gap-1" aria-label="Event pages">
            <Button
              type="button"
              variant="icon"
              size="icon"
              icon="ChevronLeft"
              className="h-6 w-6 border border-[var(--border)]"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            />
            {firstPage > 1 && (
              <>
                <Pill
                  active={page === 1}
                  aria-current={page === 1 ? 'page' : undefined}
                  className="min-w-6 justify-center px-1.5 font-mono tabular-nums"
                  onClick={() => setPage(1)}
                >
                  1
                </Pill>
                {firstPage > 2 && <span className="px-1 text-[11px] text-[var(--text-faint)]">…</span>}
              </>
            )}
            {visiblePages.map((pageNumber) => (
              <Pill
                key={pageNumber}
                active={page === pageNumber}
                aria-current={page === pageNumber ? 'page' : undefined}
                className="min-w-6 justify-center px-1.5 font-mono tabular-nums"
                onClick={() => setPage(pageNumber)}
              >
                {pageNumber}
              </Pill>
            ))}
            {firstPage + visiblePages.length - 1 < pageCount && (
              <>
                {firstPage + visiblePages.length < pageCount && (
                  <span className="px-1 text-[11px] text-[var(--text-faint)]">…</span>
                )}
                <Pill
                  active={page === pageCount}
                  aria-current={page === pageCount ? 'page' : undefined}
                  className="min-w-6 justify-center px-1.5 font-mono tabular-nums"
                  onClick={() => setPage(pageCount)}
                >
                  {pageCount}
                </Pill>
              </>
            )}
            <Button
              type="button"
              variant="icon"
              size="icon"
              icon="ChevronRight"
              className="h-6 w-6 border border-[var(--border)]"
              aria-label="Next page"
              disabled={page >= pageCount}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            />
          </nav>
        </footer>
      </Panel>

      <Modal
        isOpen={Boolean(selectedEvent)}
        onClose={() => setSelectedEvent(null)}
        title={`Event payload: ${selectedEvent?.eventId || ''}`}
        maxWidth="lg"
        footer={
          <Button type="button" size="xs" onClick={() => setSelectedEvent(null)}>
            Close
          </Button>
        }
      >
        {selectedEvent && (
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-px border border-[var(--border)] bg-[var(--border)] sm:grid-cols-4">
              <div className="bg-[var(--surface)] p-2">
                <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
                  Client
                </div>
                <div className="truncate font-mono text-[11.5px] text-[var(--accent)]">
                  {selectedEvent.clientId}
                </div>
              </div>
              <div className="bg-[var(--surface)] p-2">
                <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
                  Status
                </div>
                <div className="font-mono text-[11.5px] text-[var(--text)]">
                  {selectedEvent.status}
                </div>
              </div>
              <div className="bg-[var(--surface)] p-2">
                <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
                  Size
                </div>
                <div className="font-mono text-[11.5px] tabular-nums text-[var(--text)]">
                  {getPayloadBytes(selectedEvent.payload)} B
                </div>
              </div>
              <div className="bg-[var(--surface)] p-2">
                <div className="text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
                  Timestamp
                </div>
                <div className="truncate font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
                  {selectedEvent.timestamp}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
                  JSON / Raw Payload
                </span>
                <CopyButton value={formattedSelectedPayload} />
              </div>
              <CodeBlock className="max-h-[340px] border border-[var(--border)] text-[11px]">
                {formattedSelectedPayload}
              </CodeBlock>
            </div>
          </div>
        )}
      </Modal>
    </PageShell>
  );
}
