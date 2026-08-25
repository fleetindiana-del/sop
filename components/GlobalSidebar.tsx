'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import {
  BadgeCheck,
  BookOpenCheck,
  Boxes,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Cloud,
  FileQuestion,
  Files,
  GraduationCap,
  LayoutDashboard,
  LibraryBig,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  UserCog,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { canAccessPath, isLearnerOnly } from '@/lib/page-access';

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

type NavGroup = {
  label: string;
  icon: LucideIcon;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'SOP Management',
    icon: Files,
    items: [
      { label: 'SOP Registry', href: '/dashboard', icon: LayoutDashboard },
      { label: 'MCQ Bank', href: '/mcq-bank', icon: FileQuestion },
    ],
  },
  {
    label: 'Masters',
    icon: Boxes,
    items: [
      { label: 'Employee Master', href: '/employees', icon: Users },
      { label: 'Designation Master', href: '/admin/designations', icon: BadgeCheck },
      { label: 'Login & Passwords', href: '/admin/users', icon: UserCog },
      { label: 'Access Management', href: '/admin/access', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'LMS & Training',
    icon: GraduationCap,
    items: [
      { label: 'LMS Home', href: '/lms', icon: GraduationCap },
      { label: 'My Training Record', href: '/lms/my-record', icon: BookOpenCheck },
      { label: 'Certificates', href: '/lms/certificate', icon: Sparkles },
      { label: 'Assessments', href: '/test', icon: ClipboardCheck },
      { label: 'Training Matrix', href: '/training-matrix', icon: LibraryBig },
      { label: 'Induction Matrix', href: '/induction-training-matrix', icon: Users },
      { label: 'LMS Administration', href: '/lms/admin', icon: SlidersHorizontal },
    ],
  },
  {
    label: 'Compliance',
    icon: ShieldCheck,
    items: [
      { label: 'Compliance Engine', href: '/compliance', icon: ShieldCheck },
      { label: 'Request a Review', href: '/compliance/request', icon: ClipboardCheck },
    ],
  },
  {
    label: 'Storage',
    icon: Cloud,
    items: [{ label: 'Bunny Files', href: '/bunny-files', icon: Cloud }],
  },
];

function pathIsActive(pathname: string, href: string) {
  if (href === '/lms' || href === '/test' || href === '/compliance') {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function GlobalSidebar() {
  const pathname = usePathname() || '';
  const { data: session, status } = useSession();
  const role = session?.user?.role;
  const pageAccess = session?.user?.pageAccess;
  const learner = isLearnerOnly(role);

  const [open, setOpen] = React.useState(false);
  const [expandedGroups, setExpandedGroups] = React.useState<Set<string>>(() => {
    const active = NAV_GROUPS.find((group) =>
      group.items.some((item) => pathIsActive(pathname, item.href)),
    );
    return new Set(active ? [active.label] : []);
  });

  if (status !== 'authenticated' || pathname === '/login') return null;

  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (learner) return item.href.startsWith('/lms') || item.href === '/test';
      return canAccessPath(role, pageAccess, item.href);
    }),
  })).filter((group) => group.items.length > 0);

  const toggleGroup = (label: string) => {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  return (
    <>
      {open && (
        <button
          aria-label="Close navigation"
          className="fixed inset-0 z-[70] bg-slate-950/35 backdrop-blur-[1px] lg:hidden print:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <aside
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-[80] flex w-[290px] flex-col border-r border-slate-200 bg-white shadow-2xl transition-transform duration-300 print:hidden ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-100 px-5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-violet-600 text-white shadow-sm shadow-violet-200">
            <Files className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold tracking-tight text-slate-900">SOP Control</p>
            <p className="text-[11px] font-medium text-slate-500">Management workspace</p>
          </div>
          <button
            type="button"
            aria-label="Close sidebar"
            onClick={() => setOpen(false)}
            className="ml-auto rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4 lg:hidden" />
            <ChevronLeft className="hidden h-4 w-4 lg:block" />
          </button>
        </div>

        <nav className="custom-scrollbar flex-1 space-y-2 overflow-y-auto px-3 py-4">
          {groups.map((group) => {
            const groupActive = group.items.some((item) => pathIsActive(pathname, item.href));
            const expanded = expandedGroups.has(group.label);
            const GroupIcon = group.icon;
            return (
              <div key={group.label}>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.label)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-semibold transition ${
                    groupActive
                      ? 'bg-violet-50 text-violet-800'
                      : 'text-slate-700 hover:bg-slate-50 hover:text-slate-950'
                  }`}
                >
                  <GroupIcon className={`h-4 w-4 ${groupActive ? 'text-violet-600' : 'text-slate-400'}`} />
                  <span className="flex-1">{group.label}</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>

                {expanded && (
                  <div className="ml-5 mt-1 space-y-0.5 border-l border-slate-200 pl-3">
                    {group.items.map((item) => {
                      const active = pathIsActive(pathname, item.href);
                      const ItemIcon = item.icon;
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => {
                            if (window.innerWidth < 1024) setOpen(false);
                          }}
                          className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition ${
                            active
                              ? 'bg-violet-600 text-white shadow-sm'
                              : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                          }`}
                        >
                          <ItemIcon className="h-3.5 w-3.5 shrink-0" />
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="border-t border-slate-100 p-3">
          <div className="mb-2 px-3 py-2">
            <p className="truncate text-xs font-semibold text-slate-800">{session.user.name}</p>
            <p className="truncate text-[10px] uppercase tracking-wide text-slate-400">
              {String(role || 'user').replace('_', ' ')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex w-full items-center justify-between rounded-xl bg-slate-900 px-3 py-2.5 text-xs font-semibold text-white transition hover:bg-violet-700"
          >
            Collapse sidebar
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>
      </aside>

      {!open && (
        <button
          type="button"
          aria-label="Open sidebar"
          title="Open navigation"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 left-0 z-[80] flex h-11 w-9 items-center justify-center rounded-r-xl border border-l-0 border-violet-300 bg-violet-600 text-white shadow-lg shadow-violet-300/40 transition hover:w-11 hover:bg-violet-700 print:hidden"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </>
  );
}
