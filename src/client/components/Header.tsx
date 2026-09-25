import { FormEvent, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

export function Header() {
  const { me, logout, refresh } = useAuth();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api.rename(name.trim());
      await refresh();
      setEditing(false);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Backgammon
      </Link>
      {me && (
        <nav className="nav">
          <NavLink to="/" end>
            Your games
          </NavLink>
          <NavLink to="/matches">Matches</NavLink>
        </nav>
      )}
      {me && (
        <div className="account">
          {editing ? (
            <form onSubmit={save} className="inline-form small">
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="New username" autoFocus />
              <button className="button" type="submit">Save</button>
              <button className="button ghost" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              {error && <span className="error small">{error}</span>}
            </form>
          ) : (
            <button
              className="link username"
              title="Change username"
              onClick={() => {
                setName(me.user.username);
                setEditing(true);
              }}
            >
              {me.user.username}
            </button>
          )}
          <button className="button ghost" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
