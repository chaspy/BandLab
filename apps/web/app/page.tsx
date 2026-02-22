"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "../lib/api";
import { supabase } from "../lib/supabase";

type Band = { id: string; name: string; invite_code: string; role: string };
type Song = {
  id: string;
  title: string;
  bpm: number | null;
  musical_key: string | null;
  time_signature: string | null;
  description: string | null;
  lyrics: string | null;
};

const CURRENT_BAND_KEY = "bandlab.currentBandId";

export default function HomePage() {
  const router = useRouter();
  const [email, setEmail] = useState("demo1@example.com");
  const [password, setPassword] = useState("password123");
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [sessionReady, setSessionReady] = useState(false);
  const [bands, setBands] = useState<Band[]>([]);
  const [currentBandId, setCurrentBandId] = useState<string>("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [newBandName, setNewBandName] = useState("My Band");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    if (!currentBandId) return;
    localStorage.setItem(CURRENT_BAND_KEY, currentBandId);
    loadSongs(currentBandId);
  }, [currentBandId]);

  async function bootstrap() {
    setLoading(true);
    const session = await supabase.auth.getSession();
    if (!session.data.session) {
      setSessionReady(false);
      setLoading(false);
      return;
    }

    setSessionReady(true);
    await loadMe();
    setLoading(false);
  }

  async function loadMe() {
    try {
      const me = await apiFetch<{ user: { id: string }; bands: Band[] }>("/api/me");
      setBands(me.bands);
      const stored = localStorage.getItem(CURRENT_BAND_KEY);
      const preferred = me.bands.find((b) => b.id === stored)?.id ?? me.bands[0]?.id ?? "";
      setCurrentBandId(preferred);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function loadSongs(bandId: string) {
    try {
      const res = await apiFetch<{ songs: Song[] }>("/api/songs", { bandId });
      setSongs(res.songs);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleLogin(e: FormEvent) {
    e.preventDefault();
    setError("");
    const res =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (res.error) {
      setError(res.error.message);
      return;
    }

    setSessionReady(true);
    await loadMe();
  }

  async function createBand(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await apiFetch<{ band: Band; invite_code: string }>("/api/bands", {
        method: "POST",
        body: JSON.stringify({ name: newBandName })
      });
      setInviteCode(res.invite_code);
      await loadMe();
      setCurrentBandId(res.band.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function joinBand(e: FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const res = await apiFetch<{ band: Band }>("/api/bands/join", {
        method: "POST",
        body: JSON.stringify({ invite_code: inviteCode })
      });
      await loadMe();
      setCurrentBandId(res.band.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function createSong(title?: string) {
    if (!currentBandId) return;
    setError("");
    const nextTitle = (title ?? "New Song").trim();
    if (!nextTitle) return;

    try {
      await apiFetch<{ song: Song }>("/api/songs", {
        method: "POST",
        bandId: currentBandId,
        body: JSON.stringify({ title: nextTitle })
      });
      await loadSongs(currentBandId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function logout() {
    await supabase.auth.signOut();
    setSessionReady(false);
    setBands([]);
    setSongs([]);
  }

  if (loading) {
    return <main>Loading...</main>;
  }

  if (!sessionReady) {
    return (
      <main className="grid" style={{ maxWidth: 480 }}>
        <h1>BandLab MVP</h1>
        <div className="card col">
          <h2>Login</h2>
          <form className="col" onSubmit={handleLogin}>
            <label className="col">
              Email
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="col">
              Password
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <div className="row">
              <button type="submit" className="primary">
                {mode === "login" ? "Login" : "Sign up"}
              </button>
              <button type="button" onClick={() => setMode(mode === "login" ? "signup" : "login")}>{
                mode === "login" ? "Create account" : "Go login"
              }</button>
            </div>
          </form>
          {error && <small style={{ color: "#ff8080" }}>{error}</small>}
        </div>
      </main>
    );
  }

  return (
    <main className="grid">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1>BandLab MVP</h1>
        <button onClick={logout}>Logout</button>
      </div>

      {bands.length === 0 ? (
        <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <div className="card col">
            <h2>Create Band</h2>
            <form className="col" onSubmit={createBand}>
              <input value={newBandName} onChange={(e) => setNewBandName(e.target.value)} />
              <button className="primary" type="submit">Create</button>
            </form>
          </div>

          <div className="card col">
            <h2>Join Band</h2>
            <form className="col" onSubmit={joinBand}>
              <input
                placeholder="invite code"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              />
              <button type="submit">Join</button>
            </form>
          </div>
        </div>
      ) : (
        <>
          <div className="card col">
            <h2>Band</h2>
            <div className="row">
              <select value={currentBandId} onChange={(e) => setCurrentBandId(e.target.value)}>
                {bands.map((band) => (
                  <option key={band.id} value={band.id}>
                    {band.name}
                  </option>
                ))}
              </select>
              <code>{bands.find((x) => x.id === currentBandId)?.invite_code}</code>
            </div>
            <small>invite_code を共有して他メンバーを追加</small>
          </div>

          <div className="card col">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2>Songs</h2>
              <button
                onClick={async () => {
                  const title = window.prompt("New Song title", "New Song");
                  if (title === null) return;
                  await createSong(title);
                }}
              >
                New
              </button>
            </div>
            <div className="col">
              {songs.map((song) => (
                <div
                  key={song.id}
                  className="card row"
                  style={{
                    justifyContent: "space-between",
                    padding: 14,
                    borderColor: "#42506a",
                    background: "linear-gradient(180deg, #232f44 0%, #1b2434 100%)"
                  }}
                >
                  <div className="col" style={{ gap: 4 }}>
                    <strong style={{ fontSize: 18, lineHeight: 1.2 }}>{song.title}</strong>
                    <small> BPM: {song.bpm ?? "-"} | Key: {song.musical_key ?? "-"}</small>
                  </div>
                  <button onClick={() => router.push(`/songs/${song.id}?bandId=${currentBandId}`)}>Open</button>
                </div>
              ))}
              {songs.length === 0 && <small>曲がまだありません</small>}
            </div>
          </div>
        </>
      )}

      {error && <small style={{ color: "#ff8080" }}>{error}</small>}
    </main>
  );
}
