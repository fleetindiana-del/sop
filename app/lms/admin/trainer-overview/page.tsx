'use client';

import { TrainerOverviewDashboard } from '@/components/lms/TrainerOverviewDashboard';
import { useAuthGuard } from '@/hooks/useAuthGuard';

export default function TrainerOverviewPage() {
  useAuthGuard({ allowedRoles: ['admin', 'sop_admin'] });
  return <TrainerOverviewDashboard />;
}
