import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './globals.css';
import Dashboard from '@/components/order-dashboard';

// Session expiry: any 401 from the API sends the user back to the sign-in page.
const nativeFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  const url = String(args[0] instanceof Request ? args[0].url : args[0]);
  if (response.status === 401 && url.startsWith('/api/')) window.location.href = '/login?return_to=' + encodeURIComponent(location.pathname);
  return response;
};

createRoot(document.getElementById('root')!).render(<StrictMode><Dashboard /></StrictMode>);
