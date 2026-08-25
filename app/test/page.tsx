'use client';

import { useRouter } from 'next/navigation';
import { useAuthGuard } from '@/hooks/useAuthGuard';
import {
  UserSquare2,
  GraduationCap,
  RefreshCw,
  Settings2,
  AlertTriangle,
  Zap,
  ChevronRight,
  ArrowLeft,
  FlaskConical,
} from 'lucide-react';

const testTypes = [
  {
    id: 'interview',
    title: 'Interview Test',
    description: 'Prepare for SOP-based interviews with comprehensive question banks across all departments.',
    icon: UserSquare2,
    gradient: 'from-blue-500 to-cyan-500',
    lightColor: 'text-blue-300',
    hoverBorder: 'hover:border-blue-400/50',
    hoverShadow: 'hover:shadow-blue-500/20',
    path: '/test/interview',
  },
  {
    id: 'induction',
    title: 'Induction Training Test',
    description: 'Department-specific induction assessments for new employees joining the organization.',
    icon: GraduationCap,
    gradient: 'from-purple-500 to-pink-500',
    lightColor: 'text-purple-300',
    hoverBorder: 'hover:border-purple-400/50',
    hoverShadow: 'hover:shadow-purple-500/20',
    path: '/test/induction',
  },
  {
    id: 'regular',
    title: 'Regular Training Test',
    description: 'Periodic assessments to reinforce SOP knowledge and maintain compliance awareness.',
    icon: RefreshCw,
    gradient: 'from-emerald-500 to-teal-500',
    lightColor: 'text-emerald-300',
    hoverBorder: 'hover:border-emerald-400/50',
    hoverShadow: 'hover:shadow-emerald-500/20',
    path: '/test/regular',
  },
  {
    id: 'change-control',
    title: 'Change Control Training Test',
    description: 'Specialized tests covering change control procedures and documentation requirements.',
    icon: Settings2,
    gradient: 'from-orange-500 to-amber-500',
    lightColor: 'text-orange-300',
    hoverBorder: 'hover:border-orange-400/50',
    hoverShadow: 'hover:shadow-orange-500/20',
    path: '/test/change-control',
  },
  {
    id: 'kapa',
    title: 'KAPA / Incident Training Test',
    description: 'Focused reinforcement tests for CAPA and incident management SOPs.',
    icon: AlertTriangle,
    gradient: 'from-red-500 to-rose-500',
    lightColor: 'text-red-300',
    hoverBorder: 'hover:border-red-400/50',
    hoverShadow: 'hover:shadow-red-500/20',
    path: '/test/kapa',
  },
  {
    id: 'specific',
    title: 'Specific Training Test',
    description: 'Targeted assessments for individual SOP documents with instant feedback.',
    icon: Zap,
    gradient: 'from-yellow-500 to-orange-500',
    lightColor: 'text-yellow-300',
    hoverBorder: 'hover:border-yellow-400/50',
    hoverShadow: 'hover:shadow-yellow-500/20',
    path: '/test/specific',
  },
];

export default function TestHubPage() {
  useAuthGuard();
  const router = useRouter();

  return (
    <div className="min-h-screen bg-slate-900 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <button
            onClick={() => router.push('/dashboard')}
            className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
            Back to Home
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/test/practice')}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/10 border border-white/20 text-slate-300 hover:bg-white/20 transition-all text-sm"
            >
              <FlaskConical className="w-4 h-4" />
              Practice Mode
            </button>
          </div>
        </div>

        {/* Title */}
        <div className="text-center mb-10">
          <h1 className="text-4xl font-bold text-white mb-3">Test Center</h1>
          <p className="text-slate-400 text-lg max-w-2xl mx-auto">
            Standardized SOP assessments to verify knowledge and maintain compliance across all
            pharmaceutical operations.
          </p>
        </div>

        {/* Test type grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 mb-10">
          {testTypes.map((type) => {
            const Icon = type.icon;
            return (
              <button
                key={type.id}
                onClick={() => router.push(type.path)}
                className={`group relative bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-6 text-left hover:bg-white/15 ${type.hoverBorder} transition-all duration-300 hover:scale-[1.02] hover:shadow-2xl ${type.hoverShadow}`}
              >
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className={`w-12 h-12 rounded-2xl bg-linear-to-br ${type.gradient} flex items-center justify-center shadow-lg`}
                  >
                    <Icon className="w-6 h-6 text-white" />
                  </div>
                  <h2 className="text-lg font-bold text-white leading-tight">{type.title}</h2>
                </div>
                <p className="text-slate-400 text-sm leading-relaxed mb-4">{type.description}</p>
                <div
                  className={`flex items-center gap-1 text-sm font-semibold ${type.lightColor} group-hover:gap-2 transition-all`}
                >
                  Start Test
                  <ChevronRight className="w-4 h-4" />
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer banner */}
        <div className="bg-white/5 border border-white/10 rounded-2xl p-5 flex flex-col md:flex-row items-center gap-4">
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"
                  style={{ animationDelay: `${i * 0.3}s` }}
                />
              ))}
            </div>
            <span className="text-slate-300 font-semibold text-sm">Standardized Assessments</span>
          </div>
          <p className="text-slate-500 text-sm md:ml-4">
            All tests use validated question banks. Passing score is <strong className="text-white">70%</strong>.
            Results are recorded for compliance tracking.
          </p>
        </div>
      </div>
    </div>
  );
}
