import './theme/fonts.ts';
import './theme/tokens.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter } from 'react-router';
import { App, routes } from './App.tsx';
import { createQueryClient } from './api/queryClient.ts';

const root = document.getElementById('root');
if (!root) throw new Error('index.html has no #root element.');

// Made once, out here: StrictMode renders components twice, and a second router would also
// listen for the browser's back button.
const router = createBrowserRouter(routes);
const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    <App router={router} queryClient={queryClient} />
  </StrictMode>,
);
