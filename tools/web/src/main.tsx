import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import Panel from './Panel';
import Trading from './Trading';
import './tokens.css';
import './app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
      <Routes>
        <Route path="/" element={<Trading />} />
        <Route path="/backoffice" element={<Panel />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
