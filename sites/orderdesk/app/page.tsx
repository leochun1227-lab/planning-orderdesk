import { requireUser } from '@/lib/auth';
import Dashboard from '@/components/order-dashboard';
export const dynamic='force-dynamic';
export default async function Home(){await requireUser('/');return <Dashboard/>;}
