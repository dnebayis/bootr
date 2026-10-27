import type { Metadata } from 'next';
import { AnalyticsView } from '@/components/analytics/AnalyticsView';

export const metadata: Metadata = { title: 'Analytics', description: 'Volume, fees, launches and agents across Bootr.' };

export default function AnalyticsPage() {
  return <AnalyticsView />;
}
