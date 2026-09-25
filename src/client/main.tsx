import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './auth';
import { GamePage } from './pages/GamePage';
import { GoogleComplete } from './pages/GoogleComplete';
import { JoinPage } from './pages/JoinPage';
import { Lobby } from './pages/Lobby';
import { MatchesPage } from './pages/MatchesPage';
import './styles.css';

function NotFound() {
  return (
    <main className="page narrow">
      <h1>Page not found</h1>
      <a href="/">Back to your games</a>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/" element={<RequireAuth><Lobby /></RequireAuth>} />
          <Route path="/matches" element={<RequireAuth><MatchesPage /></RequireAuth>} />
          <Route path="/game/:id" element={<RequireAuth><GamePage /></RequireAuth>} />
          <Route path="/join/:code" element={<RequireAuth><JoinPage /></RequireAuth>} />
          <Route path="/auth/complete" element={<GoogleComplete />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
