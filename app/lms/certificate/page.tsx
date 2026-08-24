'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Award,
  Download,
  Eye,
  Filter,
  Loader2,
  RefreshCw,
  Search,
} from 'lucide-react';

interface CertificateRecord {
  _id: string;
  certificateNumber: string;
  sopCode: string;
  sopName: string;
  sopVersion?: string;
  completedAt: string;
  quizScore: number;
  hasPractical: boolean;
  practicalScore?: number;
  issuedAt: string;
}

type CertificateFilter = 'all' | 'quiz' | 'practical' | 'without-practical';
type SortKey = 'sopCode' | 'sopName' | 'sopVersion' | 'completedAt' | 'issuedAt' | 'certificateNumber';
type SortDirection = 'asc' | 'desc';

export default function CertificatesPage() {
  const router = useRouter();
  const [certificates, setCertificates] = useState<CertificateRecord[]>([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CertificateFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('completedAt');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadCertificates = useCallback(async (refresh = false) => {
    if (refresh) {
      setRefreshing(true);
      setError('');
    }

    try {
      const response = await fetch('/api/lms/certificates', {
        cache: 'no-store',
      });

      if (response.status === 401) {
        router.replace('/lms');
        return;
      }

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load certificates.');
      setCertificates(data.certificates || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load certificates.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [router]);

  useEffect(() => {
    let active = true;

    fetch('/api/lms/certificates', { cache: 'no-store' })
      .then(async (response) => {
        if (response.status === 401) {
          router.replace('/lms');
          return null;
        }

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to load certificates.');
        return data as { certificates?: CertificateRecord[] };
      })
      .then((data) => {
        if (active && data) setCertificates(data.certificates || []);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Failed to load certificates.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [router]);

  const filteredCertificates = useMemo(() => {
    const term = search.trim().toLowerCase();
    return certificates
      .filter((certificate) => {
        const matchesSearch = !term ||
          [certificate.sopCode, certificate.sopName, certificate.certificateNumber]
            .some((value) => value.toLowerCase().includes(term));
        const matchesFilter = filter === 'all' ||
          (filter === 'quiz' && certificate.quizScore > 0) ||
          (filter === 'practical' && certificate.hasPractical) ||
          (filter === 'without-practical' && !certificate.hasPractical);
        return matchesSearch && matchesFilter;
      })
      .sort((left, right) => {
        let comparison: number;
        if (sortKey === 'completedAt' || sortKey === 'issuedAt') {
          comparison = new Date(left[sortKey]).getTime() - new Date(right[sortKey]).getTime();
        } else {
          comparison = (left[sortKey] || '').localeCompare(right[sortKey] || '', undefined, {
            numeric: true,
            sensitivity: 'base',
          });
        }
        return sortDirection === 'asc' ? comparison : -comparison;
      });
  }, [certificates, filter, search, sortDirection, sortKey]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc');
      return;
    }
    setSortKey(key);
    setSortDirection(key === 'completedAt' || key === 'issuedAt' ? 'desc' : 'asc');
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return <ArrowUpDown className="h-3.5 w-3.5 text-slate-300" />;
    return sortDirection === 'asc'
      ? <ArrowUp className="h-3.5 w-3.5 text-purple-600" />
      : <ArrowDown className="h-3.5 w-3.5 text-purple-600" />;
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => router.push('/lms')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-800"
              aria-label="Back to My Training"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold text-slate-900 sm:text-lg">My Certificates</h1>
              <p className="text-xs text-slate-500">Your completed training certificates</p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => void loadCertificates(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6">
        {loading ? (
          <div className="flex min-h-[55vh] items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-purple-500" />
          </div>
        ) : error ? (
          <div className="flex min-h-[55vh] flex-col items-center justify-center rounded-2xl border border-red-100 bg-white p-8 text-center">
            <AlertCircle className="mb-3 h-10 w-10 text-red-400" />
            <h2 className="font-semibold text-slate-800">Could not load certificates</h2>
            <p className="mt-1 max-w-sm text-sm text-slate-500">{error}</p>
            <button
              type="button"
              onClick={() => void loadCertificates(true)}
              className="mt-5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-700"
            >
              Try again
            </button>
          </div>
        ) : certificates.length === 0 ? (
          <div className="flex min-h-[55vh] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
            <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-amber-50">
              <Award className="h-8 w-8 text-amber-500" />
            </div>
            <h2 className="text-lg font-bold text-slate-800">No certificates yet</h2>
            <p className="mt-1 max-w-md text-sm leading-6 text-slate-500">
              Your certificates will appear here after you successfully complete an assigned training.
            </p>
            <button
              type="button"
              onClick={() => router.push('/lms')}
              className="mt-5 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-purple-700"
            >
              Go to My Training
            </button>
          </div>
        ) : (
          <>
            <section className="mb-6 overflow-hidden rounded-2xl bg-gradient-to-br from-purple-700 via-purple-600 to-indigo-700 p-5 text-white shadow-sm sm:p-7">
              <div className="flex items-center justify-between gap-5">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-200">Achievements</p>
                  <p className="mt-2 text-3xl font-bold">{certificates.length}</p>
                  <p className="mt-1 text-sm text-purple-100">
                    Certificate{certificates.length === 1 ? '' : 's'} earned
                  </p>
                </div>
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-white/10 ring-1 ring-white/20">
                  <Award className="h-10 w-10 text-amber-300" />
                </div>
              </div>
            </section>

            <div className="mb-5 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
              <div>
                <h2 className="text-sm font-bold text-slate-800">SOP-wise certificates</h2>
                <p className="mt-0.5 text-xs text-slate-500">Click a column heading to sort the table.</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <label className="relative block w-full sm:w-72">
                  <span className="sr-only">Search certificates</span>
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search SOP or certificate"
                    className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm text-slate-700 outline-none transition placeholder:text-slate-400 focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
                  />
                </label>
                <label className="relative block sm:w-52">
                  <span className="sr-only">Filter certificates</span>
                  <Filter className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <select
                    value={filter}
                    onChange={(event) => setFilter(event.target.value as CertificateFilter)}
                    className="w-full appearance-none rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-8 text-sm text-slate-700 outline-none transition focus:border-purple-400 focus:ring-2 focus:ring-purple-100"
                  >
                    <option value="all">All certificates</option>
                    <option value="quiz">With quiz score</option>
                    <option value="practical">Practical approved</option>
                    <option value="without-practical">Without practical</option>
                  </select>
                </label>
              </div>
            </div>

            {filteredCertificates.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white px-6 py-14 text-center">
                <Search className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                <p className="font-semibold text-slate-700">No matching certificates</p>
                <p className="mt-1 text-sm text-slate-500">Try changing your search or filter.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[1100px] border-collapse text-left">
                    <thead className="border-b border-slate-200 bg-slate-50">
                      <tr>
                        {([
                          ['sopCode', 'SOP Code'],
                          ['sopName', 'SOP Name'],
                          ['sopVersion', 'Revision / Version'],
                          ['certificateNumber', 'Certificate No.'],
                          ['completedAt', 'Completed On'],
                          ['issuedAt', 'Issued On'],
                        ] as Array<[SortKey, string]>).map(([key, label]) => (
                          <th key={key} className="px-4 py-3 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                            <button
                              type="button"
                              onClick={() => handleSort(key)}
                              className="inline-flex items-center gap-1.5 transition hover:text-purple-700"
                            >
                              {label}
                              {sortIcon(key)}
                            </button>
                          </th>
                        ))}
                        <th className="px-4 py-3 text-right text-[11px] font-bold uppercase tracking-wide text-slate-500">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {filteredCertificates.map((certificate) => (
                        <tr key={certificate._id} className="transition hover:bg-purple-50/40">
                          <td className="whitespace-nowrap px-4 py-4 font-mono text-xs font-bold text-purple-700">
                            {certificate.sopCode}
                          </td>
                          <td className="max-w-xs px-4 py-4 text-sm font-semibold text-slate-800">
                            <span className="line-clamp-2">{certificate.sopName}</span>
                          </td>
                          <td className="whitespace-nowrap px-4 py-4 text-xs font-semibold text-slate-600">
                            {certificate.sopVersion || '—'}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4 font-mono text-xs text-slate-500">
                            {certificate.certificateNumber}
                          </td>
                          <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-600">
                            {new Date(certificate.completedAt).toLocaleDateString('en-IN', {
                              day: 'numeric', month: 'short', year: 'numeric',
                            })}
                          </td>
                          <td className="px-4 py-4">
                            <span className="whitespace-nowrap text-xs text-slate-600">
                              {new Date(certificate.issuedAt).toLocaleDateString('en-IN', {
                                day: 'numeric', month: 'short', year: 'numeric',
                              })}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={() => router.push(`/lms/certificate/${encodeURIComponent(certificate.sopCode)}`)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-purple-200 bg-white px-3 py-2 text-xs font-semibold text-purple-700 transition hover:bg-purple-50"
                              >
                                <Eye className="h-3.5 w-3.5" /> View
                              </button>
                              <button
                                type="button"
                                onClick={() => window.open(`/lms/certificate/${encodeURIComponent(certificate.sopCode)}?print=1`, '_blank', 'noopener,noreferrer')}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-purple-600 px-3 py-2 text-xs font-semibold text-white transition hover:bg-purple-700"
                              >
                                <Download className="h-3.5 w-3.5" /> Download
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-xs text-slate-500">
                  Showing {filteredCertificates.length} of {certificates.length} SOP certificate{certificates.length === 1 ? '' : 's'}
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
